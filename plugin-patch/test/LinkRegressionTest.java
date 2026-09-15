import com.nautilus.discordlink.LinkService;
import com.nautilus.storage.DataStore;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * 1.2.1'de kanıtlanan hesap eşleme hatalarının regresyon testi.
 *
 * Yalnız 1.2.1'de de bulunan genel API'yi (issueCode, verify, unlink, byName,
 * byDiscord) kullanır. Böylece aynı test hatalı JAR'a karşı FAIL, düzeltilmiş
 * JAR'a karşı PASS verir; her senaryo ayrı raporlanır.
 */
public final class LinkRegressionTest {
    private static final String PENDING_FILE_PROPERTY = "nautilus.link.pending-file";
    private static final String DISCORD_X = "111111111111111111";
    private static final String DISCORD_Y = "222222222222222222";
    private static final List<String> FAILURES = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        // DataStore hata yuttuğunda WARNING basar; test çıktısını okunur tut.
        Logger.getLogger("").setLevel(Level.SEVERE);
        scenario("R1 unlink öncesi üretilmiş kod, unlink sonrası başka Discord hesabını bağlayamaz",
                LinkRegressionTest::staleCodeAfterUnlink);
        scenario("R2 DB commit/kod tüketimi arasında kalan kod, unlink sonrası hesabı başka Discord'a devredemez",
                LinkRegressionTest::crashWindowCodeAfterUnlink);
        scenario("R3 aynı ada sahip iki bağlantıda isimle unlink rastgele kayıt silmez",
                LinkRegressionTest::ambiguousNameUnlink);
        scenario("R4 aynı ada sahip iki bağlantıda isimle sorgu rastgele kayıt döndürmez",
                LinkRegressionTest::ambiguousNameLookup);
        scenario("R5 DB arızası unlink'te 'bağlantı bulunamadı' diye maskelenmez",
                LinkRegressionTest::unlinkDbFailureNotMasked);
        scenario("R6 DB arızası Discord durum sorgusunda 'bağlı değil' diye maskelenmez",
                LinkRegressionTest::statusDbFailureNotMasked);

        if (!FAILURES.isEmpty()) {
            System.out.println("FAIL LinkRegressionTest (" + FAILURES.size() + " senaryo)");
            FAILURES.forEach(failure -> System.out.println("  - " + failure));
            System.exit(1);
        }
        System.out.println("PASS LinkRegressionTest");
    }

    private static void staleCodeAfterUnlink() throws Exception {
        try (DataStore store = open("r1")) {
            LinkService links = new LinkService(store);
            UUID player = UUID.randomUUID();
            String first = links.issueCode(player, "OyuncuA").code();
            require(links.verify(first, DISCORD_X, "x#0") instanceof LinkService.VerifyResult.Linked,
                    "ön koşul: A↔X bağlanmalı");
            // 1.2.1'de /link'in bağlılık okuması SQL hatasını null'a çevirir; bağlı
            // oyuncuya da kod verilebilir. Aynı durum çökme penceresinde de oluşur.
            String stale = links.issueCode(player, "OyuncuA").code();
            require(links.unlink("dc", DISCORD_X).isPresent(), "ön koşul: unlink başarılı olmalı");

            LinkService.VerifyResult late = links.verify(stale, DISCORD_Y, "y#0");
            DataStore.LinkRow row = store.linkByUuid(player);
            require(!(late instanceof LinkService.VerifyResult.Linked) && row == null,
                    "unlink öncesi kod sonradan başka Discord hesabını bağladı: sonuç=" + late
                            + " kayıt=" + row);
        }
    }

    private static void crashWindowCodeAfterUnlink() throws Exception {
        try (DataStore store = open("r2")) {
            LinkService links = new LinkService(store);
            UUID player = UUID.randomUUID();
            String code = links.issueCode(player, "OyuncuCrash").code();
            // DB commit oldu, pending→makbuz yazımı olmadan süreç öldü.
            store.linkCreate(new DataStore.LinkRow(
                    player, "OyuncuCrash", DISCORD_X, "ilk#0", System.currentTimeMillis()));

            LinkService restarted = new LinkService(store);
            LinkService.VerifyResult delayed = restarted.verify(code, DISCORD_Y, "ikinci#0");
            require(!(delayed instanceof LinkService.VerifyResult.Linked),
                    "ön koşul: bağlıyken başka Discord kodu kullanamamalı, sonuç=" + delayed);
            require(restarted.unlink("dc", DISCORD_X).isPresent(), "ön koşul: unlink başarılı olmalı");

            LinkService.VerifyResult afterUnlink = restarted.verify(code, DISCORD_Y, "ikinci#0");
            DataStore.LinkRow row = store.linkByUuid(player);
            require(!(afterUnlink instanceof LinkService.VerifyResult.Linked) && row == null,
                    "unlink sonrası eski kod hesabı başka Discord'a devretti: sonuç=" + afterUnlink
                            + " kayıt=" + row);
        }
    }

    private static void ambiguousNameUnlink() throws Exception {
        try (DataStore store = open("r3")) {
            UUID renamed = UUID.randomUUID();
            UUID current = UUID.randomUUID();
            // Eski "Ali" sonradan isim değiştirdi; ismi başka bir oyuncu aldı ve o da bağlandı.
            store.linkCreate(new DataStore.LinkRow(renamed, "Ali", DISCORD_X, "eski#0", 1_000L));
            store.linkCreate(new DataStore.LinkRow(current, "ali", DISCORD_Y, "yeni#0", 2_000L));
            LinkService links = new LinkService(store);

            boolean refused = false;
            Optional<DataStore.LinkRow> removed = Optional.empty();
            try {
                removed = links.unlink("mc", "Ali");
            } catch (IllegalStateException expected) {
                refused = true;
            }
            require(store.linkByUuid(renamed) != null && store.linkByUuid(current) != null,
                    "belirsiz isimle bir bağlantı silindi: " + removed);
            require(refused, "belirsiz isim açıkça reddedilmeli (sessizce 'yok' denmemeli)");
        }
    }

    private static void ambiguousNameLookup() throws Exception {
        try (DataStore store = open("r4")) {
            store.linkCreate(new DataStore.LinkRow(UUID.randomUUID(), "Veli", DISCORD_X, "eski#0", 1_000L));
            store.linkCreate(new DataStore.LinkRow(UUID.randomUUID(), "VELI", DISCORD_Y, "yeni#0", 2_000L));
            LinkService links = new LinkService(store);
            Optional<DataStore.LinkRow> found = Optional.empty();
            boolean refused = false;
            try {
                found = links.byName("veli");
            } catch (IllegalStateException expected) {
                refused = true;
            }
            require(refused, "belirsiz isimde rastgele bir bağlantı döndü: " + found);
        }
    }

    private static void unlinkDbFailureNotMasked() throws Exception {
        Path root = Files.createTempDirectory("nautilus-link-regression-r5-");
        System.setProperty(PENDING_FILE_PROPERTY, root.resolve("pending-link-codes.dat").toString());
        DataStore store = new DataStore(root.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger());
        LinkService links = new LinkService(store);
        String code = links.issueCode(UUID.randomUUID(), "OyuncuDb").code();
        require(links.verify(code, DISCORD_X, "db#0") instanceof LinkService.VerifyResult.Linked,
                "ön koşul: bağlantı kurulmalı");
        store.close();

        boolean threw = false;
        Optional<DataStore.LinkRow> result = null;
        try {
            result = links.unlink("dc", DISCORD_X);
        } catch (IllegalStateException expected) {
            threw = true;
        }
        require(threw, "DB kapalıyken unlink altyapı hatası yerine sonuç döndürdü: " + result);
    }

    private static void statusDbFailureNotMasked() throws Exception {
        Path root = Files.createTempDirectory("nautilus-link-regression-r6-");
        System.setProperty(PENDING_FILE_PROPERTY, root.resolve("pending-link-codes.dat").toString());
        DataStore store = new DataStore(root.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger());
        LinkService links = new LinkService(store);
        String code = links.issueCode(UUID.randomUUID(), "OyuncuDurum").code();
        require(links.verify(code, DISCORD_X, "durum#0") instanceof LinkService.VerifyResult.Linked,
                "ön koşul: bağlantı kurulmalı");
        store.close();

        boolean threw = false;
        Optional<DataStore.LinkRow> result = null;
        try {
            result = links.byDiscord(DISCORD_X);
        } catch (IllegalStateException expected) {
            threw = true;
        }
        require(threw, "DB kapalıyken durum sorgusu 'bağlı değil' gibi boş sonuç döndürdü: " + result);
    }

    private static DataStore open(String name) throws Exception {
        Path root = Files.createTempDirectory("nautilus-link-regression-" + name + "-");
        System.setProperty(PENDING_FILE_PROPERTY, root.resolve("pending-link-codes.dat").toString());
        return new DataStore(root.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger());
    }

    private static void scenario(String name, ThrowingRunnable body) {
        try {
            body.run();
            System.out.println("  ok   " + name);
        } catch (Throwable failure) {
            System.out.println("  FAIL " + name + ": " + failure.getMessage());
            FAILURES.add(name);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
