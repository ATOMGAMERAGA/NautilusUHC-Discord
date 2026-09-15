package com.nautilus.bridge;

import org.bukkit.plugin.Plugin;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Bu Minecraft sürecinin köprü kimliği.
 *
 * bridge.instance-id boşsa 1.2.1 her class yüklemesinde yeni rastgele kimlik
 * üretiyordu; restart sonrası eski kimlik bot tarafında bağlantı penceresi
 * boyunca "ikinci instance" gibi görünüyordu. 1.2.2 otomatik kimliği veri
 * klasöründe kalıcı tutar. Klasörü kopyalanan iki sunucu aynı kimliği taşırsa
 * bot eşzamanlı yoklamaları görüp hesap bağlamayı açık bir hatayla durdurur;
 * böyle kurulumlarda her sunucuya farklı bridge.instance-id verilmelidir.
 */
public final class BridgeInstance {
    private static final String FILE_NAME = "bridge-instance-id";
    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9._:-]{1,64}");
    private static final String EPHEMERAL = "auto-" + UUID.randomUUID().toString().substring(0, 8);
    private static final Object LOCK = new Object();
    private static volatile String persisted;

    private BridgeInstance() {
    }

    public static String id(Plugin plugin) {
        String configured = plugin.getConfig().getString("bridge.instance-id", "");
        if (configured != null && !configured.trim().isEmpty()) {
            String trimmed = configured.trim();
            return trimmed.substring(0, Math.min(64, trimmed.length()));
        }
        String cached = persisted;
        if (cached != null) {
            return cached;
        }
        synchronized (LOCK) {
            if (persisted == null) {
                persisted = loadOrCreate(plugin);
            }
            return persisted;
        }
    }

    private static String loadOrCreate(Plugin plugin) {
        try {
            File folder = plugin.getDataFolder();
            Path file = folder.toPath().resolve(FILE_NAME);
            if (Files.isRegularFile(file)) {
                String stored = Files.readString(file, StandardCharsets.UTF_8).trim();
                if (VALID.matcher(stored).matches()) {
                    return stored;
                }
                plugin.getLogger().warning(FILE_NAME + " dosyası geçersiz; yeni köprü kimliği üretiliyor.");
            }
            String created = "auto-" + UUID.randomUUID().toString().substring(0, 8);
            Files.createDirectories(folder.toPath());
            Path temporary = file.resolveSibling(FILE_NAME + ".tmp");
            Files.writeString(temporary, created + System.lineSeparator(), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
            plugin.getLogger().info("bridge.instance-id boş; kalıcı köprü kimliği üretildi: " + created
                    + " (plugins/NautilusUHC/" + FILE_NAME + ").");
            return created;
        } catch (IOException | RuntimeException error) {
            plugin.getLogger().warning("Kalıcı köprü kimliği yazılamadı (" + error.getMessage()
                    + "); bu süreç için geçici kimlik kullanılıyor: " + EPHEMERAL
                    + ". Kalıcı çözüm: config.yml > bridge.instance-id ayarla.");
            return EPHEMERAL;
        }
    }
}
