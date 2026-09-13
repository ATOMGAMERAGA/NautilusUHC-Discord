package com.nautilus.discordlink;

import com.nautilus.storage.DataStore;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
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
import java.util.HashMap;
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
    private static final long REPLAY_TTL_MILLIS = 600_000L;
    private static final String PENDING_FILE_PROPERTY = "nautilus.link.pending-file";
    private static final String FILE_HEADER_V1 = "nautilus-link-codes-v1";
    private static final String FILE_HEADER = "nautilus-link-codes-v2";
    private static final String STORE_MARKER = "nautilus-link-store-initialized-v1";

    private final DataStore store;
    private final LinkStoreAccess linkStore;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, PendingCode> codes = new ConcurrentHashMap<>();
    private final Map<String, StoredCode> storedCodes = new ConcurrentHashMap<>();
    private final Map<String, UsedCode> usedCodes = new ConcurrentHashMap<>();
    private final Path pendingFile;
    private final Path lockFile;
    private final Path markerFile;
    private final Object fileMutex;
    private LongSupplier clock = System::currentTimeMillis;

    public LinkService(DataStore dataStore) {
        this.store = dataStore;
        this.linkStore = new LinkStoreAccess(dataStore);
        this.pendingFile = resolvePendingFile();
        this.lockFile = this.pendingFile.resolveSibling(
                this.pendingFile.getFileName().toString() + ".lock");
        this.markerFile = this.pendingFile.resolveSibling(
                this.pendingFile.getFileName().toString() + ".initialized");
        // String havuzu JVM genelinde ortaktır; aynı JAR'ın iki classloader ile
        // açıldığı durumda bile FileLock çağrılarının birbiriyle çakışmasını önler.
        this.fileMutex = this.pendingFile.toString().toLowerCase(Locale.ROOT).intern();
        boolean freshStore = !Files.exists(this.pendingFile)
                && !Files.exists(this.markerFile)
                && !Files.exists(temporaryFile());
        withFileLock(() -> {
            if (freshStore && !Files.exists(this.pendingFile)) {
                persist();
            } else {
                refreshPersisted();
                ensureMarker();
            }
            if (pruneUnlocked()) {
                persist();
            }
            return null;
        });
    }

    public void setClock(LongSupplier longSupplier) {
        this.clock = longSupplier;
    }

    private long now() {
        return this.clock.getAsLong();
    }

    public PendingCode issueCode(UUID uuid, String mcName) {
        synchronized (this) {
            return withFileLock(() -> {
                refreshPersisted();
                pruneUnlocked();
                for (PendingCode pending : this.codes.values()) {
                    if (pending.uuid().equals(uuid) && !pending.expired(now())) {
                        this.storedCodes.putIfAbsent(hash(pending.code()), StoredCode.from(pending));
                        persist();
                        return pending;
                    }
                }

                // Yeniden başlatmadan kalan kaydın ham kodu bilinmediğinden /link
                // çağrısında o oyuncuya yeni bir kod ver ve önceki özeti geçersiz kıl.
                List<String> retiredDigests = new ArrayList<>();
                this.storedCodes.entrySet().stream()
                        .filter(entry -> entry.getValue().uuid().equals(uuid))
                        .map(Map.Entry::getKey)
                        .forEach(retiredDigests::add);
                this.usedCodes.entrySet().stream()
                        .filter(entry -> entry.getValue().uuid().equals(uuid))
                        .map(Map.Entry::getKey)
                        .forEach(retiredDigests::add);
                retiredDigests.forEach(this.storedCodes::remove);
                retiredDigests.forEach(this.usedCodes::remove);

                String code;
                String digest;
                do {
                    code = randomCode();
                    digest = hash(code);
                } while (this.codes.containsKey(code)
                        || this.storedCodes.containsKey(digest)
                        || this.usedCodes.containsKey(digest)
                        || retiredDigests.contains(digest));
                PendingCode pending = new PendingCode(code, uuid, mcName,
                        now() + CODE_TTL_MILLIS);
                this.codes.put(code, pending);
                this.storedCodes.put(digest, StoredCode.from(pending));
                persist();
                return pending;
            });
        }
    }

    private String randomCode() {
        StringBuilder result = new StringBuilder(CODE_LENGTH);
        for (int i = 0; i < CODE_LENGTH; ++i) {
            result.append(ALPHABET[this.random.nextInt(ALPHABET.length)]);
        }
        return result.toString();
    }

    private boolean pruneUnlocked() {
        long now = now();
        boolean changed = this.codes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        changed |= this.storedCodes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        changed |= this.usedCodes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        return changed;
    }

    public synchronized VerifyResult verify(String rawCode, String discordId, String discordTag) {
        return withFileLock(() -> {
            refreshPersisted();
            String code = normalize(rawCode);
            String digest = hash(code);
            PendingCode inMemory = this.codes.get(code);
            StoredCode pending = storedCode(inMemory, digest);
            if (pending == null) {
                return replayResult(digest, discordId);
            }
            if (pending.expired(now())) {
                removePendingCode(code, digest);
                persist();
                return new VerifyResult.ExpiredCode();
            }

            DataStore.LinkRow row = new DataStore.LinkRow(
                    pending.uuid(), pending.mcName(), discordId, discordTag, now());
            LinkStoreAccess.CreateResult create = this.linkStore.createIfAbsent(row);
            if (create.state() == LinkStoreAccess.CreateState.DISCORD_ALREADY_LINKED) {
                return new VerifyResult.DiscordAlreadyLinked(create.row());
            }
            if (create.state() == LinkStoreAccess.CreateState.UUID_ALREADY_LINKED) {
                // Kod daha önce başka bir Discord hesabınca kullanılmış olabilir.
                // DataStore'un eski upsert davranışına asla düşüp bağı devralma.
                return new VerifyResult.InvalidCode();
            }

            removePendingCode(code, digest);
            this.usedCodes.put(digest, new UsedCode(
                    pending.uuid(), hash(discordId), now() + REPLAY_TTL_MILLIS));
            persist();
            return new VerifyResult.Linked(create.row());
        });
    }

    private VerifyResult replayResult(String digest, String discordId) {
        UsedCode used = this.usedCodes.get(digest);
        if (used == null) {
            return new VerifyResult.InvalidCode();
        }
        if (used.expired(now())) {
            this.usedCodes.remove(digest);
            persist();
            return new VerifyResult.InvalidCode();
        }
        if (!MessageDigest.isEqual(
                used.discordDigest().getBytes(StandardCharsets.US_ASCII),
                hash(discordId).getBytes(StandardCharsets.US_ASCII))) {
            return new VerifyResult.InvalidCode();
        }
        // DataStore'un normal sorguları SQL hatasını null'a çevirir. Burada
        // hata yutmayan sorgu kullanılır; altyapı arızası invalid_code olamaz.
        DataStore.LinkRow linked = this.linkStore.byDiscord(discordId);
        if (linked == null || !linked.uuid().equals(used.uuid())) {
            return new VerifyResult.InvalidCode();
        }
        return new VerifyResult.Linked(linked);
    }

    private StoredCode storedCode(PendingCode inMemory, String digest) {
        if (inMemory != null) {
            StoredCode value = StoredCode.from(inMemory);
            this.storedCodes.putIfAbsent(digest, value);
            return value;
        }
        return this.storedCodes.get(digest);
    }

    private void removePendingCode(String code, String digest) {
        this.codes.remove(code);
        this.storedCodes.remove(digest);
    }

    public synchronized int pendingCodeCount() {
        return withFileLock(() -> {
            refreshPersisted();
            if (pruneUnlocked()) {
                persist();
            }
            return this.storedCodes.size();
        });
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

    private void refreshPersisted() throws IOException {
        Map<String, StoredCode> pendingSnapshot = new HashMap<>();
        Map<String, UsedCode> usedSnapshot = new HashMap<>();
        Path source = this.pendingFile;
        boolean recoverTemporary = false;
        if (!Files.isRegularFile(source)) {
            if (Files.exists(source)) {
                throw new IOException("Bağlantı kodu deposu normal bir dosya değil");
            }
            Path temporary = temporaryFile();
            if (!Files.isRegularFile(temporary)) {
                throw new IOException("Başlatılmış bağlantı kodu deposu kayıp");
            }
            source = temporary;
            recoverTemporary = true;
        }

        List<String> lines = Files.readAllLines(source, StandardCharsets.UTF_8);
        if (lines.isEmpty()) {
            throw new IOException("Bağlantı kodu deposu boş");
        }
        String header = lines.get(0);
        if (!FILE_HEADER.equals(header) && !FILE_HEADER_V1.equals(header)) {
            throw new IOException("Bağlantı kodu deposu sürümü geçersiz");
        }
        for (int index = 1; index < lines.size(); index++) {
            String line = lines.get(index);
            if (!line.isBlank()) {
                loadLine(header, line, index + 1, pendingSnapshot, usedSnapshot);
            }
        }
        if (recoverTemporary) {
            try {
                Files.move(source, this.pendingFile, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(source, this.pendingFile, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        this.storedCodes.clear();
        this.storedCodes.putAll(pendingSnapshot);
        this.usedCodes.clear();
        this.usedCodes.putAll(usedSnapshot);
        // Dosya doğruluk kaynağıdır. Başka bir doğrulayıcı kodu tükettiyse bu
        // örnekte kalan ham kod tekrar kullanılamaz.
        this.codes.entrySet().removeIf(entry -> {
            StoredCode stored = this.storedCodes.get(hash(entry.getKey()));
            return stored == null || !stored.uuid().equals(entry.getValue().uuid());
        });
    }

    private void loadLine(String header, String line, int lineNumber,
                          Map<String, StoredCode> pendingSnapshot,
                          Map<String, UsedCode> usedSnapshot) throws IOException {
        try {
            String[] fields = line.split("\\t", -1);
            // v1: digest, uuid, base64(mcName), expiresAt
            if (FILE_HEADER_V1.equals(header) && fields.length == 4
                    && fields[0].matches("[A-Za-z0-9_-]{43}")) {
                UUID uuid = UUID.fromString(fields[1]);
                String mcName = decode(fields[2]);
                long expiresAt = Long.parseLong(fields[3]);
                pendingSnapshot.put(fields[0], new StoredCode(uuid, mcName, expiresAt));
                return;
            }
            // v2 pending: P, digest, uuid, base64(mcName), expiresAt
            if (FILE_HEADER.equals(header) && fields.length == 5 && "P".equals(fields[0])
                    && fields[1].matches("[A-Za-z0-9_-]{43}")) {
                pendingSnapshot.put(fields[1], new StoredCode(
                        UUID.fromString(fields[2]), decode(fields[3]), Long.parseLong(fields[4])));
                return;
            }
            // v2 receipt: R, codeDigest, uuid, discordDigest, expiresAt
            if (FILE_HEADER.equals(header) && fields.length == 5 && "R".equals(fields[0])
                    && fields[1].matches("[A-Za-z0-9_-]{43}")
                    && fields[3].matches("[A-Za-z0-9_-]{43}")) {
                usedSnapshot.put(fields[1], new UsedCode(
                        UUID.fromString(fields[2]), fields[3], Long.parseLong(fields[4])));
                return;
            }
            throw new IllegalArgumentException("tanınmayan kayıt biçimi");
        } catch (IllegalArgumentException error) {
            // İçeriği (kod özeti dahil) hata mesajına veya loga koyma.
            throw new IOException("Bağlantı kodu deposunda bozuk kayıt: satır "
                    + lineNumber, error);
        }
    }

    private void persist() {
        try {
            Path parent = this.pendingFile.getParent();
            if (parent != null) Files.createDirectories(parent);
            Path temporary = temporaryFile();
            List<String> lines = new ArrayList<>();
            lines.add(FILE_HEADER);
            this.storedCodes.entrySet().stream()
                    .sorted(Comparator.comparing(Map.Entry::getKey))
                    .map(entry -> encodePending(entry.getKey(), entry.getValue()))
                    .forEach(lines::add);
            this.usedCodes.entrySet().stream()
                    .sorted(Comparator.comparing(Map.Entry::getKey))
                    .map(entry -> encodeUsed(entry.getKey(), entry.getValue()))
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
            ensureMarker();
        } catch (IOException error) {
            throw new IllegalStateException("Bağlantı kodu deposu yazılamadı", error);
        }
    }

    private static String encodePending(String digest, StoredCode value) {
        String name = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.mcName().getBytes(StandardCharsets.UTF_8));
        return "P\t" + digest + '\t' + value.uuid() + '\t' + name + '\t' + value.expiresAt();
    }

    private static String encodeUsed(String digest, UsedCode value) {
        return "R\t" + digest + '\t' + value.uuid() + '\t'
                + value.discordDigest() + '\t' + value.expiresAt();
    }

    private static String decode(String encoded) {
        return new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
    }

    private Path temporaryFile() {
        return this.pendingFile.resolveSibling(
                this.pendingFile.getFileName().toString() + ".tmp");
    }

    private void ensureMarker() throws IOException {
        if (!Files.exists(this.markerFile)) {
            Files.writeString(this.markerFile, STORE_MARKER + System.lineSeparator(),
                    StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE);
        }
    }

    private <T> T withFileLock(LockedOperation<T> operation) {
        synchronized (this.fileMutex) {
            try {
                Path parent = this.lockFile.getParent();
                if (parent != null) Files.createDirectories(parent);
                try (FileChannel channel = FileChannel.open(this.lockFile,
                        StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                     FileLock ignored = channel.lock()) {
                    return operation.run();
                }
            } catch (IOException error) {
                // Depo okunamıyorsa geçerli bir koda "invalid" demek yerine
                // isteği sunucu hatasıyla durdur.
                throw new IllegalStateException("Bağlantı kodu deposuna erişilemedi", error);
            }
        }
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

    private record UsedCode(UUID uuid, String discordDigest, long expiresAt) {
        private boolean expired(long now) {
            return now >= this.expiresAt;
        }
    }

    @FunctionalInterface
    private interface LockedOperation<T> {
        T run() throws IOException;
    }

    public sealed interface VerifyResult {
        record DiscordAlreadyLinked(DataStore.LinkRow existing) implements VerifyResult { }

        record ExpiredCode() implements VerifyResult { }

        record InvalidCode() implements VerifyResult { }

        record Linked(DataStore.LinkRow row) implements VerifyResult { }
    }
}
