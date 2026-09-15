package com.nautilus.discordlink;

import com.nautilus.storage.DataStore;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Eski/hatalı hesap bağlantıları için SALT-RAPOR aracı. Hiçbir bağlantıyı silmez
 * ya da "gerçek sahibini" tahmin etmez; kanıt gerektiren kayıtları listeler.
 *
 * DataStore açılışta şema geçişi yaptığı için yalnız veritabanının KOPYASI
 * üzerinde (sunucu kapalıyken alınmış) çalıştırılmalıdır.
 *
 *   java -cp "NautilusUHC-1.2.2-linkfix.jar:libraries/org/slf4j/slf4j-api/…/slf4j-api-….jar" \
 *        com.nautilus.discordlink.LinkConsistencyCheck nautilus-main.kopya.db [pending-link-codes.kopya.dat]
 */
public final class LinkConsistencyCheck {
    private LinkConsistencyCheck() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Kullanım: LinkConsistencyCheck <nautilus-main.db KOPYASI> [pending-link-codes.dat KOPYASI]");
            System.exit(2);
        }
        File database = new File(args[0]);
        if (!database.isFile()) {
            System.err.println("Veritabanı dosyası bulunamadı: " + database);
            System.exit(2);
        }
        Path pending = args.length > 1
                ? Path.of(args[1])
                : Files.createTempDirectory("nautilus-link-check-").resolve("pending-link-codes.dat");
        System.setProperty("nautilus.link.pending-file", pending.toAbsolutePath().toString());
        Logger.getLogger("").setLevel(Level.SEVERE);

        try (DataStore store = new DataStore(database, Logger.getLogger("NautilusUHC-LinkCheck"))) {
            LinkService.ConsistencyReport report = new LinkService(store).consistencyReport();
            System.out.println(LinkJson.write(toJson(report)));
        }
    }

    static Map<String, Object> toJson(LinkService.ConsistencyReport report) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("totalLinks", report.totalLinks());
        summary.put("duplicateNameLinks", report.duplicateNameLinks().size());
        summary.put("renamedLinks", report.renamedLinks().size());
        summary.put("nameTakenByOtherPlayer", report.nameTakenByOtherPlayer().size());
        summary.put("invalidDiscordIds", report.invalidDiscordIds().size());
        summary.put("unknownLinkTime", report.unknownLinkTime().size());
        summary.put("missingPlayerRecord", report.missingPlayerRecord().size());
        summary.put("pendingCodes", report.pendingCodes());
        summary.put("pendingCodesForLinkedPlayers", report.pendingCodesForLinkedPlayers());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tool", "NautilusUHC LinkConsistencyCheck 1.2.2");
        out.put("note", "Salt rapordur. Kayıtlar otomatik düzeltilmez; gerçek sahiplik ancak oyuncu/yetkili "
                + "kanıtıyla belirlenmeli. İsimle işlem yapılacak kayıtlarda UUID ya da Discord ID kullanın.");
        out.put("summary", summary);
        out.put("duplicateNameLinks", links(report.duplicateNameLinks()));
        out.put("renamedLinks", links(report.renamedLinks()));
        out.put("nameTakenByOtherPlayer", links(report.nameTakenByOtherPlayer()));
        out.put("invalidDiscordIds", links(report.invalidDiscordIds()));
        out.put("unknownLinkTime", links(report.unknownLinkTime()));
        out.put("missingPlayerRecord", links(report.missingPlayerRecord()));
        out.put("links", links(report.links()));
        return out;
    }

    private static List<Map<String, Object>> links(List<LinkService.LinkRecord> records) {
        return records.stream().map(LinkBridgeApi::linkJson).toList();
    }
}
