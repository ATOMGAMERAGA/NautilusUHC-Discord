/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  com.google.gson.Gson
 *  com.google.gson.JsonArray
 *  com.google.gson.JsonElement
 *  com.google.gson.JsonObject
 *  org.bukkit.plugin.Plugin
 */
package com.nautilus.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.nautilus.NautilusUHC;
import com.nautilus.admin.AdminBootstrap;
import com.nautilus.bridge.BridgeSignature;
import com.nautilus.util.TimeService;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import org.bukkit.plugin.Plugin;

public final class BridgeClient {
    private static final Gson GSON = new Gson();
    private final Plugin plugin;
    private final HttpClient http;
    private static final long[] RETRY_DELAYS_MS = new long[]{0L, 2000L, 8000L};

    public BridgeClient(Plugin plugin) {
        this.plugin = plugin;
        this.http = BridgeClient.buildHttpClient(plugin);
    }

    static HttpClient buildHttpClient(Plugin plugin) {
        HttpClient.Builder builder = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5L));
        String caPath = plugin.getConfig().getString("bridge.ca-cert", "");
        if (caPath != null && !caPath.isBlank()) {
            try {
                builder.sslContext(BridgeClient.sslContextWithExtraCa(Path.of(caPath.trim(), new String[0])));
                plugin.getLogger().info("K\u00f6pr\u00fc TLS: bridge.ca-cert sertifikas\u0131 y\u00fcklendi (" + caPath + ").");
            }
            catch (Exception e) {
                plugin.getLogger().severe("K\u00f6pr\u00fc TLS: bridge.ca-cert okunamad\u0131 (" + caPath + "): " + e.getMessage() + " \u2014 yaln\u0131z sistem CA deposu kullan\u0131lacak.");
            }
        }
        return builder.build();
    }

    private static SSLContext sslContextWithExtraCa(Path pem) throws Exception {
        Collection<? extends Certificate> certs;
        CertificateFactory certFactory = CertificateFactory.getInstance("X.509");
        try (InputStream in = Files.newInputStream(pem, new OpenOption[0]);){
            certs = certFactory.generateCertificates(in);
        }
        if (certs.isEmpty()) {
            throw new IllegalArgumentException("PEM dosyas\u0131nda sertifika bulunamad\u0131");
        }
        KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
        keyStore.load(null, null);
        int index = 0;
        for (Certificate certificate : certs) {
            keyStore.setCertificateEntry("bridge-ca-" + index++, certificate);
        }
        String algorithm = TrustManagerFactory.getDefaultAlgorithm();
        TrustManagerFactory trustManagerFactory = TrustManagerFactory.getInstance(algorithm);
        trustManagerFactory.init(keyStore);
        TrustManagerFactory defaultFactory = TrustManagerFactory.getInstance(algorithm);
        defaultFactory.init((KeyStore)null);
        final X509TrustManager defaultTm = BridgeClient.firstX509(defaultFactory);
        final X509TrustManager extraTm = BridgeClient.firstX509(trustManagerFactory);
        X509TrustManager combined = new X509TrustManager(){

            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    defaultTm.checkClientTrusted(chain, authType);
                }
                catch (CertificateException e) {
                    extraTm.checkClientTrusted(chain, authType);
                }
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    defaultTm.checkServerTrusted(chain, authType);
                }
                catch (CertificateException e) {
                    extraTm.checkServerTrusted(chain, authType);
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                X509Certificate[] first = defaultTm.getAcceptedIssuers();
                X509Certificate[] second = extraTm.getAcceptedIssuers();
                X509Certificate[] all = Arrays.copyOf(first, first.length + second.length);
                System.arraycopy(second, 0, all, first.length, second.length);
                return all;
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{combined}, null);
        return context;
    }

    private static X509TrustManager firstX509(TrustManagerFactory factory) {
        for (TrustManager tm : factory.getTrustManagers()) {
            if (!(tm instanceof X509TrustManager)) continue;
            X509TrustManager x509 = (X509TrustManager)tm;
            return x509;
        }
        throw new IllegalStateException("X509TrustManager bulunamad\u0131");
    }

    public boolean enabled() {
        return !this.botUrl().isBlank() && !this.secret().isBlank();
    }

    private int currentTeamLimit() {
        NautilusUHC instance = NautilusUHC.getInstance();
        if (instance != null && instance.getTeams() != null) {
            return Math.max(1, instance.getTeams().getLimit());
        }
        return Math.max(1, this.plugin.getConfig().getInt("uhc.teamSize", 4));
    }

    private String botUrl() {
        return this.plugin.getConfig().getString("bridge.bot-url", "").replaceAll("/+$", "");
    }

    private String secret() {
        return this.plugin.getConfig().getString("bridge.token", "");
    }

    public void matchScheduled(String slot, long startsAtMillis, String host, Collection<String> scenarios, boolean test) {
        JsonObject data = new JsonObject();
        data.addProperty("slot", slot);
        data.addProperty("startsAt", (Number)startsAtMillis);
        data.addProperty("host", host);
        data.add("scenarios", (JsonElement)this.toArray(scenarios));
        data.addProperty("teamSize", (Number)AdminBootstrap.announcementTeamLimit(this.currentTeamLimit()));
        JsonObject settings = new JsonObject();
        settings.addProperty("pvpAt", (Number)((int)(this.plugin.getConfig().getLong("uhc.pvpEnableSeconds", 1200L) / 60L)));
        settings.addProperty("healAt", (Number)((int)(this.plugin.getConfig().getLong("uhc.healSeconds", 600L) / 60L)));
        settings.addProperty("borderSize", (Number)this.plugin.getConfig().getInt("uhc.startingBorder", 3000));
        settings.addProperty("latecomerWindow", (Number)((int)(this.plugin.getConfig().getLong("lateScatter.windowSeconds", 300L) / 60L)));
        data.add("settings", (JsonElement)settings);
        this.send("match_scheduled", test && !AdminBootstrap.isScheduledAnnouncement(), data);
    }

    public void matchStart(String host, int players, Collection<String> scenarios, boolean test) {
        JsonObject data = new JsonObject();
        data.addProperty("host", host);
        data.addProperty("players", (Number)players);
        data.add("scenarios", (JsonElement)this.toArray(scenarios));
        data.addProperty("startedAt", (Number)TimeService.currentMillis());
        if (this.plugin instanceof NautilusUHC p) {
            data.addProperty("plannedAnnouncement",com.nautilus.admin.LaunchAnnouncement.matches(FeatureBridge.matchEpoch(p)));
        }
        this.send("match_start", test, data);
    }

    public void matchEnd(long matchId, String winner, long durationSecs, int participantCount, List<Map.Entry<String, Integer>> topKills, String mvpName, int mvpKills, boolean test) {
        JsonObject data = new JsonObject();
        if (matchId > 0L) {
            data.addProperty("matchId", (Number)matchId);
        }
        data.addProperty("winner", winner);
        data.addProperty("durationSecs", (Number)durationSecs);
        data.addProperty("participantCount", (Number)participantCount);
        data.addProperty("endedAt", (Number)TimeService.currentMillis());
        JsonArray top = new JsonArray();
        for (Map.Entry<String, Integer> e : topKills) {
            JsonObject entry = new JsonObject();
            entry.addProperty("name", e.getKey());
            entry.addProperty("kills", (Number)e.getValue());
            top.add((JsonElement)entry);
        }
        data.add("top", (JsonElement)top);
        if (mvpName != null && !mvpName.isBlank()) {
            data.addProperty("mvpName", mvpName);
            data.addProperty("mvpKills", (Number)mvpKills);
        }
        this.send("match_end", test, data);
    }

    public void hostMessage(String host, String message, boolean test) {
        JsonObject data = new JsonObject();
        data.addProperty("host", host);
        data.addProperty("message", message);
        data.addProperty("sentAt", (Number)TimeService.currentMillis());
        this.send("host_message", test, data);
    }

    public void matchCancelled(String slot, String host, String reason, boolean test) {
        JsonObject data = new JsonObject();
        data.addProperty("slot", slot);
        data.addProperty("host", host);
        data.addProperty("reason", reason);
        this.send("match_cancelled", test, data);
    }

    public void message(String title, String message, boolean test) {
        JsonObject data = new JsonObject();
        data.addProperty("title", title);
        data.addProperty("message", message);
        this.send("message", test, data);
    }

    public void phaseChange(String phase, long elapsedSecs, int aliveCount, Integer borderSize, boolean test) {
        this.send("phase_change", test, BridgeClient.phaseChangeData(phase, elapsedSecs, aliveCount, borderSize));
    }

    static JsonObject phaseChangeData(String phase, long elapsedSecs, int aliveCount, Integer borderSize) {
        JsonObject data = new JsonObject();
        data.addProperty("phase", phase);
        data.addProperty("elapsedSecs", (Number)elapsedSecs);
        data.addProperty("aliveCount", (Number)aliveCount);
        if (borderSize != null) {
            data.addProperty("borderSize", (Number)borderSize);
        }
        return data;
    }

    public void tierChange(String player, String oldTier, String newTier, int elo, boolean promoted) {
        JsonObject data = new JsonObject();
        data.addProperty("player", player);
        data.addProperty("oldTier", oldTier);
        data.addProperty("newTier", newTier);
        data.addProperty("elo", (Number)elo);
        data.addProperty("direction", promoted ? "promote" : "demote");
        this.send("tier_change", false, data);
    }

    public void reportCreated(String reporter, String reported, String reason) {
        JsonObject data = new JsonObject();
        data.addProperty("reporter", reporter);
        data.addProperty("reported", reported);
        data.addProperty("reason", reason);
        this.send("report_created", false, data);
    }

    public void punishment(String action, String player, String staff, String reason, long durationMs, String source) {
        JsonObject data = new JsonObject();
        data.addProperty("action", action);
        data.addProperty("player", player);
        data.addProperty("staff", staff);
        data.addProperty("reason", reason);
        if (durationMs > 0L) {
            data.addProperty("durationMs", (Number)durationMs);
        }
        data.addProperty("source", source);
        this.send("punishment", false, data);
    }

    public void linkRemoved(String mc, String discordId, String source) {
        JsonObject data = new JsonObject();
        data.addProperty("mc", mc);
        data.addProperty("discordId", discordId);
        data.addProperty("source", source);
        this.send("link_removed", false, data);
    }

    private JsonArray toArray(Collection<String> values) {
        JsonArray arr = new JsonArray();
        if (values != null) {
            values.forEach(arg_0 -> ((JsonArray)arr).add(arg_0));
        }
        return arr;
    }

    private void send(String type, boolean test, JsonObject data) {
        if (!this.enabled()) {
            return;
        }
        JsonObject body = new JsonObject();
        body.addProperty("eventId", UUID.randomUUID().toString());
        body.addProperty("schemaVersion", (Number)2);
        body.addProperty("type", type);
        body.addProperty("occurredAt", Instant.ofEpochMilli(TimeService.currentMillis()).atOffset(ZoneOffset.UTC).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME));
        body.addProperty("test", Boolean.valueOf(test));
        if (data.has("matchId")) {
            body.addProperty("matchId", (Number)data.get("matchId").getAsLong());
        }
        body.add("data", (JsonElement)data);
        String json = GSON.toJson((JsonElement)body);
        String url = this.botUrl() + "/api/event";
        boolean legacyHeader = this.plugin.getConfig().getBoolean("bridge.legacy-secret-header", true);
        boolean shutdown = !this.plugin.isEnabled();
        Runnable task = () -> {
            int attempts = shutdown ? 1 : RETRY_DELAYS_MS.length;
            for (int attempt = 0; attempt < attempts; ++attempt) {
                if (!shutdown && RETRY_DELAYS_MS[attempt] > 0L) {
                    try {
                        Thread.sleep(RETRY_DELAYS_MS[attempt]);
                    }
                    catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
                try {
                    HttpResponse<String> res;
                    int code;
                    long ts = TimeService.currentMillis();
                    String nonce = UUID.randomUUID().toString();
                    HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(url)).header("Content-Type", "application/json").header("X-Nautilus-Timestamp", Long.toString(ts)).header("X-Nautilus-Nonce", nonce).header("X-Nautilus-Signature", BridgeSignature.sign(this.secret(), ts, nonce, json)).timeout(Duration.ofSeconds(10L)).POST(HttpRequest.BodyPublishers.ofString(json));
                    if (legacyHeader) {
                        rb.header("X-Bridge-Secret", this.secret());
                    }
                    if ((code = (res = this.http.send(rb.build(), HttpResponse.BodyHandlers.ofString())).statusCode()) < 300) {
                        return;
                    }
                    if (code < 500 && code != 429) {
                        this.plugin.getLogger().warning("K\u00f6pr\u00fc eventi " + type + " reddedildi: " + code);
                        return;
                    }
                    this.plugin.getLogger().warning("K\u00f6pr\u00fc eventi " + type + " deneme " + (attempt + 1) + " \u2192 " + code + (attempt + 1 < RETRY_DELAYS_MS.length ? ", tekrar denenecek" : ", vazge\u00e7ildi"));
                    continue;
                }
                catch (Exception ex) {
                    this.plugin.getLogger().warning("K\u00f6pr\u00fc eventi " + type + " deneme " + (attempt + 1) + " ba\u015far\u0131s\u0131z: " + ex.getMessage() + (attempt == 0 ? BridgeClient.tlsHint(ex) : "") + (attempt + 1 < RETRY_DELAYS_MS.length ? " \u2014 tekrar denenecek" : " \u2014 vazge\u00e7ildi"));
                }
            }
        };
        if (this.plugin.isEnabled()) {
            this.plugin.getServer().getScheduler().runTaskAsynchronously(this.plugin, task);
        } else {
            task.run();
        }
    }

    private static String tlsHint(Exception ex) {
        boolean tls = false;
        for (Throwable t = ex; t != null; t = t.getCause()) {
            String msg = String.valueOf(t.getMessage());
            if (!(t instanceof SSLException) && !msg.contains("PKIX") && !msg.contains("certificate")) continue;
            tls = true;
            break;
        }
        if (!tls) {
            return "";
        }
        return " | bot-url TLS sertifikas\u0131 do\u011frulanamad\u0131. Tipik neden: domain i\u00e7in ge\u00e7erli sertifika yok (Traefik kendi imzal\u0131 varsay\u0131lan sertifikay\u0131 sunuyor) ya da ara zincir eksik. Kal\u0131c\u0131 \u00e7\u00f6z\u00fcm: Dokploy'da bot domainine Let's Encrypt sertifikas\u0131 ba\u011fla; alternatif: sertifika PEM'ini sunucuya koyup config'te bridge.ca-cert ile tan\u0131t.";
    }
}

