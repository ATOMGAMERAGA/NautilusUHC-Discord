package com.nautilus.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.nautilus.discordlink.LinkBridgeApi;
import com.nautilus.discordlink.LinkScope;
import com.nautilus.discordlink.LinkService;
import com.nautilus.util.TimeService;
import org.bukkit.plugin.Plugin;

import javax.net.ssl.SSLException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * Ters köprü: plugin bota dışa bağlanıp uzun-yoklamayla iş çeker.
 *
 * 1.2.2 değişiklikleri (1.2.1 davranışının geri kalanı korunur):
 *  - Yoklamalar X-Bridge-Link-Protocol başlığıyla hesap bağlama protokolünü bildirir.
 *  - Başka bir instance'a hedeflenmiş iş çalıştırılmaz (421 wrong_instance).
 *  - Hesap bağlama işleri yerel HTTP yerine doğrudan LinkBridgeApi'de işlenir;
 *    böylece belirsiz isim, depo hatası ve instance kimliği yanıtta kesin taşınır.
 */
public final class BridgePoller {
    private static final long POLL_WAIT_MS = 25000L;
    private static final Duration POLL_TIMEOUT = Duration.ofSeconds(40L);
    private static final Duration LOCAL_TIMEOUT = Duration.ofSeconds(7L);
    private static final long[] BACKOFF_MS = new long[]{1000L, 2000L, 5000L, 10000L, 30000L};
    private final Plugin plugin;
    private final HttpClient http;
    private volatile boolean running;
    private Thread thread;
    private ExecutorService workers;
    private int failures;
    private boolean lostLogged;

    public BridgePoller(Plugin plugin) {
        this.plugin = plugin;
        this.http = BridgeClient.buildHttpClient(plugin);
    }

    public void start() {
        if (this.running) {
            return;
        }
        if (!"outbound".equalsIgnoreCase(this.mode())) {
            return;
        }
        if (this.botUrl().isBlank() || this.secret().isBlank()) {
            this.plugin.getLogger().warning("Ters köprü kapalı: bridge.bot-url ve bridge.token dolu olmalı. "
                    + "Discord komutları Minecraft verisine ulaşamayacak.");
            return;
        }
        if (!this.plugin.getConfig().getBoolean("bridge.enabled", false)) {
            this.plugin.getLogger().warning("Ters köprü kapalı: bridge.enabled false. Yerel köprü sunucusu "
                    + "olmadan botun sorularını yanıtlayamayız.");
            return;
        }
        this.running = true;
        this.workers = Executors.newFixedThreadPool(3, runnable -> {
            Thread worker = new Thread(runnable, "NautilusUHC-BridgeJob");
            worker.setDaemon(true);
            return worker;
        });
        this.thread = new Thread(this::loop, "NautilusUHC-BridgePoller");
        this.thread.setDaemon(true);
        this.thread.start();
        String instance = BridgeInstance.id(this.plugin);
        this.plugin.getLogger().info("Ters köprü etkin: " + this.botUrl() + " adresine dışa bağlanılıyor "
                + "(panelde ek port GEREKMEZ). Köprü kimliği: " + instance + " (bağlantı kodu kapsamı "
                + LinkScope.of(instance) + ", hesap bağlama protokolü " + LinkBridgeApi.PROTOCOL_VERSION
                + "). Aynı bota birden fazla sunucu bağlanacaksa her birine farklı bridge.instance-id ver.");
    }

    public void stop() {
        this.running = false;
        if (this.thread != null) {
            this.thread.interrupt();
            this.thread = null;
        }
        if (this.workers != null) {
            this.workers.shutdownNow();
            try {
                this.workers.awaitTermination(2L, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            this.workers = null;
        }
    }

    public boolean running() {
        return this.running;
    }

    private void loop() {
        while (this.running) {
            try {
                for (JsonElement element : this.pollJobs()) {
                    if (!element.isJsonObject()) continue;
                    JsonObject job = element.getAsJsonObject();
                    try {
                        this.workers.submit(() -> this.handle(job));
                    } catch (RejectedExecutionException rejected) {
                        return;
                    }
                }
                if (this.failures > 0) {
                    this.plugin.getLogger().info("Ters köprü bağlantısı geri geldi.");
                }
                this.failures = 0;
                this.lostLogged = false;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception error) {
                if (!this.running) {
                    return;
                }
                long delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
                ++this.failures;
                if (!this.lostLogged) {
                    this.lostLogged = true;
                    this.plugin.getLogger().warning("Ters köprü bota ulaşamıyor (" + error.getMessage()
                            + "). Yeniden denenecek." + BridgePoller.tlsHint(error));
                }
                try {
                    Thread.sleep(delay);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private JsonArray pollJobs() throws Exception {
        String url = this.botUrl() + "/api/bridge/jobs?wait=" + POLL_WAIT_MS;
        HttpRequest request = this.signed(HttpRequest.newBuilder(URI.create(url)), "")
                .timeout(POLL_TIMEOUT).GET().build();
        HttpResponse<String> response = this.http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 401 || response.statusCode() == 403) {
            throw new IllegalStateException("bot isteği reddetti (" + response.statusCode() + "). bridge.token ile "
                    + "botun BRIDGE_SECRET değeri aynı mı? Sunucu saati çok kaymışsa da imza reddedilir.");
        }
        if (response.statusCode() == 404) {
            throw new IllegalStateException("bot ters köprüyü bilmiyor (404). Dokploy'daki bot sürümünü güncelle.");
        }
        if (response.statusCode() != 200) {
            throw new IllegalStateException("yoklama yanıtı " + response.statusCode());
        }
        JsonObject body = JsonParser.parseString(response.body()).getAsJsonObject();
        return body.has("jobs") && body.get("jobs").isJsonArray() ? body.getAsJsonArray("jobs") : new JsonArray();
    }

    private void handle(JsonObject job) {
        String jobId = string(job, "jobId");
        if (jobId == null) {
            return;
        }
        String method = string(job, "method");
        if (method == null) method = "GET";
        String path = string(job, "path");
        if (path == null) path = "/";
        JsonElement body = job.has("body") && !job.get("body").isJsonNull() ? job.get("body") : null;
        String target = string(job, "targetInstance");
        String self = BridgeInstance.id(this.plugin);

        int status;
        JsonElement responseBody;
        try {
            if (target != null && !target.isBlank() && !target.equals(self)) {
                // Kuyruk bu işi başka bir sunucu için ayırmış: yan etkiye izin verme.
                this.plugin.getLogger().warning("Ters köprü işi başka instance için geldi (hedef=" + target
                        + ", bu=" + self + ", yol=" + pathOnly(path) + ", iş=" + jobId + "); çalıştırılmadı.");
                status = 421;
                responseBody = errorBody("wrong_instance", self);
            } else if (FeatureBridge.handles(method, path)) {
                FeatureBridge.Response response = FeatureBridge.handle(method, path, body);
                status = response.status();
                responseBody = response.body();
            } else if (LinkBridgeApi.handles(method, path)) {
                LocalResponse response = this.handleLink(method, path, body, self);
                status = response.status;
                responseBody = response.body;
            } else {
                LocalResponse response = this.callLocal(method, path, body);
                status = response.status;
                responseBody = response.body;
            }
        } catch (Exception error) {
            this.plugin.getLogger().warning("Ters köprü işi çalıştırılamadı (" + pathOnly(path) + "): "
                    + error.getMessage());
            status = 502;
            responseBody = errorBody("local_bridge_unreachable", self);
        }
        try {
            this.reportResult(jobId, status, responseBody);
        } catch (Exception error) {
            this.plugin.getLogger().warning("Ters köprü sonucu iletilemedi (iş=" + jobId + ", yol="
                    + pathOnly(path) + "): " + error.getMessage());
        }
    }

    private LocalResponse handleLink(String method, String path, JsonElement body, String self) {
        LinkService service = LinkService.primary();
        if (service == null) {
            return new LocalResponse(503, errorBody("store_unavailable", self));
        }
        // BridgeHttpServer ile aynı eşik: kısa token ile köprü API'si açılmaz.
        if (this.secret().length() < 32) {
            return new LocalResponse(503, errorBody("bridge_token_too_short", self));
        }
        LinkBridgeApi.Response response = new LinkBridgeApi(service, self, this.plugin.getLogger())
                .handle(method, path, body == null ? "" : body.toString());
        return new LocalResponse(response.status(), JsonParser.parseString(response.json()));
    }

    private LocalResponse callLocal(String method, String path, JsonElement body) throws Exception {
        int port = this.plugin.getConfig().getInt("bridge.port", 25000);
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Authorization", "Bearer " + this.secret())
                .header("Content-Type", "application/json")
                .timeout(LOCAL_TIMEOUT);
        String payload = body == null ? "" : body.toString();
        switch (method.toUpperCase(Locale.ROOT)) {
            case "POST" -> builder.POST(HttpRequest.BodyPublishers.ofString(payload));
            case "DELETE" -> builder.method("DELETE", HttpRequest.BodyPublishers.ofString(payload));
            case "PUT" -> builder.PUT(HttpRequest.BodyPublishers.ofString(payload));
            default -> builder.GET();
        }
        HttpResponse<String> response = this.http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        JsonElement parsed;
        try {
            String text = response.body();
            parsed = text == null || text.isBlank() ? new JsonObject() : JsonParser.parseString(text);
        } catch (Exception invalid) {
            parsed = new JsonObject();
        }
        return new LocalResponse(response.statusCode(), parsed);
    }

    private void reportResult(String jobId, int status, JsonElement body) throws Exception {
        JsonObject result = new JsonObject();
        result.addProperty("jobId", jobId);
        result.addProperty("status", (Number) status);
        result.add("data", body);
        String json = result.toString();
        HttpRequest request = this.signed(HttpRequest.newBuilder(URI.create(this.botUrl() + "/api/bridge/jobs/result")), json)
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(10L))
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
        this.http.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private HttpRequest.Builder signed(HttpRequest.Builder builder, String body) {
        long timestamp = TimeService.currentMillis();
        String nonce = UUID.randomUUID().toString();
        builder.header("X-Nautilus-Timestamp", Long.toString(timestamp))
                .header("X-Nautilus-Nonce", nonce)
                .header("X-Nautilus-Signature", BridgeSignature.sign(this.secret(), timestamp, nonce, body))
                .header("X-Bridge-Instance", BridgeInstance.id(this.plugin))
                .header("X-Bridge-Link-Protocol", Integer.toString(LinkBridgeApi.PROTOCOL_VERSION));
        if (this.plugin.getConfig().getBoolean("bridge.legacy-secret-header", true)) {
            builder.header("X-Bridge-Secret", this.secret());
        }
        return builder;
    }

    private static JsonObject errorBody(String code, String instance) {
        JsonObject error = new JsonObject();
        error.addProperty("error", code);
        error.addProperty("instance", instance);
        return error;
    }

    private static String string(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : null;
    }

    private static String pathOnly(String path) {
        int query = path.indexOf('?');
        return query < 0 ? path : path.substring(0, query);
    }

    private String mode() {
        return this.plugin.getConfig().getString("bridge.mode", "outbound");
    }

    private String botUrl() {
        return this.plugin.getConfig().getString("bridge.bot-url", "").replaceAll("/+$", "");
    }

    private String secret() {
        return this.plugin.getConfig().getString("bridge.token", "");
    }

    private static String tlsHint(Exception error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String message = String.valueOf(current.getMessage());
            if (!(current instanceof SSLException) && !message.contains("PKIX") && !message.contains("certificate")) {
                continue;
            }
            return " | bot-url TLS sertifikası doğrulanamadı: bot domainine geçerli (Let's Encrypt) sertifika "
                    + "bağla ya da bridge.ca-cert ile PEM tanıt.";
        }
        return "";
    }

    private record LocalResponse(int status, JsonElement body) {
    }
}
