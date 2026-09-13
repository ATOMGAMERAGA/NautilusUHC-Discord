import com.nautilus.discordlink.LinkService;
import com.nautilus.storage.DataStore;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.logging.Logger;

/** /link kodu yenileme ve oyuncular arası benzersizlik regresyon testi. */
public final class LinkServiceRotationTest {
    private static final String PENDING_FILE_PROPERTY = "nautilus.link.pending-file";

    public static void main(String[] args) throws Exception {
        repeatedCommandRotatesCode();
        replacementRevokesCodeInStaleService();
        differentPlayersHaveDifferentActiveCodes();
        System.out.println("PASS LinkServiceRotationTest");
    }

    private static void repeatedCommandRotatesCode() throws Exception {
        Path root = Files.createTempDirectory("nautilus-link-rotation-");
        System.setProperty(PENDING_FILE_PROPERTY,
                root.resolve("pending-link-codes.dat").toString());
        UUID uuid = UUID.randomUUID();

        try (DataStore store = new DataStore(
                root.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger())) {
            LinkService links = new LinkService(store);
            String first = links.issueCode(uuid, "OyuncuTekrar").code();
            String replacement = links.issueCode(uuid, "OyuncuTekrar").code();

            require(!replacement.equals(first),
                    "aynı oyuncunun her /link çağrısı yeni kod üretmeli");
            require(links.verify(first, "101010", "tekrar#0")
                            instanceof LinkService.VerifyResult.InvalidCode,
                    "yeni kod verildiğinde önceki kod anında geçersizleşmeli");
            require(links.verify(replacement, "101010", "tekrar#0")
                            instanceof LinkService.VerifyResult.Linked,
                    "oyuncuya en son gösterilen kod doğrulanmalı");
        }
    }

    private static void replacementRevokesCodeInStaleService() throws Exception {
        Path root = Files.createTempDirectory("nautilus-link-stale-rotation-");
        System.setProperty(PENDING_FILE_PROPERTY,
                root.resolve("pending-link-codes.dat").toString());
        UUID uuid = UUID.randomUUID();

        try (DataStore store = new DataStore(
                root.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger())) {
            LinkService firstService = new LinkService(store);
            String first = firstService.issueCode(uuid, "OyuncuStale").code();
            LinkService replacingService = new LinkService(store);
            String replacement = replacingService.issueCode(uuid, "OyuncuStale").code();

            require(!replacement.equals(first),
                    "başka servis örneğinin ürettiği kod da yeni olmalı");
            require(firstService.verify(first, "202020", "stale#0")
                            instanceof LinkService.VerifyResult.InvalidCode,
                    "eski servis örneği iptal edilen kodu doğrulamamalı");
            require(firstService.verify(replacement, "202020", "stale#0")
                            instanceof LinkService.VerifyResult.Linked,
                    "eski servis örneği diskteki en yeni kodu doğrulayabilmeli");
        }
    }

    private static void differentPlayersHaveDifferentActiveCodes() throws Exception {
        Path root = Files.createTempDirectory("nautilus-link-unique-");
        System.setProperty(PENDING_FILE_PROPERTY,
                root.resolve("pending-link-codes.dat").toString());

        try (DataStore store = new DataStore(
                root.resolve("nautilus-main.db").toFile(), Logger.getAnonymousLogger())) {
            LinkService links = new LinkService(store);
            String first = links.issueCode(UUID.randomUUID(), "OyuncuBir").code();
            String second = links.issueCode(UUID.randomUUID(), "OyuncuIki").code();

            require(!second.equals(first),
                    "iki oyuncunun aynı anda geçerli kodları aynı olmamalı");
            require(links.pendingCodeCount() == 2,
                    "iki oyuncunun kodu da birbirinden bağımsız beklemeli");
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
