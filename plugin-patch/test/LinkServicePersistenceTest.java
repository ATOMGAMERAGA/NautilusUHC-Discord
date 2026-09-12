import com.nautilus.discordlink.LinkService;
import com.nautilus.storage.DataStore;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.UUID;
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

        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            LinkService afterRestart = new LinkService(store);
            require(afterRestart.pendingCodeCount() == 1,
                    "yeniden başlatılan servis bekleyen kodu yüklemeli");
            LinkService.VerifyResult result = afterRestart.verify(
                    "  " + code.toLowerCase(Locale.ROOT) + "  ", "424242", "oyuncu#0");
            require(result instanceof LinkService.VerifyResult.Linked,
                    "plugin yeniden başladıktan sonra geçerli kod doğrulanmalı, alınan: " + result);
        }

        try (DataStore store = new DataStore(database.toFile(), Logger.getAnonymousLogger())) {
            LinkService afterSecondRestart = new LinkService(store);
            require(afterSecondRestart.pendingCodeCount() == 0,
                    "kullanılan kodun kalıcı kaydı silinmeli");
            LinkService.VerifyResult replay = afterSecondRestart.verify(code, "424242", "oyuncu#0");
            require(replay instanceof LinkService.VerifyResult.InvalidCode,
                    "başarılı kod tek kullanımlık kalmalı, alınan: " + replay);
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

        System.out.println("PASS LinkServicePersistenceTest");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
