import com.nautilus.discordlink.LinkService;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Bağlantı yaşam döngüsü: link → unlink → relink, gecikmiş/tekrarlanan teslim,
 * restart/stale örnek, çökme penceresi, DB kilidi, isim değişikliği, büyük
 * Discord ID'leri ve yönetici unlink'i. Gerçek DataStore + SQLite kullanılır.
 *
 * Yarışlar rastgele tekrarla değil, transaction içindeki test kancaları ve
 * iş parçacığı durumu kontrolüyle zorlanır: ikinci işlemin gerçekten kilitte
 * beklediği doğrulanmadan birinci işlem serbest bırakılmaz.
 */
public final class LinkServiceLifecycleTest {
    private static final String X = "111111111111111111";
    private static final String Y = "222222222222222222";
    private static final String Z = "333333333333333333";
    private static final String STAFF = "900000000000000001";
    private static final List<String> FAILURES = new ArrayList<>();

    public static void main(String[] args) {
        Logger.getLogger("").setLevel(Level.SEVERE);
        scenario("S01 iki Minecraft + iki Discord hesabıyla normal eşleme", LinkServiceLifecycleTest::normalTwoAccounts);
        scenario("S02 A link → unlink → yeniden link; B değişmez", LinkServiceLifecycleTest::relinkKeepsOthers);
        scenario("S03 unlink sonrası gecikmiş teslim yetki kazanmaz", LinkServiceLifecycleTest::delayedVerifyAfterUnlink);
        scenario("S04 yeni /link önceki kodu geçersizleştirir", LinkServiceLifecycleTest::newCodeRevokesPrevious);
        scenario("S05 aynı kodu iki Discord hesabı eşzamanlı kullanır (zorlanmış)", LinkServiceLifecycleTest::sameCodeTwoDiscords);
        scenario("S06 aynı Discord iki farklı kodu eşzamanlı gönderir (zorlanmış)", LinkServiceLifecycleTest::sameDiscordTwoCodes);
        scenario("S07 çift modal teslimi ve kaybolan başarılı yanıt", LinkServiceLifecycleTest::duplicateDeliveryAndLostResponse);
        scenario("S08 restart, stale servis örneği ve replay", LinkServiceLifecycleTest::restartStaleAndReplay);
        scenario("S09 DB commit ile kod tüketimi arasında çökme", LinkServiceLifecycleTest::crashBetweenCommitAndConsumption);
        scenario("S10 çevrimdışı oyuncunun adıyla unlink iki taraftan kaldırır", LinkServiceLifecycleTest::offlineNameUnlink);
        scenario("S11 aynı unlink tekrar çalıştırılınca idempotent", LinkServiceLifecycleTest::repeatedUnlink);
        scenario("S12 eski panel (eski link sürümü) yeni bağlantıyı silemez", LinkServiceLifecycleTest::stalePanelCannotRemoveNewLink);
        scenario("S13 isim değişikliğinde UUID üzerinden doğru kayıt, belirsiz isimde silme yok", LinkServiceLifecycleTest::nameChange);
        scenario("S14 büyük Discord ID'leri hassasiyet kaybetmez", LinkServiceLifecycleTest::largeDiscordIds);
        scenario("S15a verify sürerken gelen admin unlink sıralı işlenir", LinkServiceLifecycleTest::unlinkDuringVerify);
        scenario("S15b unlink sürerken gelen eski kod bağlantıyı yeniden oluşturmaz", LinkServiceLifecycleTest::verifyDuringUnlink);
        scenario("S16 DB kilidi altyapı hatası verir, kodu tüketmez", LinkServiceLifecycleTest::databaseLocked);
        scenario("S17 bozuk kod deposunda unlink yarım işlem bırakmaz", LinkServiceLifecycleTest::corruptStoreUnlink);
        scenario("S18 aktif liste en son eşleşen önce, eşit zamanda UUID ile kararlı sayfalar", LinkServiceLifecycleTest::listOrderingAndPaging);
        scenario("S19 geçmiş oyuncu/Discord filtresi ve sayfalama", LinkServiceLifecycleTest::historyFilters);
        scenario("S20 eski biçimli kod uyumlu; unlink sonrası dosya güncellemesi kaybolsa da reddedilir", LinkServiceLifecycleTest::legacyCodeAndLostFileUpdate);
        scenario("S21 iki hesap şema geçişi ve ön yedek", LinkServiceLifecycleTest::migrationAndBackup);

        if (!FAILURES.isEmpty()) {
            System.out.println("FAIL LinkServiceLifecycleTest (" + FAILURES.size() + " senaryo)");
            FAILURES.forEach(failure -> System.out.println("  - " + failure));
            System.exit(1);
        }
        System.out.println("PASS LinkServiceLifecycleTest");
    }

    /* ------------------------------------------------------------------ */

    private static void normalTwoAccounts() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s01")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            UUID b = UUID.randomUUID();
            String codeA = links.issueCode(a, "Ahmet", "mc-live").code();
            String codeB = links.issueCode(b, "Burak", "mc-live").code();
            require(codeA.length() == 8 && codeA.startsWith("9D"), "kapsamlı kod beklenmiyor: " + codeA);
            requireLinked(links.verify(request(codeA, X, "rid-a")), a, X, true);
            requireLinked(links.verify(request(codeB, Y, "rid-b")), b, Y, true);
            require(links.recordByUuid(a).orElseThrow().discordId().equals(X), "A yanlış Discord'a bağlı");
            require(links.recordByDiscord(Y).orElseThrow().uuid().equals(b), "Y yanlış hesaba bağlı");
            require(links.listLinks(0, 10).total() == 2, "iki aktif bağlantı olmalı");
            List<LinkService.LinkEvent> history = links.history(null, null, 10, null);
            require(history.size() == 2 && history.stream()
                    .allMatch(e -> "link".equals(e.action()) && "ok".equals(e.result())), "geçmiş: " + history);
        }
    }

    private static void relinkKeepsOthers() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s02")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            UUID b = UUID.randomUUID();
            env.player(a, "Ahmet");
            env.player(b, "Burak");
            LinkService.LinkRecord firstA = linkedRecord(links.verify(request(links.issueCode(a, "Ahmet", "mc-live").code(), X, null)));
            LinkService.LinkRecord linkB = linkedRecord(links.verify(request(links.issueCode(b, "Burak", "mc-live").code(), Y, null)));

            LinkService.UnlinkResult removed = links.unlink(unlink(LinkService.Selector.BY_NAME, "ahmet", null));
            require(removed instanceof LinkService.UnlinkResult.Removed r && r.link().uuid().equals(a) && r.epoch() == 1,
                    "isimle unlink A'yı kaldırmalı: " + removed);
            require(links.recordByUuid(a).isEmpty() && links.recordByDiscord(X).isEmpty(),
                    "unlink sonrası iki taraf da bağlantısız görünmeli");
            requireSameLink(links.recordByUuid(b), linkB, "B unlink'ten etkilenmemeli");

            LinkService.LinkRecord secondA = linkedRecord(links.verify(request(links.issueCode(a, "Ahmet", "mc-live").code(), X, null)));
            require(secondA.uuid().equals(a) && secondA.discordId().equals(X) && !secondA.linkId().equals(firstA.linkId()),
                    "aynı hesaplarla yeniden eşleme yeni sürümle kurulmalı");
            requireSameLink(links.recordByUuid(b), linkB, "A'nın yeniden bağlanması B'yi değiştirmemeli");

            require(links.unlink(unlink(LinkService.Selector.BY_DISCORD, X, null)) instanceof LinkService.UnlinkResult.Removed,
                    "Discord ID ile unlink çalışmalı");
            LinkService.LinkRecord thirdA = linkedRecord(links.verify(request(links.issueCode(a, "Ahmet", "mc-live").code(), Z, null)));
            require(thirdA.discordId().equals(Z), "unlink sonrası başka uygun Discord hesabıyla eşleme yapılabilmeli");
            require(links.recordByDiscord(X).isEmpty(), "eski Discord hesabı bağlantısız kalmalı");
            requireSameLink(links.recordByUuid(b), linkB, "B hiçbir adımda değişmemeli");
        }
    }

    private static void delayedVerifyAfterUnlink() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s03")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            String code = links.issueCode(a, "Gecikmeli", "mc-live").code();
            requireLinked(links.verify(request(code, X, "rid-1")), a, X, true);
            require(links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)) instanceof LinkService.UnlinkResult.Removed,
                    "ön koşul: unlink");
            LinkService.VerifyResult delayed = links.verify(request(code, X, "rid-late"));
            require(delayed instanceof LinkService.VerifyResult.InvalidCode, "gecikmiş aynı teslim bağlantıyı yeniden kurdu: " + delayed);
            require(links.recordByUuid(a).isEmpty(), "gecikmiş teslim sonrası bağlantı oluşmamalı");

            // Bağlı olmayan hesap için yapılan unlink, oyuncunun yeni aldığı kodu iptal etmez.
            String fresh = links.issueCode(a, "Gecikmeli", "mc-live").code();
            require(links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)) instanceof LinkService.UnlinkResult.NotLinked,
                    "bağlı olmayan hesap için unlink not_linked olmalı");
            requireLinked(links.verify(request(fresh, Y, null)), a, Y, true);
        }
    }

    private static void newCodeRevokesPrevious() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s04")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            UUID other = UUID.randomUUID();
            String otherCode = links.issueCode(other, "Diger", "mc-live").code();
            String first = links.issueCode(a, "Yenileyen", "mc-live").code();
            String second = links.issueCode(a, "Yenileyen", "mc-live").code();
            require(!first.equals(second), "her /link yeni kod üretmeli");
            require(links.verify(request(first, X, null)) instanceof LinkService.VerifyResult.InvalidCode,
                    "önceki kod geçersiz olmalı");
            requireLinked(links.verify(request(second, X, null)), a, X, true);
            requireLinked(links.verify(request(otherCode, Y, null)), other, Y, true);
        }
    }

    private static void sameCodeTwoDiscords() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s05")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            String code = links.issueCode(a, "Yaris", "mc-live").code();
            Gate gate = Gate.onLinkCommit(links);
            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                Future<LinkService.VerifyResult> first = pool.submit(() -> links.verify(request(code, X, "rid-x")));
                gate.awaitEntered();
                AtomicReference<Thread> secondThread = new AtomicReference<>();
                Future<LinkService.VerifyResult> second = pool.submit(() -> {
                    secondThread.set(Thread.currentThread());
                    return links.verify(request(code, Y, "rid-y"));
                });
                awaitBlocked(secondThread);
                gate.release();
                requireLinked(first.get(10, TimeUnit.SECONDS), a, X, true);
                LinkService.VerifyResult loser = second.get(10, TimeUnit.SECONDS);
                require(loser instanceof LinkService.VerifyResult.InvalidCode, "ikinci Discord kodu kullanabildi: " + loser);
                require(links.recordByUuid(a).orElseThrow().discordId().equals(X) && links.recordByDiscord(Y).isEmpty(),
                        "tek bir kalıcı eşleme olmalı");
            } finally {
                pool.shutdownNow();
            }
        }
    }

    private static void sameDiscordTwoCodes() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s06")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            UUID b = UUID.randomUUID();
            String codeA = links.issueCode(a, "OyuncuA", "mc-live").code();
            String codeB = links.issueCode(b, "OyuncuB", "mc-live").code();
            Gate gate = Gate.onLinkCommit(links);
            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                Future<LinkService.VerifyResult> first = pool.submit(() -> links.verify(request(codeA, X, null)));
                gate.awaitEntered();
                AtomicReference<Thread> secondThread = new AtomicReference<>();
                Future<LinkService.VerifyResult> second = pool.submit(() -> {
                    secondThread.set(Thread.currentThread());
                    return links.verify(request(codeB, X, null));
                });
                awaitBlocked(secondThread);
                gate.release();
                requireLinked(first.get(10, TimeUnit.SECONDS), a, X, true);
                requireLinked(second.get(10, TimeUnit.SECONDS), b, X, true);
                UUID c = UUID.randomUUID();
                String codeC = links.issueCode(c, "OyuncuC", "mc-live").code();
                LinkService.VerifyResult taken = links.verify(request(codeC, X, null));
                require(taken instanceof LinkService.VerifyResult.DiscordAlreadyLinked,
                        "aynı Discord üçüncü hesaba bağlanmamalı: " + taken);
                require(links.recordByUuid(c).isEmpty(), "C bağlanmamalı");
                require(links.probe(codeC, null).holder(), "C'nin kodu tüketilmemeli");
                requireLinked(links.verify(request(codeC, Y, null)), c, Y, true);
            } finally {
                pool.shutdownNow();
            }
        }
    }

    private static void duplicateDeliveryAndLostResponse() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s07")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            String code = links.issueCode(a, "Tekrar", "mc-live").code();
            LinkService.VerifyResult first = links.verify(request(code, X, "rid-1"));
            requireLinked(first, a, X, true);
            LinkService.VerifyResult duplicate = links.verify(request(code.toLowerCase(), X, "rid-2"));
            require(duplicate instanceof LinkService.VerifyResult.Linked l && !l.created() && l.replay()
                            && l.link().linkId().equals(((LinkService.VerifyResult.Linked) first).link().linkId()),
                    "aynı hesaptan tekrar idempotent başarı olmalı: " + duplicate);
            require(links.verify(request(code, Y, "rid-3")) instanceof LinkService.VerifyResult.InvalidCode,
                    "kullanılmış kod başka hesaba başarı döndürmemeli");
            require(links.operation("rid-1").map(o -> o.result().equals("linked")).orElse(false),
                    "kaybolan yanıt işlem kimliğiyle uzlaştırılabilmeli");
            Optional<LinkService.OperationRecord> afterRestart = env.service().operation("rid-1");
            require(afterRestart.isPresent() && afterRestart.get().result().equals("linked")
                            && afterRestart.get().link().uuid().equals(a),
                    "restart sonrası da işlem sonucu DB'den okunmalı: " + afterRestart);
            require(links.listLinks(0, 10).total() == 1, "tekrar teslim ikinci kayıt üretmemeli");
        }
    }

    private static void restartStaleAndReplay() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s08")) {
            LinkService stale = env.service();
            LinkService issuer = env.service();
            UUID a = UUID.randomUUID();
            String code = issuer.issueCode(a, "Restart", "mc-live").code();
            requireLinked(stale.verify(request(code, X, null)), a, X, true);
            LinkService restarted = env.service();
            LinkService.VerifyResult replay = restarted.verify(request(code, X, null));
            require(replay instanceof LinkService.VerifyResult.Linked l && l.replay(), "restart sonrası replay: " + replay);
            require(restarted.verify(request(code, Y, null)) instanceof LinkService.VerifyResult.InvalidCode,
                    "restart sonrası başka hesap kodu kullanamamalı");
            require(restarted.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)) instanceof LinkService.UnlinkResult.Removed,
                    "ön koşul: unlink");
            require(stale.verify(request(code, X, null)) instanceof LinkService.VerifyResult.InvalidCode,
                    "stale örnek unlink sonrası eski makbuzla başarı döndürdü");
            require(issuer.verify(request(code, X, null)) instanceof LinkService.VerifyResult.InvalidCode,
                    "üreten örnek unlink sonrası eski makbuzla başarı döndürdü");
            require(env.store.linkByUuid(a) == null, "bağlantı yeniden oluşmamalı");
        }
    }

    private static void crashBetweenCommitAndConsumption() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s09")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            String code = links.issueCode(a, "Cokme", "mc-live").code();
            LinkService.TestHooks hooks = new LinkService.TestHooks();
            AtomicBoolean once = new AtomicBoolean();
            hooks.afterLinkCommit = () -> {
                if (once.compareAndSet(false, true)) throw new IllegalStateException("simüle edilmiş çökme");
            };
            links.setTestHooks(hooks);
            boolean crashed = false;
            try {
                links.verify(request(code, X, "rid-crash"));
            } catch (IllegalStateException expected) {
                crashed = true;
            }
            require(crashed, "ön koşul: çökme simülasyonu");
            require(env.store.linkByUuid(a) != null && X.equals(env.store.linkByUuid(a).discordId()),
                    "ön koşul: DB commit olmuş olmalı");

            LinkService restarted = env.service();
            require(restarted.probe(code, null).holder(), "ön koşul: kod dosyada tüketilmemiş kalmalı");
            require(restarted.verify(request(code, Y, null)) instanceof LinkService.VerifyResult.InvalidCode,
                    "yarım işlem başka Discord'a hesabı devretti");
            require(X.equals(env.store.linkByUuid(a).discordId()), "bağlantı ilk Discord'da kalmalı");
            LinkService.VerifyResult retry = restarted.verify(request(code, X, null));
            require(retry instanceof LinkService.VerifyResult.Linked l && !l.created() && l.replay(),
                    "aynı hesabın yeniden denemesi güvenli başarı dönmeli: " + retry);
            require(restarted.operation("rid-crash").map(o -> "linked".equals(o.result())).orElse(false),
                    "çöken işlem requestId ile DB'den uzlaştırılabilmeli");
            require(restarted.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)) instanceof LinkService.UnlinkResult.Removed,
                    "ön koşul: unlink");
            require(restarted.verify(request(code, X, null)) instanceof LinkService.VerifyResult.InvalidCode,
                    "unlink sonrası çöken işlemin kodu yetki kazandı");
        }
    }

    private static void offlineNameUnlink() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s10")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            env.player(a, "OfflineAli");
            linkedRecord(links.verify(request(links.issueCode(a, "OfflineAli", "mc-live").code(), X, null)));
            LinkService.UnlinkResult result = links.unlink(new LinkService.UnlinkRequest(LinkService.Selector.BY_NAME,
                    "offlineali", null, List.of(), staff(), "hesap satışı şüphesi", "discord_admin", "rid-unlink"));
            require(result instanceof LinkService.UnlinkResult.Removed r && r.link().uuid().equals(a),
                    "çevrimdışı oyuncu adıyla kaldırılmalı: " + result);
            require(links.recordByUuid(a).isEmpty() && links.recordByDiscord(X).isEmpty(), "iki taraf da bağlantısız olmalı");
            require(env.store.linkByUuid(a) == null && env.store.linkByDiscord(X) == null, "eski DataStore sorguları da bağlantısız görmeli");
            require(env.number("SELECT COUNT(*) FROM players WHERE uuid = ?", a) == 1, "oyuncu/istatistik kaydı silinmemeli");
            LinkService.LinkEvent event = links.history(a, null, 5, null).get(0);
            require("unlink".equals(event.action()) && "ok".equals(event.result()) && "discord_staff".equals(event.actorType())
                            && STAFF.equals(event.actorId()) && "hesap satışı şüphesi".equals(event.reason())
                            && X.equals(event.discordId()) && "rid-unlink".equals(event.requestId()),
                    "denetim kaydı eksik: " + event);
        }
    }

    private static void repeatedUnlink() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s11")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            linkedRecord(links.verify(request(links.issueCode(a, "Tekrarli", "mc-live").code(), X, null)));
            require(links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)) instanceof LinkService.UnlinkResult.Removed,
                    "ilk unlink kaldırmalı");
            LinkService.UnlinkResult again = links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null));
            require(again instanceof LinkService.UnlinkResult.NotLinked n && n.resolved(), "tekrar unlink not_linked olmalı: " + again);
            require(links.epoch(a) == 1, "tekrar unlink epoch'u artırmamalı");
            LinkService.UnlinkResult byDiscord = links.unlink(unlink(LinkService.Selector.BY_DISCORD, X, null));
            require(byDiscord instanceof LinkService.UnlinkResult.NotLinked n2 && !n2.resolved(), "Discord ile tekrar: " + byDiscord);
            require(links.history(a, null, 10, null).stream().anyMatch(e -> "not_linked".equals(e.result())),
                    "etkisiz unlink de denetim geçmişinde görünmeli");
        }
    }

    private static void stalePanelCannotRemoveNewLink() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s12")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            LinkService.LinkRecord panelView = linkedRecord(links.verify(request(links.issueCode(a, "Panel", "mc-live").code(), X, null)));
            require(links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)) instanceof LinkService.UnlinkResult.Removed,
                    "ön koşul: oyuncu/başka yetkili unlink");
            LinkService.LinkRecord relinked = linkedRecord(links.verify(request(links.issueCode(a, "Panel", "mc-live").code(), X, null)));
            LinkService.UnlinkResult stale = links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), panelView.linkId()));
            require(stale instanceof LinkService.UnlinkResult.StaleVersion s && s.current().linkId().equals(relinked.linkId()),
                    "eski panel sürüm uyuşmazlığı döndürmeli: " + stale);
            requireSameLink(links.recordByUuid(a), relinked, "eski panel yeni bağlantıyı silmemeli");
            require(links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), relinked.linkId())) instanceof LinkService.UnlinkResult.Removed,
                    "güncel sürümle kaldırma çalışmalı");
        }
    }

    private static void nameChange() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s13")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            linkedRecord(links.verify(request(links.issueCode(a, "EskiAd", "mc-live").code(), X, null)));
            env.player(a, "YeniAd");
            LinkService.LinkRecord record = links.recordByUuid(a).orElseThrow();
            require("EskiAd".equals(record.mcName()) && "YeniAd".equals(record.displayName()),
                    "güncel ad UUID üzerinden görünmeli: " + record);
            UUID other = UUID.randomUUID();
            env.player(other, "EskiAd"); // ad başka bir oyuncuya geçti

            LinkService.UnlinkResult ambiguous = links.unlink(unlink(LinkService.Selector.BY_NAME, "EskiAd", null));
            require(ambiguous instanceof LinkService.UnlinkResult.Ambiguous amb && amb.candidates().size() == 2,
                    "belirsiz ad reddedilmeli: " + ambiguous);
            require(links.recordByUuid(a).isPresent(), "belirsiz adla hiçbir bağlantı silinmemeli");
            boolean threw = false;
            try {
                links.byName("eskiad");
            } catch (LinkService.AmbiguousNameException expected) {
                threw = expected.candidates().size() == 2;
            }
            require(threw, "belirsiz ad sorgusu da açıkça reddedilmeli");
            require(links.unlink(unlink(LinkService.Selector.BY_NAME, "yeniad", null)) instanceof LinkService.UnlinkResult.Removed r
                    && r.link().uuid().equals(a), "güncel adla kesin eşleşme kaldırmalı");
        }
    }

    private static void largeDiscordIds() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s14")) {
            LinkService links = env.service();
            String max = "18446744073709551615";
            String near = "18446744073709551614";
            UUID a = UUID.randomUUID();
            UUID b = UUID.randomUUID();
            linkedRecord(links.verify(request(links.issueCode(a, "Buyuk1", "mc-live").code(), max, null)));
            linkedRecord(links.verify(request(links.issueCode(b, "Buyuk2", "mc-live").code(), near, null)));
            require(links.recordByDiscord(max).orElseThrow().uuid().equals(a), "u64 üst sınır ID yanlış hesaba çözüldü");
            require(links.recordByDiscord(near).orElseThrow().uuid().equals(b), "komşu büyük ID yanlış hesaba çözüldü");
            require(max.equals(env.string("SELECT discord_id FROM discord_links WHERE uuid = ?", a)),
                    "ID metin olarak birebir saklanmalı");
            require(max.equals(links.history(a, null, 1, null).get(0).discordId()), "geçmişte ID birebir olmalı");
            requireThrows(IllegalArgumentException.class, () -> links.verify(request(
                    links.issueCode(UUID.randomUUID(), "Gecersiz", "mc-live").code(), "123456789012345678901", null)),
                    "21 haneli ID reddedilmeli");
            requireThrows(IllegalArgumentException.class, () -> links.recordByDiscord("12a"), "rakam dışı ID reddedilmeli");
        }
    }

    private static void unlinkDuringVerify() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s15a")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            String code = links.issueCode(a, "YarisUnlink", "mc-live").code();
            Gate gate = Gate.onLinkCommit(links);
            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                Future<LinkService.VerifyResult> verify = pool.submit(() -> links.verify(request(code, X, null)));
                gate.awaitEntered();
                AtomicReference<Thread> unlinkThread = new AtomicReference<>();
                Future<LinkService.UnlinkResult> unlink = pool.submit(() -> {
                    unlinkThread.set(Thread.currentThread());
                    return links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null));
                });
                awaitBlocked(unlinkThread);
                gate.release();
                requireLinked(verify.get(10, TimeUnit.SECONDS), a, X, true);
                require(unlink.get(10, TimeUnit.SECONDS) instanceof LinkService.UnlinkResult.Removed,
                        "verify commit'inden sonra işlenen unlink bağlantıyı kaldırmalı");
                require(links.recordByUuid(a).isEmpty(), "son durum bağlantısız olmalı");
                require(links.verify(request(code, X, null)) instanceof LinkService.VerifyResult.InvalidCode,
                        "unlink sonrası gecikmiş tekrar bağlantıyı geri getirdi");
            } finally {
                pool.shutdownNow();
            }
        }
    }

    private static void verifyDuringUnlink() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s15b")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            linkedRecord(links.verify(request(links.issueCode(a, "YarisVerify", "mc-live").code(), X, null)));
            String stale = links.issueCode(a, "YarisVerify", "mc-live").code();
            LinkService.TestHooks hooks = new LinkService.TestHooks();
            CountDownLatch entered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            AtomicBoolean once = new AtomicBoolean();
            hooks.beforeUnlinkCommit = () -> {
                if (once.compareAndSet(false, true)) {
                    entered.countDown();
                    await(release);
                }
            };
            links.setTestHooks(hooks);
            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                Future<LinkService.UnlinkResult> unlink = pool.submit(() ->
                        links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)));
                await(entered);
                AtomicReference<Thread> verifyThread = new AtomicReference<>();
                Future<LinkService.VerifyResult> verify = pool.submit(() -> {
                    verifyThread.set(Thread.currentThread());
                    return links.verify(request(stale, Y, null));
                });
                awaitBlocked(verifyThread);
                release.countDown();
                require(unlink.get(10, TimeUnit.SECONDS) instanceof LinkService.UnlinkResult.Removed, "unlink kaldırmalı");
                LinkService.VerifyResult result = verify.get(10, TimeUnit.SECONDS);
                require(result instanceof LinkService.VerifyResult.InvalidCode, "unlink sırasında bekleyen eski kod bağladı: " + result);
                require(links.recordByUuid(a).isEmpty() && links.recordByDiscord(Y).isEmpty(), "bağlantı oluşmamalı");
            } finally {
                pool.shutdownNow();
            }
        }
    }

    private static void databaseLocked() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s16")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            String code = links.issueCode(a, "Kilit", "mc-live").code();
            try (Connection locker = DriverManager.getConnection("jdbc:sqlite:" + env.database.toAbsolutePath())) {
                try (Statement statement = locker.createStatement()) {
                    statement.execute("BEGIN EXCLUSIVE");
                }
                requireThrows(IllegalStateException.class, () -> links.verify(request(code, X, null)),
                        "kilitli DB'de doğrulama başarı ya da invalid_code döndürmemeli");
                try (Statement statement = locker.createStatement()) {
                    statement.execute("ROLLBACK");
                }
            }
            require(links.recordByUuid(a).isEmpty(), "başarısız denemede bağlantı oluşmamalı");
            requireLinked(links.verify(request(code, X, null)), a, X, true);
        }
    }

    private static void corruptStoreUnlink() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s17")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            linkedRecord(links.verify(request(links.issueCode(a, "Bozuk", "mc-live").code(), X, null)));
            Files.writeString(env.pending, "nautilus-link-codes-v3\nBOZUK-SATIR\n", StandardCharsets.UTF_8);
            requireThrows(IllegalStateException.class,
                    () -> links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null)),
                    "bozuk kod deposu altyapı hatası olarak raporlanmalı");
            require(env.store.linkByUuid(a) != null && links.epoch(a) == 0, "başarısız unlink yarım değişiklik bırakmamalı");
        }
    }

    private static void listOrderingAndPaging() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s18")) {
            LinkService links = env.service();
            long[] clock = {1_000L};
            links.setClock(() -> clock[0]);
            long[] times = {1_000L, 2_000L, 2_000L, 3_000L, 500L};
            List<LinkService.LinkRecord> created = new ArrayList<>();
            for (int i = 0; i < times.length; i++) {
                clock[0] = times[i];
                UUID uuid = UUID.randomUUID();
                String discord = "40000000000000000" + i;
                created.add(linkedRecord(links.verify(request(links.issueCode(uuid, "Liste" + i, "mc-live").code(), discord, null))));
            }
            List<LinkService.LinkRecord> expected = new ArrayList<>(created);
            expected.sort(Comparator.comparingLong(LinkService.LinkRecord::linkedAt).reversed()
                    .thenComparing(record -> record.uuid().toString()));
            List<LinkService.LinkRecord> paged = new ArrayList<>();
            for (int offset = 0; offset < 6; offset += 2) {
                LinkService.LinkPage page = links.listLinks(offset, 2);
                require(page.total() == 5, "toplam aktif bağlantı sayısı 5 olmalı");
                paged.addAll(page.links());
            }
            require(paged.stream().map(LinkService.LinkRecord::uuid).toList()
                            .equals(expected.stream().map(LinkService.LinkRecord::uuid).toList()),
                    "sıralama/sayfalama kararsız: " + paged.stream().map(r -> r.linkedAt() + ":" + r.uuid()).toList());
        }
    }

    private static void historyFilters() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s19")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            UUID b = UUID.randomUUID();
            linkedRecord(links.verify(request(links.issueCode(a, "GecmisA", "mc-live").code(), X, null)));
            linkedRecord(links.verify(request(links.issueCode(b, "GecmisB", "mc-live").code(), Y, null)));
            links.unlink(unlink(LinkService.Selector.BY_UUID, a.toString(), null));

            List<LinkService.LinkEvent> forA = links.history(a, null, 10, null);
            require(forA.size() == 2 && "unlink".equals(forA.get(0).action()) && "link".equals(forA.get(1).action()),
                    "oyuncu filtresi: " + forA);
            List<LinkService.LinkEvent> forY = links.history(null, Y, 10, null);
            require(forY.size() == 1 && b.equals(forY.get(0).uuid()), "Discord filtresi: " + forY);
            List<LinkService.LinkEvent> firstPage = links.history(null, null, 2, null);
            List<LinkService.LinkEvent> secondPage = links.history(null, null, 2, firstPage.get(1).id());
            require(firstPage.size() == 2 && secondPage.size() == 1 && secondPage.get(0).id() < firstPage.get(1).id(),
                    "geçmiş sayfalama: " + firstPage + " / " + secondPage);
        }
    }

    private static void legacyCodeAndLostFileUpdate() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s20")) {
            LinkService links = env.service();
            UUID a = UUID.randomUUID();
            String legacyCode = links.issueCode(a, "EskiBicim").code();
            Files.write(env.pending, List.of("nautilus-link-codes-v2", v2PendingLine(env.pending, a)), StandardCharsets.UTF_8);
            requireLinked(env.service().verify(request(legacyCode, X, null)), a, X, true);

            UUID b = UUID.randomUUID();
            LinkService service = env.service();
            linkedRecord(service.verify(request(service.issueCode(b, "Kaybolan").code(), Y, null)));
            String staleCode = service.issueCode(b, "Kaybolan").code();
            List<String> beforeUnlink = List.of("nautilus-link-codes-v2", v2PendingLine(env.pending, b));
            require(service.unlink(unlink(LinkService.Selector.BY_UUID, b.toString(), null)) instanceof LinkService.UnlinkResult.Removed,
                    "ön koşul: unlink");
            // DB commit oldu; dosya güncellemesi çökme ile kayboldu (eski içerik geri geldi).
            Files.write(env.pending, beforeUnlink, StandardCharsets.UTF_8);
            LinkService restarted = env.service();
            require(restarted.probe(staleCode, null).holder(), "ön koşul: eski kod dosyada duruyor");
            LinkService.VerifyResult result = restarted.verify(request(staleCode, Z, null));
            require(result instanceof LinkService.VerifyResult.InvalidCode, "dosya güncellemesi kaybolunca eski kod bağladı: " + result);
            require(restarted.recordByUuid(b).isEmpty(), "bağlantı oluşmamalı");
        }
    }

    private static void migrationAndBackup() throws Exception {
        try (LinkTestEnv env = new LinkTestEnv("s21")) {
            UUID legacy = UUID.randomUUID();
            env.store.linkCreate(new com.nautilus.storage.DataStore.LinkRow(legacy, "Eski", X, "eski#0", 1234L));
            env.service();
            String linkId = env.string("SELECT link_id FROM discord_links WHERE uuid = ?", legacy);
            require(linkId != null && linkId.startsWith("legacy-"), "mevcut satıra kalıcı sürüm verilmeli: " + linkId);
            Path backups = env.root.resolve("backups");
            long backupCount;
            try (var files = Files.list(backups)) {
                backupCount = files.filter(p -> p.getFileName().toString().startsWith("nautilus-main-pre-link-1.2.8-")).count();
            }
            require(backupCount == 1, "ilk geçişte bir ön yedek alınmalı (" + backupCount + ")");
            env.service();
            try (var files = Files.list(backups)) {
                require(files.count() == 1, "sonraki açılışlar yeni yedek almamalı");
            }
            require(env.store.linkByUuid(legacy) != null && env.store.allLinks().size() == 1,
                    "eski DataStore API'si geçiş sonrası çalışmalı");
            require(env.number("SELECT COUNT(*) FROM discord_link_events") == 0, "geçmiş olay uydurulmamalı");
        }
    }

    /* ------------------------------------------------------------------ */

    private static String v2PendingLine(Path pending, UUID uuid) throws Exception {
        String line = Files.readAllLines(pending, StandardCharsets.UTF_8).stream()
                .filter(l -> l.startsWith("P\t") && l.contains(uuid.toString()))
                .findFirst().orElseThrow(() -> new AssertionError("bekleyen kod satırı yok"));
        String[] f = line.split("\t", -1);
        return String.join("\t", "P", f[1], f[2], f[3], f[4]);
    }

    private static LinkService.VerifyRequest request(String code, String discordId, String requestId) {
        return new LinkService.VerifyRequest(code, discordId, "oyuncu#0", requestId, "discord");
    }

    private static LinkService.UnlinkRequest unlink(LinkService.Selector selector, String value, String expectedLinkId) {
        return new LinkService.UnlinkRequest(selector, value, expectedLinkId, List.of(), staff(), null,
                "discord_admin", UUID.randomUUID().toString());
    }

    private static LinkService.Actor staff() {
        return new LinkService.Actor("discord_staff", STAFF, "yetkili#0");
    }

    private static LinkService.LinkRecord linkedRecord(LinkService.VerifyResult result) {
        if (!(result instanceof LinkService.VerifyResult.Linked linked)) {
            throw new AssertionError("bağlantı bekleniyordu: " + result);
        }
        return linked.link();
    }

    private static void requireLinked(LinkService.VerifyResult result, UUID uuid, String discordId, boolean created) {
        LinkService.LinkRecord link = linkedRecord(result);
        LinkService.VerifyResult.Linked linked = (LinkService.VerifyResult.Linked) result;
        require(link.uuid().equals(uuid) && link.discordId().equals(discordId) && linked.created() == created,
                "beklenen UUID–Discord çifti değil: " + result);
    }

    private static void requireSameLink(Optional<LinkService.LinkRecord> actual, LinkService.LinkRecord expected, String message) {
        require(actual.isPresent() && actual.get().uuid().equals(expected.uuid())
                && actual.get().discordId().equals(expected.discordId())
                && actual.get().linkId().equals(expected.linkId()), message + ": " + actual);
    }

    private static void requireThrows(Class<? extends Throwable> type, ThrowingRunnable action, String message) {
        try {
            action.run();
        } catch (Throwable thrown) {
            if (type.isInstance(thrown)) return;
            throw new AssertionError(message + " (farklı hata: " + thrown + ")");
        }
        throw new AssertionError(message);
    }

    private static void awaitBlocked(AtomicReference<Thread> reference) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            Thread thread = reference.get();
            if (thread != null) {
                Thread.State state = thread.getState();
                if (state == Thread.State.BLOCKED || state == Thread.State.WAITING) return;
            }
            Thread.sleep(5);
        }
        throw new AssertionError("ikinci işlem kilitte beklemedi; yarış zorlanamadı");
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) throw new AssertionError("zamanlama kapısı açılmadı");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("zamanlama beklemesi kesildi");
        }
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

    /** İlk link commit'inde işlemi durduran tek kullanımlık kapı. */
    private static final class Gate {
        private final CountDownLatch entered = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);

        static Gate onLinkCommit(LinkService links) {
            Gate gate = new Gate();
            AtomicBoolean once = new AtomicBoolean();
            LinkService.TestHooks hooks = new LinkService.TestHooks();
            hooks.beforeLinkCommit = () -> {
                if (once.compareAndSet(false, true)) {
                    gate.entered.countDown();
                    await(gate.release);
                }
            };
            links.setTestHooks(hooks);
            return gate;
        }

        void awaitEntered() {
            await(this.entered);
        }

        void release() {
            this.release.countDown();
        }
    }
}
