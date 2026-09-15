import com.nautilus.discordlink.LinkService;
import com.nautilus.storage.DataStore;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.logging.Logger;

/** Gerçek DataStore ile, Paper sunucusu olmadan çalıştırılan regresyon testi. */
public final class LinkServicePersistenceTest {
    private static final String PENDING_FILE_PROPERTY = "nautilus.link.pending-file";

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("nautilus-link-persistence-");
        Path database = root.resolve("nautilus-main.db");
        Path pending = root.resolve("pending-link-codes.dat");
        System.setProperty(PENDING_FILE_PROPERTY, pending.toString());

        UUID uuid = UUID.randomUUID();
        String code;
        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            LinkService links = new LinkService(store);
            code = links.issueCode(uuid, "Oyuncu1").code();
            require(Files.isRegularFile(pending), "kod verildiğinde dayanıklı kayıt oluşmalı");
            String persisted = Files.readString(pending, StandardCharsets.UTF_8);
            require(!persisted.contains(code), "ham tek kullanımlık kod diske yazılmamalı");
        }

        // 1.1.1'in v1 dosyasını taklit et; yükseltme bekleyen kodu kaybetmeden
        // okuyabilmeli ve ilk mutasyonda güncel biçime çevirmeli.
        String currentPending = Files.readAllLines(pending, StandardCharsets.UTF_8).stream()
                .filter(line -> line.startsWith("P\t"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("bekleyen kod satırı bulunamadı"));
        String[] fields = currentPending.split("\t", -1);
        Files.write(pending, java.util.List.of(
                "nautilus-link-codes-v1", String.join("\t", fields[1], fields[2], fields[3], fields[4])),
                StandardCharsets.UTF_8);

        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            LinkService afterRestart = new LinkService(store);
            require(afterRestart.pendingCodeCount() == 1,
                    "yeniden başlatılan servis bekleyen kodu yüklemeli");
            LinkService.VerifyResult result = afterRestart.verify(
                    "  " + code.toLowerCase(Locale.ROOT) + "  ", "424242", "oyuncu#0");
            require(result instanceof LinkService.VerifyResult.Linked,
                    "plugin yeniden başladıktan sonra geçerli kod doğrulanmalı, alınan: " + result);
            String receipt = Files.readString(pending, StandardCharsets.UTF_8);
            require(!receipt.contains(code), "başarı makbuzu ham link kodunu içermemeli");
            require(!receipt.contains("424242"), "başarı makbuzu ham Discord kimliğini içermemeli");
        }

        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            LinkService afterSecondRestart = new LinkService(store);
            require(afterSecondRestart.pendingCodeCount() == 0,
                    "kullanılan kodun kalıcı kaydı silinmeli");
            LinkService.VerifyResult replay = afterSecondRestart.verify(code, "424242", "oyuncu#0");
            require(replay instanceof LinkService.VerifyResult.Linked,
                    "aynı Discord hesabından yinelenen teslim önceki başarıyı dönmeli, alınan: " + replay);
            LinkService.VerifyResult stolenReplay = afterSecondRestart.verify(
                    code, "999999", "baska#0");
            require(stolenReplay instanceof LinkService.VerifyResult.InvalidCode,
                    "kullanılmış kod başka Discord hesabına başarı döndürmemeli, alınan: " + stolenReplay);
        }

        UUID concurrentUuid = UUID.randomUUID();
        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            // İki servis de kod üretilmeden önce açılmış olsun: sahadaki eski/stale
            // doğrulayıcı örneği bu durumda diskte sonradan oluşan kodu görmelidir.
            LinkService issuer = new LinkService(store);
            LinkService staleVerifier = new LinkService(store);
            String concurrentCode = issuer.issueCode(concurrentUuid, "OyuncuEszamanli").code();

            LinkService.VerifyResult firstDelivery = staleVerifier.verify(
                    concurrentCode, "626262", "eszamanli#0");
            require(firstDelivery instanceof LinkService.VerifyResult.Linked,
                    "önceden açılmış servis sonradan üretilen kodu diskten yenilemeli, alınan: "
                            + firstDelivery);

            LinkService.VerifyResult duplicateDelivery = issuer.verify(
                    concurrentCode, "626262", "eszamanli#0");
            require(duplicateDelivery instanceof LinkService.VerifyResult.Linked,
                    "başka servis örneğine düşen yinelenen teslim idempotent olmalı, alınan: "
                            + duplicateDelivery);
        }

        UUID raceUuid = UUID.randomUUID();
        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            LinkService firstVerifier = new LinkService(store);
            LinkService secondVerifier = new LinkService(store);
            String raceCode = firstVerifier.issueCode(raceUuid, "OyuncuYaris").code();
            CountDownLatch start = new CountDownLatch(1);
            ExecutorService workers = Executors.newFixedThreadPool(2);
            try {
                Future<LinkService.VerifyResult> first = workers.submit(() -> {
                    start.await();
                    return firstVerifier.verify(raceCode, "737373", "yaris#0");
                });
                Future<LinkService.VerifyResult> second = workers.submit(() -> {
                    start.await();
                    return secondVerifier.verify(raceCode, "737373", "yaris#0");
                });
                start.countDown();
                require(first.get() instanceof LinkService.VerifyResult.Linked,
                        "eşzamanlı ilk teslim başarılı olmalı");
                require(second.get() instanceof LinkService.VerifyResult.Linked,
                        "eşzamanlı yinelenen teslim de aynı başarıyı görmeli");
            } finally {
                workers.shutdownNow();
            }
        }

        UUID secondUuid = UUID.randomUUID();
        String oldCode;
        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            oldCode = new LinkService(store).issueCode(secondUuid, "Oyuncu2").code();
        }

        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            LinkService afterRestart = new LinkService(store);
            String replacement = afterRestart.issueCode(secondUuid, "Oyuncu2").code();
            require(!replacement.equals(oldCode),
                    "restart sonrası /link oyuncuya gösterilebilen yeni bir kod üretmeli");
            require(afterRestart.verify(oldCode, "525252", "oyuncu2#0")
                            instanceof LinkService.VerifyResult.InvalidCode,
                    "yenisi verildiğinde görünmeyen eski kod geçersizleşmeli");
            require(afterRestart.verify(replacement, "525252", "oyuncu2#0")
                            instanceof LinkService.VerifyResult.Linked,
                    "restart sonrası üretilen yeni kod çalışmalı");
        }

        Path crashRoot = Files.createTempDirectory("nautilus-link-crash-window-");
        System.setProperty(PENDING_FILE_PROPERTY,
                crashRoot.resolve("pending-link-codes.dat").toString());
        UUID crashUuid = UUID.randomUUID();
        try (DataStore store = new DataStore(
                crashRoot.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger())) {
            LinkService links = new LinkService(store);
            String crashCode = links.issueCode(crashUuid, "OyuncuCrash").code();
            // DB commit oldu fakat pending→receipt yazımı olmadan süreç öldü.
            store.linkCreate(new DataStore.LinkRow(
                    crashUuid, "OyuncuCrash", "111111", "ilk#0", System.currentTimeMillis()));

            LinkService.VerifyResult takeover = links.verify(crashCode, "222222", "ikinci#0");
            require(!(takeover instanceof LinkService.VerifyResult.Linked),
                    "yarım kalmış ilk doğrulamadan sonra başka Discord kodu devralmamalı");
            DataStore.LinkRow stillFirst = store.linkByUuid(crashUuid);
            require(stillFirst != null && "111111".equals(stillFirst.discordId()),
                    "Minecraft bağlantısı ilk Discord hesabında kalmalı");
        }

        Path missingRoot = Files.createTempDirectory("nautilus-link-missing-store-");
        Path missingPending = missingRoot.resolve("pending-link-codes.dat");
        System.setProperty(PENDING_FILE_PROPERTY, missingPending.toString());
        try (DataStore store = new DataStore(
                missingRoot.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger())) {
            LinkService links = new LinkService(store);
            String missingCode = links.issueCode(UUID.randomUUID(), "OyuncuMissing").code();
            Files.delete(missingPending);
            requireThrows(() -> links.verify(missingCode, "333333", "missing#0"),
                    "çalışırken kaybolan kod deposu invalid_code yerine altyapı hatası üretmeli");
        }

        Path malformedRoot = Files.createTempDirectory("nautilus-link-malformed-store-");
        Path malformedPending = malformedRoot.resolve("pending-link-codes.dat");
        System.setProperty(PENDING_FILE_PROPERTY, malformedPending.toString());
        try (DataStore store = new DataStore(
                malformedRoot.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger())) {
            LinkService links = new LinkService(store);
            String malformedCode = links.issueCode(UUID.randomUUID(), "OyuncuMalformed").code();
            Files.writeString(malformedPending,
                    "nautilus-link-codes-v2\nBOZUK-SATIR\n", StandardCharsets.UTF_8);
            requireThrows(() -> links.verify(malformedCode, "444444", "malformed#0"),
                    "bozuk kod deposu geçerli kodu invalid_code'a çevirmemeli");
        }

        Path dbFailureRoot = Files.createTempDirectory("nautilus-link-db-failure-");
        System.setProperty(PENDING_FILE_PROPERTY,
                dbFailureRoot.resolve("pending-link-codes.dat").toString());
        DataStore closedStore = new DataStore(
                dbFailureRoot.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger());
        LinkService closedLinks = new LinkService(closedStore);
        String replayCode = closedLinks.issueCode(UUID.randomUUID(), "OyuncuDb").code();
        require(closedLinks.verify(replayCode, "555555", "db#0")
                        instanceof LinkService.VerifyResult.Linked,
                "DB arıza testi öncesi ilk doğrulama başarılı olmalı");
        closedStore.close();
        requireThrows(() -> closedLinks.verify(replayCode, "555555", "db#0"),
                "başarı makbuzu okunurken DB arızası invalid_code olmamalı");

        System.out.println("PASS LinkServicePersistenceTest");
    }

    private static void requireThrows(Runnable action, String message) {
        try {
            action.run();
        } catch (IllegalStateException expected) {
            return;
        }
        throw new AssertionError(message);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
