import com.nautilus.discordlink.LinkBridgeApi;
import com.nautilus.discordlink.LinkJson;
import com.nautilus.discordlink.LinkScope;
import com.nautilus.discordlink.LinkService;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Bot–köprü–plugin entegrasyon harness'ı (Paper olmadan).
 *
 * Gerçek LinkService + SQLite (JAR sınıfları) ile bota HMAC imzalı uzun-yoklama
 * yapar, işleri LinkBridgeApi'de (BridgePoller ile aynı hedef kontrolüyle)
 * çalıştırır ve imzalı sonucu geri yollar. stdin'den JSON komut satırı alır,
 * stdout'a JSON olay satırı yazar. Yalnız test içindir.
 *
 * Kullanım: LinkBridgeHarness <botUrl> <secret> <instanceId>
 */
public final class LinkBridgeHarness {
    private final String botUrl;
    private final String secret;
    private final String instanceId;
    private final LinkTestEnv env;
    private final LinkService links;
    private final LinkBridgeApi api;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private volatile boolean running = true;
    private volatile String dropResultForPath;
    private volatile String delayPath;
    private volatile long delayMs;

    private LinkBridgeHarness(String botUrl, String secret, String instanceId) throws Exception {
        this.botUrl = botUrl.replaceAll("/+$", "");
        this.secret = secret;
        this.instanceId = instanceId;
        this.env = new LinkTestEnv("harness-" + instanceId.replaceAll("[^A-Za-z0-9-]", "-"));
        this.links = this.env.service();
        this.api = new LinkBridgeApi(this.links, instanceId, Logger.getLogger("harness"));
    }

    public static void main(String[] args) throws Exception {
        Logger.getLogger("").setLevel(Level.SEVERE);
        LinkBridgeHarness harness = new LinkBridgeHarness(args[0], args[1], args[2]);
        Thread poller = new Thread(harness::pollLoop, "harness-poller");
        poller.setDaemon(true);
        poller.start();
        harness.commandLoop();
    }

    private void pollLoop() {
        boolean announced = false;
        while (this.running) {
            try {
                HttpRequest request = signed(HttpRequest.newBuilder(
                        URI.create(this.botUrl + "/api/bridge/jobs?wait=1000")), "")
                        .timeout(Duration.ofSeconds(10)).GET().build();
                HttpResponse<String> response = this.http.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() != 200) {
                    emit("poll_error", Map.of("status", response.statusCode()));
                    Thread.sleep(200);
                    continue;
                }
                if (!announced) {
                    announced = true;
                    emit("ready", Map.of("instance", this.instanceId, "scope", LinkScope.of(this.instanceId)));
                }
                Object jobs = LinkJson.parseObject(response.body()).get("jobs");
                if (jobs instanceof List<?> list) {
                    for (Object job : list) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> map = (Map<String, Object>) job;
                        this.workers.submit(() -> handle(map));
                    }
                }
            } catch (InterruptedException interrupted) {
                return;
            } catch (Exception error) {
                emit("poll_error", Map.of("message", String.valueOf(error.getMessage())));
                sleep(200);
            }
        }
    }

    private void handle(Map<String, Object> job) {
        try {
            String jobId = (String) job.get("jobId");
            String method = job.get("method") instanceof String m ? m : "GET";
            String path = job.get("path") instanceof String p ? p : "/";
            String target = job.get("targetInstance") instanceof String t ? t : null;
            String pathOnly = path.split("\\?")[0];
            int status;
            String json;
            if (target != null && !target.isBlank() && !target.equals(this.instanceId)) {
                status = 421;
                json = LinkJson.write(Map.of("error", "wrong_instance", "instance", this.instanceId));
            } else if (LinkBridgeApi.handles(method, path)) {
                if (pathOnly.equals(this.delayPath) && this.delayMs > 0) {
                    long wait = this.delayMs;
                    this.delayMs = 0;
                    this.delayPath = null;
                    sleep(wait);
                }
                Object body = job.get("body");
                LinkBridgeApi.Response response = this.api.handle(method, path, body == null ? "" : LinkJson.write(body));
                status = response.status();
                json = response.json();
            } else {
                status = 404;
                json = LinkJson.write(Map.of("error", "not_found", "instance", this.instanceId));
            }
            Map<String, Object> handled = new LinkedHashMap<>();
            handled.put("path", pathOnly);
            handled.put("method", method);
            handled.put("status", status);
            handled.put("target", target);
            emit("handled", handled);
            if (pathOnly.equals(this.dropResultForPath)) {
                this.dropResultForPath = null;
                emit("dropped", Map.of("path", pathOnly));
                return;
            }
            String result = "{\"jobId\":" + LinkJson.write(jobId) + ",\"status\":" + status + ",\"data\":" + json + "}";
            HttpRequest request = signed(HttpRequest.newBuilder(URI.create(this.botUrl + "/api/bridge/jobs/result")), result)
                    .header("Content-Type", "application/json")
                    .timeout(Duration.ofSeconds(10))
                    .POST(HttpRequest.BodyPublishers.ofString(result))
                    .build();
            this.http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception error) {
            emit("job_error", Map.of("message", String.valueOf(error)));
        }
    }

    private void commandLoop() throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isBlank()) continue;
            Map<String, Object> command = LinkJson.parseObject(line);
            String cmd = String.valueOf(command.get("cmd"));
            try {
                switch (cmd) {
                    case "issue" -> {
                        UUID uuid = UUID.fromString((String) command.get("uuid"));
                        String name = (String) command.get("name");
                        Object part = command.get("part");
                        boolean scoped = !Boolean.FALSE.equals(command.get("scoped"));
                        if (part instanceof String forced) this.links.setCodeSource(() -> forced);
                        try {
                            String code = scoped
                                    ? this.links.issueCode(uuid, name, this.instanceId).code()
                                    : this.links.issueCode(uuid, name).code();
                            emit("issued", Map.of("uuid", uuid.toString(), "code", code));
                        } finally {
                            this.links.setCodeSource(null);
                        }
                    }
                    case "player" -> {
                        this.env.player(UUID.fromString((String) command.get("uuid")), (String) command.get("name"));
                        emit("player", Map.of("uuid", command.get("uuid")));
                    }
                    case "state" -> {
                        Map<String, Object> state = new LinkedHashMap<>();
                        state.put("linked", false);
                        if (command.get("uuid") instanceof String raw) {
                            this.links.recordByUuid(UUID.fromString(raw)).ifPresent(link -> {
                                state.put("linked", true);
                                state.put("uuid", link.uuid().toString());
                                state.put("discordId", link.discordId());
                                state.put("linkId", link.linkId());
                            });
                        }
                        emit("state", state);
                    }
                    case "fault" -> {
                        if (command.get("dropResultFor") instanceof String path) this.dropResultForPath = path;
                        if (command.get("delayPath") instanceof String path) this.delayPath = path;
                        if (command.get("delayMs") instanceof Number number) this.delayMs = number.longValue();
                        emit("fault", Map.of("ok", true));
                    }
                    case "quit" -> {
                        this.running = false;
                        this.workers.shutdownNow();
                        this.env.close();
                        emit("bye", Map.of("instance", this.instanceId));
                        System.exit(0);
                    }
                    default -> emit("error", Map.of("message", "bilinmeyen komut " + cmd));
                }
            } catch (Exception error) {
                emit("error", Map.of("cmd", cmd, "message", String.valueOf(error)));
            }
        }
    }

    private HttpRequest.Builder signed(HttpRequest.Builder builder, String body) throws Exception {
        long timestamp = System.currentTimeMillis();
        String nonce = UUID.randomUUID().toString();
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(this.secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = HexFormat.of().formatHex(
                mac.doFinal((timestamp + "." + nonce + "." + body).getBytes(StandardCharsets.UTF_8)));
        return builder.header("X-Nautilus-Timestamp", Long.toString(timestamp))
                .header("X-Nautilus-Nonce", nonce)
                .header("X-Nautilus-Signature", signature)
                .header("X-Bridge-Instance", this.instanceId)
                .header("X-Bridge-Link-Protocol", Integer.toString(LinkBridgeApi.PROTOCOL_VERSION));
    }

    private static synchronized void emit(String event, Map<String, ?> fields) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("event", event);
        out.putAll(fields);
        System.out.println(LinkJson.write(out));
        System.out.flush();
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
