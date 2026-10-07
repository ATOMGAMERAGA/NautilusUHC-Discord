import com.nautilus.discordlink.LinkBridgeApi;
import com.nautilus.discordlink.LinkJson;
import com.nautilus.discordlink.LinkService;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Köprü API sözleşmesi (protokol 2 + ters köprüdeki 1.2.1 uyumlu uçlar).
 * Bot tarafı bu JSON alanlarına güvenir; alan adları burada kilitlenir.
 */
public final class LinkBridgeApiTest {
    private static final String X = "18446744073709551615";
    private static final String Y = "222222222222222222";
    private static final String STAFF = "900000000000000001";
    private static final Logger QUIET = Logger.getLogger("LinkBridgeApiTest");
    private static final List<String> FAILURES = new ArrayList<>();

    public static void main(String[] args) {
        Logger.getLogger("").setLevel(Level.SEVERE);
        QUIET.setLevel(Level.OFF);
        scenario("A01 verify yanıtı UUID–Discord çiftini, instance'ı ve requestId'yi taşır", LinkBridgeApiTest::verifyContract);
        scenario("A02 hatalı girdi 400; sayı olarak gelen Discord ID reddedilir", LinkBridgeApiTest::inputValidation);
        scenario("A03 probe salt-okunur sahiplik bildirir", LinkBridgeApiTest::probe);
        scenario("A04 operation zaman aşımı sonrası sonucu uzlaştırır (restart dahil)", LinkBridgeApiTest::operationReconcile);
        scenario("A05 DB arızası 503 store_unavailable, asla invalid_code", LinkBridgeApiTest::storeUnavailable);
        scenario("A06 info UUID/Discord/isim ile; belirsiz isimde 409", LinkBridgeApiTest::info);
        scenario("A07 liste sırası, toplam ve sayfalama", LinkBridgeApiTest::list);
        scenario("A08 geçmiş filtreleri ve nextBeforeId", LinkBridgeApiTest::history);
        scenario("A09 v2 unlink: yetkili zorunlu, idempotent, eski sürüm 409, belirsiz 409", LinkBridgeApiTest::unlink);
        scenario("A10 ters köprüdeki eski uçlar kesin isim çözümlemesi kullanır", LinkBridgeApiTest::legacyEndpoints);
        scenario("A11 yol eşleme ve bilinmeyen uç", LinkBridgeApiTest::routing);

        if (!FAILURES.isEmpty()) {
            System.out.println("FAIL LinkBridgeApiTest (" + FAILURES.size() + " senaryo)");
            FAILURES.forEach(failure -> System.out.println("  - " + failure));
            System.exit(1);
        }
        System.out.println("PASS LinkBridgeApiTest");
    }

    private static void verifyContract() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a01")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            UUID player = UUID.randomUUID();
            String code = links.issueCode(player, "ApiOyuncu", "mc-test").code();
            require(code.startsWith("4S"), "mc-test kapsamı 4S olmalı: " + code);
            Map<String, Object> res = call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\" " + code.toLowerCase() + " \",\"discordId\":\"" + X
                            + "\",\"discordTag\":\"api#0\",\"requestId\":\"rid-1\"}");
            require(status(res) == 200 && "linked".equals(res.get("result")) && Boolean.TRUE.equals(res.get("created"))
                    && Boolean.FALSE.equals(res.get("replay")), "verify: " + res);
            Map<String, Object> link = map(res.get("link"));
            require(player.toString().equals(link.get("uuid")) && X.equals(link.get("discordId"))
                    && link.get("linkId") instanceof String, "link alanları: " + link);
            require("mc-test".equals(res.get("instance")) && "rid-1".equals(res.get("requestId"))
                    && res.get("protocol").toString().equals("2"), "zarf alanları: " + res);

            Map<String, Object> replay = call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\"" + code + "\",\"discordId\":\"" + X + "\",\"requestId\":\"rid-2\"}");
            require(status(replay) == 200 && Boolean.TRUE.equals(replay.get("replay")), "tekrar: " + replay);
            Map<String, Object> stolen = call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\"" + code + "\",\"discordId\":\"" + Y + "\"}");
            require(status(stolen) == 404 && "invalid_code".equals(stolen.get("error")), "başka hesap: " + stolen);

            UUID second = UUID.randomUUID();
            String code2 = links.issueCode(second, "Ikinci", "mc-test").code();
            Map<String, Object> secondLinked = call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\"" + code2 + "\",\"discordId\":\"" + X + "\"}");
            require(status(secondLinked) == 200, "ikinci hesap bağlanmalı: " + secondLinked);
            UUID third = UUID.randomUUID();
            String code3 = links.issueCode(third, "Ucuncu", "mc-test").code();
            Map<String, Object> taken = call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\"" + code3 + "\",\"discordId\":\"" + X + "\"}");
            require(status(taken) == 409 && "discord_already_linked".equals(taken.get("error"))
                    && player.toString().equals(map(taken.get("link")).get("uuid")), "zaten bağlı: " + taken);
        }
    }

    private static void inputValidation() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a02")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            String code = links.issueCode(UUID.randomUUID(), "Girdi", "mc-test").code();
            Map<String, Object> numeric = call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\"" + code + "\",\"discordId\":18446744073709551615}");
            require(status(numeric) == 400 && "invalid_discord_id".equals(numeric.get("error")), "sayı ID: " + numeric);
            require(links.probe(code, null).holder(), "reddedilen istek kodu tüketmemeli");
            Map<String, Object> missing = call(api, "POST", "/api/link/v2/verify", "{\"discordId\":\"" + Y + "\"}");
            require(status(missing) == 400 && "missing_fields".equals(missing.get("error")), "eksik alan: " + missing);
            Map<String, Object> badJson = call(api, "POST", "/api/link/v2/verify", "{bozuk");
            require(status(badJson) == 400, "bozuk JSON: " + badJson);
            Map<String, Object> badRid = call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\"" + code + "\",\"discordId\":\"" + Y + "\",\"requestId\":\"a b\"}");
            require(status(badRid) == 400 && "invalid_request_id".equals(badRid.get("error")), "requestId: " + badRid);
        }
    }

    private static void probe() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a03")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            String code = links.issueCode(UUID.randomUUID(), "Yoklama", "mc-test").code();
            require(Boolean.TRUE.equals(call(api, "POST", "/api/link/v2/probe", "{\"code\":\"" + code + "\"}").get("holder")),
                    "bekleyen kod sahipliği");
            require(Boolean.FALSE.equals(call(api, "POST", "/api/link/v2/probe", "{\"code\":\"4SAAAAAA\"}").get("holder")),
                    "bilinmeyen kod");
            call(api, "POST", "/api/link/v2/verify", "{\"code\":\"" + code + "\",\"discordId\":\"" + X + "\"}");
            require(links.probe(code, null).holder() == false, "tüketilmiş kod sahipsiz görünmeli");
            require(Boolean.TRUE.equals(call(api, "POST", "/api/link/v2/probe",
                    "{\"code\":\"" + code + "\",\"discordId\":\"" + X + "\"}").get("holder")), "aynı hesabın makbuzu");
            require(Boolean.FALSE.equals(call(api, "POST", "/api/link/v2/probe",
                    "{\"code\":\"" + code + "\",\"discordId\":\"" + Y + "\"}").get("holder")), "başka hesap makbuzu görmemeli");
        }
    }

    private static void operationReconcile() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a04")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            UUID player = UUID.randomUUID();
            String code = links.issueCode(player, "Uzlasma", "mc-test").code();
            call(api, "POST", "/api/link/v2/verify",
                    "{\"code\":\"" + code + "\",\"discordId\":\"" + X + "\",\"requestId\":\"rid-timeout\"}");
            Map<String, Object> op = call(api, "GET", "/api/link/v2/operation?requestId=rid-timeout", null);
            require(Boolean.TRUE.equals(op.get("found")) && "linked".equals(op.get("result"))
                    && player.toString().equals(map(op.get("link")).get("uuid")), "operation: " + op);
            Map<String, Object> unknown = call(api, "GET", "/api/link/v2/operation?requestId=yok", null);
            require(Boolean.FALSE.equals(unknown.get("found")), "bilinmeyen işlem: " + unknown);
            LinkBridgeApi restarted = new LinkBridgeApi(env.service(), "mc-test", QUIET);
            Map<String, Object> afterRestart = call(restarted, "GET", "/api/link/v2/operation?requestId=rid-timeout", null);
            require(Boolean.TRUE.equals(afterRestart.get("found")) && "linked".equals(afterRestart.get("result")),
                    "restart sonrası operation: " + afterRestart);
        }
    }

    private static void storeUnavailable() throws Exception {
        LinkTestEnv env = new LinkTestEnv("a05");
        LinkService links = env.service();
        LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
        String code = links.issueCode(UUID.randomUUID(), "Ariza", "mc-test").code();
        env.close();
        Map<String, Object> verify = call(api, "POST", "/api/link/v2/verify",
                "{\"code\":\"" + code + "\",\"discordId\":\"" + X + "\"}");
        require(status(verify) == 503 && "store_unavailable".equals(verify.get("error")), "verify: " + verify);
        Map<String, Object> info = call(api, "GET", "/api/link/v2/info?discord=" + X, null);
        require(status(info) == 503, "info: " + info);
        Map<String, Object> status = call(api, "GET", "/api/link/status?discord=" + X, null);
        require(status(status) == 503, "eski durum ucu da maskelememeli: " + status);
    }

    private static void info() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a06")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            UUID player = UUID.randomUUID();
            env.player(player, "BilgiYeni");
            links.verify(new LinkService.VerifyRequest(links.issueCode(player, "BilgiEski", "mc-test").code(), X, "b#0", null, "discord"));
            Map<String, Object> byUuid = call(api, "GET", "/api/link/v2/info?uuid=" + player, null);
            require(Boolean.TRUE.equals(byUuid.get("linked")) && "BilgiYeni".equals(map(byUuid.get("link")).get("currentName"))
                    && "BilgiEski".equals(map(byUuid.get("link")).get("mcName")), "uuid: " + byUuid);
            require(!((List<?>) byUuid.get("recentEvents")).isEmpty(), "son olaylar gelmeli");
            Map<String, Object> byDiscord = call(api, "GET", "/api/link/v2/info?discord=" + X, null);
            require(player.toString().equals(byDiscord.get("uuid")), "discord: " + byDiscord);
            Map<String, Object> byName = call(api, "GET", "/api/link/v2/info?name=bilgiyeni", null);
            require(Boolean.TRUE.equals(byName.get("linked")), "isim: " + byName);
            env.player(UUID.randomUUID(), "BilgiEski");
            Map<String, Object> ambiguous = call(api, "GET", "/api/link/v2/info?name=BilgiEski", null);
            require(status(ambiguous) == 409 && "ambiguous_name".equals(ambiguous.get("error"))
                    && ((List<?>) ambiguous.get("candidates")).size() == 2, "belirsiz: " + ambiguous);
            Map<String, Object> unlinked = call(api, "GET", "/api/link/v2/info?discord=" + Y, null);
            require(Boolean.FALSE.equals(unlinked.get("linked")) && Boolean.FALSE.equals(unlinked.get("resolved")),
                    "bağlantısız discord: " + unlinked);
        }
    }

    private static void list() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a07")) {
            LinkService links = env.service();
            long[] clock = {10_000L};
            links.setClock(() -> clock[0]);
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            for (int i = 0; i < 3; i++) {
                clock[0] = 10_000L + i;
                links.verify(new LinkService.VerifyRequest(links.issueCode(UUID.randomUUID(), "L" + i, "mc-test").code(),
                        "50000000000000000" + i, null, null, "discord"));
            }
            Map<String, Object> page = call(api, "GET", "/api/link/v2/list?offset=0&limit=2", null);
            List<?> rows = (List<?>) page.get("links");
            require(page.get("total").toString().equals("3") && rows.size() == 2
                    && "500000000000000002".equals(map(rows.get(0)).get("discordId")), "liste: " + page);
            Map<String, Object> clamp = call(api, "GET", "/api/link/v2/list?offset=0&limit=999", null);
            require(clamp.get("limit").toString().equals("25"), "sayfa boyutu 25 ile sınırlanmalı: " + clamp);
        }
    }

    private static void history() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a08")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            UUID a = UUID.randomUUID();
            links.verify(new LinkService.VerifyRequest(links.issueCode(a, "GecmisApi", "mc-test").code(), X, null, null, "discord"));
            call(api, "POST", "/api/link/v2/unlink", "{\"selector\":\"uuid\",\"value\":\"" + a
                    + "\",\"reason\":\"test\",\"actor\":{\"type\":\"discord_staff\",\"id\":\"" + STAFF + "\",\"name\":\"y#0\"}}");
            Map<String, Object> page = call(api, "GET", "/api/link/v2/history?uuid=" + a + "&limit=1", null);
            List<?> events = (List<?>) page.get("events");
            Map<String, Object> newest = map(events.get(0));
            require(events.size() == 1 && "unlink".equals(newest.get("action")) && STAFF.equals(newest.get("actorId"))
                    && "test".equals(newest.get("reason")) && page.get("nextBeforeId") != null, "geçmiş: " + page);
            Map<String, Object> older = call(api, "GET", "/api/link/v2/history?uuid=" + a + "&limit=1&beforeId="
                    + page.get("nextBeforeId"), null);
            require("link".equals(map(((List<?>) older.get("events")).get(0)).get("action")), "önceki sayfa: " + older);
            Map<String, Object> byDiscord = call(api, "GET", "/api/link/v2/history?discord=" + X, null);
            require(((List<?>) byDiscord.get("events")).size() == 2, "discord filtresi: " + byDiscord);
        }
    }

    private static void unlink() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a09")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            UUID a = UUID.randomUUID();
            env.player(a, "SilApi");
            LinkService.VerifyResult.Linked linked = (LinkService.VerifyResult.Linked) links.verify(
                    new LinkService.VerifyRequest(links.issueCode(a, "SilApi", "mc-test").code(), X, null, null, "discord"));
            String actor = ",\"actor\":{\"type\":\"discord_staff\",\"id\":\"" + STAFF + "\"}";

            Map<String, Object> noActor = call(api, "POST", "/api/link/v2/unlink", "{\"selector\":\"name\",\"value\":\"SilApi\"}");
            require(status(noActor) == 400 && "actor_required".equals(noActor.get("error")), "yetkili yok: " + noActor);
            require(links.recordByUuid(a).isPresent(), "yetkisiz istek hiçbir şey silmemeli");

            Map<String, Object> stale = call(api, "POST", "/api/link/v2/unlink",
                    "{\"selector\":\"uuid\",\"value\":\"" + a + "\",\"expectedLinkId\":\"eski-surum\"" + actor + "}");
            require(status(stale) == 409 && "stale_version".equals(stale.get("error"))
                    && linked.link().linkId().equals(map(stale.get("current")).get("linkId")), "eski sürüm: " + stale);

            Map<String, Object> removed = call(api, "POST", "/api/link/v2/unlink",
                    "{\"selector\":\"name\",\"value\":\"silapi\",\"expectedLinkId\":\"" + linked.link().linkId() + "\"" + actor + "}");
            require(status(removed) == 200 && "removed".equals(removed.get("result"))
                    && X.equals(map(removed.get("link")).get("discordId")), "kaldırma: " + removed);
            Map<String, Object> again = call(api, "POST", "/api/link/v2/unlink",
                    "{\"selector\":\"discord\",\"value\":\"" + X + "\"" + actor + "}");
            require(status(again) == 200 && "not_linked".equals(again.get("result")), "tekrar: " + again);

            env.player(UUID.randomUUID(), "Ikiz");
            env.player(UUID.randomUUID(), "IKIZ");
            Map<String, Object> ambiguous = call(api, "POST", "/api/link/v2/unlink",
                    "{\"selector\":\"name\",\"value\":\"ikiz\"" + actor + "}");
            require(status(ambiguous) == 409 && "ambiguous_name".equals(ambiguous.get("error")), "belirsiz: " + ambiguous);
        }
    }

    private static void legacyEndpoints() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("a10")) {
            LinkService links = env.service();
            LinkBridgeApi api = new LinkBridgeApi(links, "mc-test", QUIET);
            UUID a = UUID.randomUUID();
            String code = links.issueCode(a, "EskiUc").code();
            Map<String, Object> verify = call(api, "POST", "/api/link/verify",
                    "{\"code\":\"" + code + "\",\"discordId\":\"" + X + "\",\"discordTag\":\"e#0\"}");
            require(status(verify) == 200 && "EskiUc".equals(verify.get("mc")), "eski verify: " + verify);
            Map<String, Object> status = call(api, "GET", "/api/link/status?discord=" + X, null);
            require(Boolean.TRUE.equals(status.get("linked")) && a.toString().equals(status.get("uuid"))
                    && X.equals(status.get("discordId")), "eski durum: " + status);
            env.player(UUID.randomUUID(), "EskiUc");
            Map<String, Object> ambiguousStatus = call(api, "GET", "/api/link/status?mc=eskiuc", null);
            require(status(ambiguousStatus) == 409, "belirsiz isim durumu 409 olmalı: " + ambiguousStatus);
            Map<String, Object> ambiguousDelete = call(api, "DELETE", "/api/link", "{\"type\":\"mc\",\"value\":\"EskiUc\"}");
            require(status(ambiguousDelete) == 409 && links.recordByUuid(a).isPresent(), "belirsiz isimle silme: " + ambiguousDelete);
            Map<String, Object> delete = call(api, "DELETE", "/api/link", "{\"type\":\"dc\",\"value\":\"" + X + "\"}");
            require(Boolean.TRUE.equals(delete.get("removed")) && X.equals(delete.get("discordId"))
                    && a.toString().equals(delete.get("uuid")), "eski silme: " + delete);
        }
    }

    private static void routing() throws Exception {
        require(LinkBridgeApi.handles("POST", "/api/link/v2/verify"), "v2 yolu");
        require(LinkBridgeApi.handles("GET", "/api/link/status?discord=1"), "eski durum yolu");
        require(LinkBridgeApi.handles("DELETE", "/api/link"), "eski silme yolu");
        require(!LinkBridgeApi.handles("GET", "/api/links"), "/api/links snapshot yolu değişmemeli");
        require(!LinkBridgeApi.handles("POST", "/api/mod"), "moderasyon yolu dokunulmamalı");
        try (LinkTestEnv env = new LinkTestEnv("a11")) {
            LinkBridgeApi api = new LinkBridgeApi(env.service(), "mc-test", QUIET);
            Map<String, Object> unknown = call(api, "GET", "/api/link/v2/yok", null);
            require(status(unknown) == 404 && "not_found".equals(unknown.get("error")), "bilinmeyen: " + unknown);
        }
    }

    /* ------------------------------------------------------------------ */

    private static Map<String, Object> call(LinkBridgeApi api, String method, String path, String body) {
        LinkBridgeApi.Response response = api.handle(method, path, body);
        Map<String, Object> parsed = LinkJson.parseObject(response.json());
        parsed.put("_status", response.status());
        return parsed;
    }

    private static int status(Map<String, Object> response) {
        return (Integer) response.get("_status");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        if (!(value instanceof Map<?, ?>)) throw new AssertionError("nesne bekleniyordu: " + value);
        return (Map<String, Object>) value;
    }

    private static void scenario(String name, ThrowingRunnable body) {
        try {
            body.run();
            System.out.println("  ok   " + name);
        } catch (Throwable failure) {
            System.out.println("  FAIL " + name + ": " + failure);
            FAILURES.add(name);
        }
    }

    private static void require(boolean condition, String message) {
        LinkTestEnv.require(condition, message);
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
