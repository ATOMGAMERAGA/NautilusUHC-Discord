package com.nautilus.discordlink;

import com.nautilus.storage.DataStore;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/** Minecraft ve Discord arasındaki tek kullanımlık bağlantı kodlarını yönetir. */
public final class LinkService {
    private static final char[] ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ".toCharArray();
    private static final int CODE_LENGTH = 6;
    public static final long CODE_TTL_MILLIS = 600_000L;
    private static final String PENDING_FILE_PROPERTY = "nautilus.link.pending-file";
    private static final String FILE_HEADER = "nautilus-link-codes-v1";

    private final DataStore store;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, PendingCode> codes = new ConcurrentHashMap<>();
    private final Map<String, StoredCode> storedCodes = new ConcurrentHashMap<>();
    private final Path pendingFile;
    private LongSupplier clock = System::currentTimeMillis;

    public LinkService(DataStore dataStore) {
        this.store = dataStore;
        this.pendingFile = resolvePendingFile();
        loadPersisted();
        prune();
    }

    public void setClock(LongSupplier longSupplier) {
        this.clock = longSupplier;
    }

    private long now() {
        return this.clock.getAsLong();
    }

    public PendingCode issueCode(UUID uuid, String mcName) {
        synchronized (this) {
            prune();
            for (PendingCode pending : this.codes.values()) {
                if (pending.uuid().equals(uuid) && !pending.expired(now())) {
                    this.storedCodes.putIfAbsent(hash(pending.code()), StoredCode.from(pending));
                    persist();
                    return pending;
                }
            }

            // Yeniden başlatmadan kalan kaydın ham kodu bilinmediğinden /link
            // çağrısında o oyuncuya yeni bir kod ver ve önceki özeti geçersiz kıl.
            List<String> retiredDigests = this.storedCodes.entrySet().stream()
                    .filter(entry -> entry.getValue().uuid().equals(uuid))
                    .map(Map.Entry::getKey)
                    .toList();
            retiredDigests.forEach(this.storedCodes::remove);

            String code;
            String digest;
            do {
                code = randomCode();
                digest = hash(code);
            } while (this.codes.containsKey(code)
                    || this.storedCodes.containsKey(digest)
                    || retiredDigests.contains(digest));
            PendingCode pending = new PendingCode(code, uuid, mcName, now() + CODE_TTL_MILLIS);
            this.codes.put(code, pending);
            this.storedCodes.put(digest, StoredCode.from(pending));
            persist();
            return pending;
        }
    }

    private String randomCode() {
        StringBuilder result = new StringBuilder(CODE_LENGTH);
        for (int i = 0; i < CODE_LENGTH; ++i) {
            result.append(ALPHABET[this.random.nextInt(ALPHABET.length)]);
        }
        return result.toString();
    }

    private synchronized void prune() {
        long now = now();
        boolean changed = this.codes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        changed |= this.storedCodes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        if (changed) {
            persist();
        }
    }

    public synchronized VerifyResult verify(String rawCode, String discordId, String discordTag) {
        String code = normalize(rawCode);
        String digest = hash(code);
        PendingCode inMemory = this.codes.get(code);
        StoredCode pending = storedCode(inMemory, digest);
        if (pending == null) {
            return new VerifyResult.InvalidCode();
        }
        if (pending.expired(now())) {
            removeCode(code, digest);
            return new VerifyResult.ExpiredCode();
        }

        DataStore.LinkRow existing = this.store.linkByDiscord(discordId);
        if (existing != null && !existing.uuid().equals(pending.uuid())) {
            return new VerifyResult.DiscordAlreadyLinked(existing);
        }

        removeCode(code, digest);
        DataStore.LinkRow row = new DataStore.LinkRow(
                pending.uuid(), pending.mcName(), discordId, discordTag, now());
        this.store.linkCreate(row);
        return new VerifyResult.Linked(row);
    }

    private StoredCode storedCode(PendingCode inMemory, String digest) {
        if (inMemory != null) {
            StoredCode value = StoredCode.from(inMemory);
            this.storedCodes.putIfAbsent(digest, value);
            return value;
        }
        return this.storedCodes.get(digest);
    }

    private void removeCode(String code, String digest) {
        this.codes.remove(code);
        this.storedCodes.remove(digest);
        persist();
    }

    public synchronized int pendingCodeCount() {
        prune();
        return this.storedCodes.size();
    }

    public boolean isLinked(UUID uuid) {
        return this.store.linkByUuid(uuid) != null;
    }

    public Optional<DataStore.LinkRow> byUuid(UUID uuid) {
        return Optional.ofNullable(this.store.linkByUuid(uuid));
    }

    public Optional<DataStore.LinkRow> byDiscord(String discordId) {
        return Optional.ofNullable(this.store.linkByDiscord(discordId));
    }

    public Optional<DataStore.LinkRow> byName(String name) {
        return Optional.ofNullable(this.store.linkByName(name));
    }

    public Optional<DataStore.LinkRow> unlink(String type, String value) {
        DataStore.LinkRow row = "dc".equalsIgnoreCase(type)
                ? this.store.linkByDiscord(value)
                : this.store.linkByName(value);
        if (row == null) {
            return Optional.empty();
        }
        return this.store.linkDelete(row.uuid()) ? Optional.of(row) : Optional.empty();
    }

    private void loadPersisted() {
        if (!Files.isRegularFile(this.pendingFile)) {
            return;
        }
        try {
            for (String line : Files.readAllLines(this.pendingFile, StandardCharsets.UTF_8)) {
                loadLine(line);
            }
        } catch (IOException error) {
            System.err.println("[NautilusUHC] Bekleyen bağlantı kodları okunamadı: "
                    + error.getClass().getSimpleName());
        }
    }

    private void loadLine(String line) {
        if (line.isBlank() || FILE_HEADER.equals(line)) {
            return;
        }
        try {
            String[] fields = line.split("\\t", -1);
            if (fields.length != 4 || !fields[0].matches("[A-Za-z0-9_-]{43}")) {
                return;
            }
            UUID uuid = UUID.fromString(fields[1]);
            String mcName = new String(
                    Base64.getUrlDecoder().decode(fields[2]), StandardCharsets.UTF_8);
            long expiresAt = Long.parseLong(fields[3]);
            this.storedCodes.put(fields[0], new StoredCode(uuid, mcName, expiresAt));
        } catch (IllegalArgumentException ignored) {
            // Tek bir bozuk satır diğer geçerli kodların yüklenmesini engellemesin.
        }
    }

    private void persist() {
        try {
            Path parent = this.pendingFile.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Path temporary = this.pendingFile.resolveSibling(
                    this.pendingFile.getFileName().toString() + ".tmp");
            List<String> lines = new ArrayList<>();
            lines.add(FILE_HEADER);
            this.storedCodes.entrySet().stream()
                    .sorted(Comparator.comparing(Map.Entry::getKey))
                    .map(entry -> encode(entry.getKey(), entry.getValue()))
                    .forEach(lines::add);
            Files.write(temporary, lines, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING,
                    StandardOpenOption.WRITE);
            try {
                Files.move(temporary, this.pendingFile, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, this.pendingFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException error) {
            // Ham kodu veya dosya içeriğini hiçbir zaman loglama.
            System.err.println("[NautilusUHC] Bekleyen bağlantı kodları kaydedilemedi: "
                    + error.getClass().getSimpleName());
        }
    }

    private static String encode(String digest, StoredCode value) {
        String name = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.mcName().getBytes(StandardCharsets.UTF_8));
        return digest + '\t' + value.uuid() + '\t' + name + '\t' + value.expiresAt();
    }

    private static String normalize(String raw) {
        return raw == null ? "" : raw.trim().toUpperCase(Locale.ROOT);
    }

    private static String hash(String code) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(code.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 kullanılamıyor", impossible);
        }
    }

    private static Path resolvePendingFile() {
        String configured = System.getProperty(PENDING_FILE_PROPERTY, "").trim();
        if (!configured.isEmpty()) {
            return Path.of(configured).toAbsolutePath().normalize();
        }
        return Path.of("plugins", "NautilusUHC", "pending-link-codes.dat")
                .toAbsolutePath().normalize();
    }

    public record PendingCode(String code, UUID uuid, String mcName, long expiresAt) {
        public boolean expired(long now) {
            return now >= this.expiresAt;
        }
    }

    private record StoredCode(UUID uuid, String mcName, long expiresAt) {
        private static StoredCode from(PendingCode code) {
            return new StoredCode(code.uuid(), code.mcName(), code.expiresAt());
        }

        private boolean expired(long now) {
            return now >= this.expiresAt;
        }
    }

    public sealed interface VerifyResult {
        record DiscordAlreadyLinked(DataStore.LinkRow existing) implements VerifyResult { }

        record ExpiredCode() implements VerifyResult { }

        record InvalidCode() implements VerifyResult { }

        record Linked(DataStore.LinkRow row) implements VerifyResult { }
    }
}
