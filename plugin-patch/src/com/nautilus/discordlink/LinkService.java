package com.nautilus.discordlink;

import com.nautilus.storage.DataStore;

import java.io.File;
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
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 * Minecraft ve Discord arasındaki tek kullanımlık bağlantı kodlarını ve
 * bağlantı yaşam döngüsünü yönetir.
 *
 * Kalıcılık iki alandadır:
 *  - pending-link-codes.dat : bekleyen kod özetleri + başarı makbuzları (ham kod yok)
 *  - SQLite                 : bağlantılar, link sürümü (link_id), unlink epoch'u, olay geçmişi
 *
 * İki alan arasında çökme penceresi vardır; bu yüzden yetki kararı her zaman
 * SQLite transaction'ı içinde verilir:
 *  - Her kod üretildiği andaki unlink epoch'unu ve kendi issuance kimliğini taşır.
 *  - Unlink bağlantıyı siler ve epoch'u AYNI transaction'da artırır; dosya
 *    güncellemesi yarım kalsa bile unlink öncesi kodlar geçersizdir.
 *  - Oluşan bağlantının link_id'si kodun issuance kimliğidir; DB commit sonrası
 *    dosya yazılmadan çökme olursa yeniden deneme hangi işlemin commit olduğunu
 *    DB'den kesin olarak bilir. Makbuzlar da link_id'ye bağlıdır; unlink/relink
 *    sonrası eski işlem yeniden yetki kazanmaz.
 */
public final class LinkService {
    private static final char[] ALPHABET = LinkScope.ALPHABET.toCharArray();
    public static final long CODE_TTL_MILLIS = 600_000L;
    private static final long REPLAY_TTL_MILLIS = 600_000L;
    private static final long OPERATION_TTL_MILLIS = 1_800_000L;
    private static final int OPERATION_CACHE_LIMIT = 1024;
    private static final int MAX_CODE_ATTEMPTS = 256;
    private static final String PENDING_FILE_PROPERTY = "nautilus.link.pending-file";
    private static final String FILE_HEADER_V1 = "nautilus-link-codes-v1";
    private static final String FILE_HEADER_V2 = "nautilus-link-codes-v2";
    private static final String FILE_HEADER = "nautilus-link-codes-v3";
    private static final String STORE_MARKER = "nautilus-link-store-initialized-v1";
    private static final Pattern DIGEST = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final Pattern DISCORD_ID = Pattern.compile("[0-9]{1,20}");
    private static final Pattern SNOWFLAKE = Pattern.compile("[0-9]{15,21}");
    private static final Logger LOG = Logger.getLogger("NautilusUHC-Link");
    private static volatile LinkService primary;

    private final DataStore store;
    private final LinkStoreAccess linkStore;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, PendingCode> codes = new ConcurrentHashMap<>();
    private final Map<String, StoredCode> storedCodes = new ConcurrentHashMap<>();
    private final Map<String, UsedCode> usedCodes = new ConcurrentHashMap<>();
    private final Map<String, OperationRecord> operations = new LinkedHashMap<>();
    private final Path pendingFile;
    private final Path lockFile;
    private final Path markerFile;
    private final Object fileMutex;
    private final IllegalStateException schemaFailure;
    private volatile LongSupplier clock = System::currentTimeMillis;
    private volatile Supplier<String> codeSource;
    private volatile TestHooks hooks = new TestHooks();

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
        this.schemaFailure = migrateSchema();
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
        primary = this;
    }

    /** Köprü uçlarının kullandığı, plugin'in etkin servis örneği. */
    public static LinkService primary() {
        return primary;
    }

    public void setClock(LongSupplier longSupplier) {
        this.clock = longSupplier;
    }

    /** Test kancası: kodun 6 karakterlik rastgele kısmını zorlar (çakışma testleri için). */
    public void setCodeSource(Supplier<String> source) {
        this.codeSource = source;
    }

    /** Test kancası: transaction içindeki kritik noktalarda kontrollü zamanlama sağlar. */
    public void setTestHooks(TestHooks testHooks) {
        this.hooks = testHooks == null ? new TestHooks() : testHooks;
    }

    private long now() {
        return this.clock.getAsLong();
    }

    private IllegalStateException migrateSchema() {
        try {
            Path parent = this.pendingFile.getParent();
            File backupDirectory = parent == null ? null : parent.resolve("backups").toFile();
            LinkStoreAccess.MigrationReport report = this.linkStore.migrate(backupDirectory, System.currentTimeMillis());
            if (report.linkIdColumnAdded()) {
                if (report.backupSucceeded()) {
                    LOG.info("Discord bağlantı şeması 1.2.2'ye yükseltildi; önceki DB yedeği: "
                            + (report.backup() == null ? "-" : report.backup().getName()));
                } else {
                    LOG.warning("Discord bağlantı şeması yükseltildi fakat ön yedek alınamadı. "
                            + "Değişiklik yalnız eklemelidir; yine de sunucu kapalıyken manuel yedek al.");
                }
            }
            return null;
        } catch (RuntimeException error) {
            LOG.log(Level.SEVERE, "Discord bağlantı şeması hazırlanamadı; hesap bağlama işlemleri "
                    + "bu açılışta devre dışı (UHC özellikleri etkilenmez).", error);
            return new IllegalStateException("Discord bağlantı şeması hazırlanamadı", error);
        }
    }

    private void requireStore() {
        if (this.schemaFailure != null) {
            throw new IllegalStateException("Discord bağlantı deposu kullanılamıyor", this.schemaFailure);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Kod üretimi                                                          */
    /* ------------------------------------------------------------------ */

    /** Kapsamsız (6 karakter) kod — yalnız geriye uyumluluk ve testler için. */
    public PendingCode issueCode(UUID uuid, String mcName) {
        return issueCode(uuid, mcName, null);
    }

    /**
     * Yeni kod üretir ve aynı oyuncunun önceki bekleyen kodlarını ve makbuzlarını
     * iptal eder. instanceId verilirse kod, bot yönlendirmesi için kapsamlıdır.
     */
    public PendingCode issueCode(UUID uuid, String mcName, String instanceId) {
        Objects.requireNonNull(uuid, "uuid");
        requireStore();
        String name = mcName == null ? "" : mcName;
        String prefix = instanceId == null ? "" : LinkScope.of(instanceId);
        synchronized (this) {
            return withFileLock(() -> {
                refreshPersisted();
                pruneUnlocked();
                long epoch = this.linkStore.epoch(uuid);
                Set<String> retiredDigests = retireUnlocked(uuid);
                String code;
                String digest;
                int attempts = 0;
                do {
                    if (++attempts > MAX_CODE_ATTEMPTS) {
                        throw new IllegalStateException("Benzersiz bağlantı kodu üretilemedi");
                    }
                    code = prefix + randomPart();
                    digest = hash(code);
                } while (this.codes.containsKey(code)
                        || this.storedCodes.containsKey(digest)
                        || this.usedCodes.containsKey(digest)
                        || retiredDigests.contains(digest));
                PendingCode pending = new PendingCode(code, uuid, name, now() + CODE_TTL_MILLIS);
                this.codes.put(code, pending);
                this.storedCodes.put(digest, new StoredCode(
                        uuid, name, pending.expiresAt(), UUID.randomUUID().toString(), epoch));
                persist();
                return pending;
            });
        }
    }

    private String randomPart() {
        Supplier<String> source = this.codeSource;
        if (source != null) {
            String forced = normalize(source.get());
            if (forced.length() != LinkScope.RANDOM_LENGTH || !LinkScope.inAlphabet(forced)) {
                throw new IllegalStateException("Test kod kaynağı geçersiz");
            }
            return forced;
        }
        char[] chars = new char[LinkScope.RANDOM_LENGTH];
        for (int i = 0; i < chars.length; i++) {
            chars[i] = ALPHABET[this.random.nextInt(ALPHABET.length)];
        }
        return new String(chars);
    }

    /** Oyuncuya ait ham kodları, bekleyen özetleri ve makbuzları bellekte iptal eder. */
    private Set<String> retireUnlocked(UUID uuid) {
        Set<String> retired = new HashSet<>();
        List<String> rawCodes = new ArrayList<>();
        this.codes.forEach((code, pending) -> {
            if (pending.uuid().equals(uuid)) rawCodes.add(code);
        });
        rawCodes.forEach(code -> retired.add(hash(code)));
        this.storedCodes.forEach((digest, stored) -> {
            if (stored.uuid().equals(uuid)) retired.add(digest);
        });
        this.usedCodes.forEach((digest, used) -> {
            if (used.uuid().equals(uuid)) retired.add(digest);
        });
        rawCodes.forEach(this.codes::remove);
        retired.forEach(this.storedCodes::remove);
        retired.forEach(this.usedCodes::remove);
        return retired;
    }

    private boolean pruneUnlocked() {
        long now = now();
        boolean changed = this.codes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        changed |= this.storedCodes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        changed |= this.usedCodes.entrySet().removeIf(entry -> entry.getValue().expired(now));
        return changed;
    }

    /* ------------------------------------------------------------------ */
    /* Doğrulama                                                            */
    /* ------------------------------------------------------------------ */

    public VerifyResult verify(String rawCode, String discordId, String discordTag) {
        return verify(new VerifyRequest(rawCode, discordId, discordTag, null, "bridge_legacy"));
    }

    public VerifyResult verify(VerifyRequest request) {
        Objects.requireNonNull(request, "request");
        String discordId = requireDiscordId(request.discordId());
        requireStore();
        synchronized (this) {
            VerifyResult result = withFileLock(() -> verifyLocked(request, discordId));
            rememberOperation(request.requestId(), "link", describe(result), linkOf(result));
            return result;
        }
    }

    private VerifyResult verifyLocked(VerifyRequest request, String discordId) throws IOException {
        refreshPersisted();
        String code = normalize(request.code());
        String digest = hash(code);
        // Diskteki özet kümesi doğruluk kaynağıdır. Bellekte kalmış bir ham
        // kod, başka /link çağrısının iptal ettiği kaydı yeniden oluşturamaz.
        StoredCode pending = this.storedCodes.get(digest);
        if (pending == null) {
            return replayResult(digest, discordId);
        }
        long now = now();
        if (pending.expired(now)) {
            removePendingCode(code, digest);
            persist();
            return new VerifyResult.ExpiredCode();
        }
        String discordTag = LinkStoreAccess.limit(request.discordTag(), 64);
        String source = sourceOr(request.source(), "discord");
        VerifyDecision decision = this.linkStore.inTransaction(connection -> {
            this.linkStore.ensureLinkIds(connection);
            long currentEpoch = this.linkStore.epoch(connection, pending.uuid());
            if (pending.epochOrZero() != currentEpoch) {
                // Kod üretildikten sonra bu hesabın bağlantısı kaldırılmış: eski yetki geçersiz.
                return new VerifyDecision(DecisionKind.REVOKED, null, false);
            }
            LinkRecord byUuid = this.linkStore.byUuid(connection, pending.uuid());
            if (byUuid != null) {
                boolean sameOperation = pending.issuanceId() != null
                        && pending.issuanceId().equals(byUuid.linkId());
                if (byUuid.discordId().equals(discordId)) {
                    return new VerifyDecision(DecisionKind.ALREADY_LINKED, byUuid, sameOperation);
                }
                // Hiçbir koşulda mevcut bağ başka Discord hesabına devredilmez.
                return new VerifyDecision(sameOperation ? DecisionKind.CONSUMED_BY_OTHER : DecisionKind.REVOKED,
                        byUuid, sameOperation);
            }
            LinkRecord byDiscord = this.linkStore.byDiscord(connection, discordId);
            if (byDiscord != null) {
                return new VerifyDecision(DecisionKind.DISCORD_TAKEN, byDiscord, false);
            }
            runHook(this.hooks.beforeLinkCommit);
            String linkId = pending.issuanceId() != null ? pending.issuanceId() : UUID.randomUUID().toString();
            this.linkStore.insertLink(connection, pending.uuid(), pending.mcName(), discordId, discordTag, now, linkId);
            this.linkStore.insertEvent(connection, new LinkEvent(0L, now, "link", "ok", pending.uuid(),
                    pending.mcName(), discordId, discordTag, linkId, "player_discord", discordId, discordTag,
                    source, null, request.requestId()));
            return new VerifyDecision(DecisionKind.CREATED, this.linkStore.byUuid(connection, pending.uuid()), false);
        });
        runHook(this.hooks.afterLinkCommit);

        switch (decision.kind()) {
            case REVOKED -> {
                removePendingCode(code, digest);
                persist();
                return new VerifyResult.InvalidCode("revoked");
            }
            case CONSUMED_BY_OTHER -> {
                // DB commit oldu fakat dosya güncellenmeden süreç durmuş: kodu gerçek
                // sahibinin makbuzuna çevir, bu hesaba asla başarı döndürme.
                removePendingCode(code, digest);
                rememberReceipt(digest, decision.link());
                persist();
                return new VerifyResult.InvalidCode("used");
            }
            case DISCORD_TAKEN -> {
                return new VerifyResult.DiscordAlreadyLinked(decision.link().toRow(), decision.link());
            }
            case ALREADY_LINKED -> {
                removePendingCode(code, digest);
                rememberReceipt(digest, decision.link());
                persist();
                return linked(decision.link(), false, decision.sameOperation());
            }
            default -> {
                removePendingCode(code, digest);
                rememberReceipt(digest, decision.link());
                persist();
                return linked(decision.link(), true, false);
            }
        }
    }

    private VerifyResult replayResult(String digest, String discordId) {
        UsedCode used = this.usedCodes.get(digest);
        if (used == null) {
            return new VerifyResult.InvalidCode("unknown");
        }
        if (used.expired(now())) {
            this.usedCodes.remove(digest);
            persist();
            return new VerifyResult.InvalidCode("unknown");
        }
        if (!MessageDigest.isEqual(
                used.discordDigest().getBytes(StandardCharsets.US_ASCII),
                hash(discordId).getBytes(StandardCharsets.US_ASCII))) {
            return new VerifyResult.InvalidCode("unknown");
        }
        // Hata yutmayan sorgu: altyapı arızası invalid_code olamaz.
        LinkRecord linked = this.linkStore.read(connection -> this.linkStore.byUuid(connection, used.uuid()));
        if (linked == null || !linked.discordId().equals(discordId)) {
            return new VerifyResult.InvalidCode("revoked");
        }
        boolean sameLink = used.linkId() != null
                ? used.linkId().equals(linked.linkId())
                : linked.linkId() == null || linked.linkId().startsWith(LinkStoreAccess.LEGACY_LINK_ID_PREFIX);
        if (!sameLink) {
            // Unlink + yeniden bağlama olmuş: eski işlemin makbuzu yeni bağa yetki vermez.
            return new VerifyResult.InvalidCode("revoked");
        }
        return linked(linked, false, true);
    }

    /**
     * Salt-okunur sahiplik yoklaması. Çoklu instance'ta kapsamsız (eski) kodun hangi
     * depoda beklediğini bulmak içindir; kod tüketilmez. Aynı Discord hesabının
     * geçerli makbuzu da sahiplik sayılır (kaybolan yanıtın tekrarı).
     */
    public ProbeResult probe(String rawCode, String discordId) {
        requireStore();
        synchronized (this) {
            return withFileLock(() -> {
                refreshPersisted();
                String digest = hash(normalize(rawCode));
                long now = now();
                StoredCode pending = this.storedCodes.get(digest);
                if (pending != null) {
                    boolean expired = pending.expired(now);
                    return new ProbeResult(!expired, expired);
                }
                UsedCode used = this.usedCodes.get(digest);
                boolean replay = used != null && !used.expired(now) && discordId != null
                        && MessageDigest.isEqual(used.discordDigest().getBytes(StandardCharsets.US_ASCII),
                        hash(discordId).getBytes(StandardCharsets.US_ASCII));
                return new ProbeResult(replay, false);
            });
        }
    }

    private void rememberReceipt(String digest, LinkRecord link) {
        this.usedCodes.put(digest, new UsedCode(
                link.uuid(), hash(link.discordId()), now() + REPLAY_TTL_MILLIS, link.linkId()));
    }

    private static VerifyResult.Linked linked(LinkRecord link, boolean created, boolean replay) {
        return new VerifyResult.Linked(link.toRow(), link, created, replay);
    }

    private void removePendingCode(String code, String digest) {
        this.codes.remove(code);
        this.storedCodes.remove(digest);
    }

    /* ------------------------------------------------------------------ */
    /* Bağlantı kaldırma                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Bağlantıyı iki taraftan kaldırır. İsimle hedeflemede yalnız birebir eşleşen
     * TEK bir hesap varsa işlem yapılır; birden fazla aday varsa hiçbir şey
     * silinmez. expectedLinkId verilirse bağlantı arada değiştiyse silinmez.
     */
    public UnlinkResult unlink(UnlinkRequest request) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(request.selector(), "selector");
        String value = request.value() == null ? "" : request.value().trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("Bağlantı kaldırma hedefi boş");
        }
        UUID uuidValue = request.selector() == Selector.BY_UUID ? parseUuid(value) : null;
        if (request.selector() == Selector.BY_DISCORD) {
            requireDiscordId(value);
        }
        Actor actor = request.actor() == null ? Actor.SYSTEM : request.actor();
        String reason = LinkStoreAccess.limit(blankToNull(request.reason()), 500);
        requireStore();
        synchronized (this) {
            UnlinkResult result = withFileLock(() -> {
                refreshPersisted();
                long now = now();
                UnlinkResult decided = this.linkStore.inTransaction(connection -> {
                    this.linkStore.ensureLinkIds(connection);
                    String nameForEvent = request.selector() == Selector.BY_NAME ? value : null;
                    String discordForEvent = request.selector() == Selector.BY_DISCORD ? value : null;
                    UUID target;
                    boolean resolved;
                    switch (request.selector()) {
                        case BY_UUID -> {
                            target = uuidValue;
                            resolved = true;
                        }
                        case BY_DISCORD -> {
                            LinkRecord byDiscord = this.linkStore.byDiscord(connection, value);
                            target = byDiscord == null ? null : byDiscord.uuid();
                            resolved = byDiscord != null;
                        }
                        default -> {
                            Set<UUID> candidates = nameCandidates(connection, value, request.extraNameCandidates());
                            if (candidates.size() > 1) {
                                this.linkStore.insertEvent(connection, unlinkEvent("ambiguous", null, null,
                                        nameForEvent, null, request, actor, reason, now));
                                return new UnlinkResult.Ambiguous(describeCandidates(connection, candidates));
                            }
                            target = candidates.isEmpty() ? null : candidates.iterator().next();
                            resolved = target != null;
                        }
                    }
                    LinkRecord current = target == null ? null : this.linkStore.byUuid(connection, target);
                    if (current == null) {
                        this.linkStore.insertEvent(connection, unlinkEvent("not_linked", null, target,
                                nameForEvent, discordForEvent, request, actor, reason, now));
                        return new UnlinkResult.NotLinked(target, resolved);
                    }
                    if (request.expectedLinkId() != null && !request.expectedLinkId().equals(current.linkId())) {
                        this.linkStore.insertEvent(connection, unlinkEvent("stale_version", current, null,
                                null, null, request, actor, reason, now));
                        return new UnlinkResult.StaleVersion(current);
                    }
                    runHook(this.hooks.beforeUnlinkCommit);
                    if (!this.linkStore.deleteLink(connection, current.uuid(), current.linkId())) {
                        throw new SQLException("Bağlantı kaydı işlem sırasında değişti");
                    }
                    long epoch = this.linkStore.bumpEpoch(connection, current.uuid(), now);
                    this.linkStore.insertEvent(connection, unlinkEvent("ok", current, null, null, null,
                            request, actor, reason, now));
                    return new UnlinkResult.Removed(current, epoch);
                });
                if (decided instanceof UnlinkResult.Removed removed) {
                    retireUnlocked(removed.link().uuid());
                    try {
                        persist();
                    } catch (IllegalStateException error) {
                        // DB transaction commit oldu; epoch artışı eski kodları dosyadan
                        // bağımsız olarak geçersiz kılar. Hata görünür kalsın.
                        LOG.log(Level.WARNING, "Bağlantı kaldırıldı fakat kod deposu güncellenemedi; "
                                + "eski kodlar DB epoch'u ile yine de geçersiz.", error);
                    }
                }
                return decided;
            });
            rememberOperation(request.requestId(), "unlink", describe(result), linkOf(result));
            return result;
        }
    }

    /** 1.2.1 uyumlu kaldırma: type "dc" → Discord ID, diğerleri → kesin oyuncu adı. */
    public Optional<DataStore.LinkRow> unlink(String type, String value) {
        Selector selector = "dc".equalsIgnoreCase(type) ? Selector.BY_DISCORD : Selector.BY_NAME;
        UnlinkResult result = unlink(new UnlinkRequest(selector, value, null, List.of(),
                new Actor("bridge_legacy", null, null), null, "legacy_api", null));
        if (result instanceof UnlinkResult.Removed removed) {
            return Optional.of(removed.link().toRow());
        }
        if (result instanceof UnlinkResult.Ambiguous ambiguous) {
            throw new AmbiguousNameException(ambiguous.candidates());
        }
        return Optional.empty();
    }

    private Set<UUID> nameCandidates(Connection connection, String name, Collection<UUID> extra) throws SQLException {
        Set<UUID> candidates = new LinkedHashSet<>(this.linkStore.uuidsByName(connection, name));
        if (extra != null) {
            for (UUID uuid : extra) {
                if (uuid != null) candidates.add(uuid);
            }
        }
        return candidates;
    }

    private List<NameCandidate> describeCandidates(Connection connection, Collection<UUID> uuids) throws SQLException {
        List<NameCandidate> described = new ArrayList<>();
        for (UUID uuid : uuids) {
            described.add(new NameCandidate(uuid, this.linkStore.knownNames(connection, uuid),
                    this.linkStore.byUuid(connection, uuid)));
        }
        return described;
    }

    private static LinkEvent unlinkEvent(String result, LinkRecord link, UUID uuid, String name, String discordId,
                                         UnlinkRequest request, Actor actor, String reason, long now) {
        return new LinkEvent(0L, now, "unlink", result,
                link != null ? link.uuid() : uuid,
                link != null ? link.mcName() : name,
                link != null ? link.discordId() : discordId,
                link != null ? link.discordTag() : null,
                link != null ? link.linkId() : null,
                actor.type(), actor.id(), actor.name(),
                sourceOr(request.source(), "unknown"), reason, request.requestId());
    }

    /* ------------------------------------------------------------------ */
    /* Sorgular                                                             */
    /* ------------------------------------------------------------------ */

    /** UhcHubManager kapısı: eski davranış korunur (okuma hatasında bağlı sayılmaz). */
    public boolean isLinked(UUID uuid) {
        return this.store.linkByUuid(uuid) != null;
    }

    public Optional<DataStore.LinkRow> byUuid(UUID uuid) {
        return recordByUuid(uuid).map(LinkRecord::toRow);
    }

    public Optional<DataStore.LinkRow> byDiscord(String discordId) {
        return recordByDiscord(discordId).map(LinkRecord::toRow);
    }

    /** Birebir isim; birden fazla hesap eşleşirse AmbiguousNameException. */
    public Optional<DataStore.LinkRow> byName(String name) {
        NameResolution resolution = resolveName(name, List.of());
        if (resolution.ambiguous()) {
            throw new AmbiguousNameException(resolution.candidates());
        }
        return Optional.ofNullable(resolution.link()).map(LinkRecord::toRow);
    }

    public Optional<LinkRecord> recordByUuid(UUID uuid) {
        Objects.requireNonNull(uuid, "uuid");
        requireStore();
        return Optional.ofNullable(this.linkStore.read(connection -> this.linkStore.byUuid(connection, uuid)));
    }

    public Optional<LinkRecord> recordByDiscord(String discordId) {
        String id = requireDiscordId(discordId);
        requireStore();
        return Optional.ofNullable(this.linkStore.read(connection -> this.linkStore.byDiscord(connection, id)));
    }

    public NameResolution resolveName(String name, Collection<UUID> extraCandidates) {
        String value = name == null ? "" : name.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("Oyuncu adı boş");
        }
        requireStore();
        return this.linkStore.read(connection -> new NameResolution(value,
                describeCandidates(connection, nameCandidates(connection, value, extraCandidates))));
    }

    public LinkPage listLinks(int offset, int limit) {
        int safeOffset = Math.max(0, offset);
        int safeLimit = Math.max(1, Math.min(50, limit));
        requireStore();
        return this.linkStore.inTransaction(connection -> new LinkPage(
                this.linkStore.countLinks(connection), safeOffset, safeLimit,
                this.linkStore.listLinks(connection, safeOffset, safeLimit)));
    }

    public List<LinkEvent> history(UUID uuid, String discordId, int limit, Long beforeId) {
        String id = discordId == null ? null : requireDiscordId(discordId);
        int safeLimit = Math.max(1, Math.min(50, limit));
        requireStore();
        return this.linkStore.read(connection -> this.linkStore.history(connection, uuid, id, safeLimit, beforeId));
    }

    public long epoch(UUID uuid) {
        requireStore();
        return this.linkStore.epoch(uuid);
    }

    /** Aynı requestId'li işlemin kesin sonucu (zaman aşımı sonrası uzlaştırma için). */
    public Optional<OperationRecord> operation(String requestId) {
        if (requestId == null || requestId.isBlank()) {
            return Optional.empty();
        }
        synchronized (this) {
            OperationRecord cached = this.operations.get(requestId);
            if (cached != null && now() - cached.occurredAt() < OPERATION_TTL_MILLIS) {
                return Optional.of(cached);
            }
        }
        requireStore();
        LinkEvent event = this.linkStore.read(connection ->
                this.linkStore.latestEventByCorrelation(connection, requestId));
        if (event == null) {
            return Optional.empty();
        }
        String result = "ok".equals(event.result())
                ? ("link".equals(event.action()) ? "linked" : "removed")
                : event.result();
        LinkRecord link = event.uuid() == null ? null : new LinkRecord(event.uuid(), event.mcName(), null,
                event.discordId(), event.discordTag(), event.occurredAt(), event.linkId(), null);
        return Optional.of(new OperationRecord(requestId, event.action(), result, link, event.occurredAt()));
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

    /** Eski/hatalı kayıtlar için salt-rapor. Hiçbir kaydı değiştirmez. */
    public ConsistencyReport consistencyReport() {
        requireStore();
        List<LinkRecord> all = this.linkStore.read(this.linkStore::allLinks);
        List<LinkRecord> duplicates = this.linkStore.read(this.linkStore::duplicateNameLinks);
        List<LinkRecord> taken = this.linkStore.read(this.linkStore::nameTakenByOtherPlayer);
        List<LinkRecord> renamed = all.stream()
                .filter(link -> link.currentName() != null && !link.currentName().equalsIgnoreCase(link.mcName()))
                .toList();
        List<LinkRecord> invalidIds = all.stream()
                .filter(link -> link.discordId() == null || !SNOWFLAKE.matcher(link.discordId()).matches())
                .toList();
        List<LinkRecord> unknownTime = all.stream().filter(link -> link.linkedAt() <= 0).toList();
        List<LinkRecord> missingPlayer = all.stream().filter(link -> link.currentName() == null).toList();
        Set<UUID> linkedUuids = new HashSet<>();
        all.forEach(link -> linkedUuids.add(link.uuid()));
        int[] pending = new int[2];
        synchronized (this) {
            withFileLock(() -> {
                refreshPersisted();
                pending[0] = this.storedCodes.size();
                pending[1] = (int) this.storedCodes.values().stream()
                        .filter(code -> linkedUuids.contains(code.uuid())).count();
                return null;
            });
        }
        return new ConsistencyReport(all.size(), duplicates, renamed, taken, invalidIds, unknownTime,
                missingPlayer, pending[0], pending[1], all);
    }

    private void rememberOperation(String requestId, String action, String result, LinkRecord link) {
        if (requestId == null || requestId.isBlank()) {
            return;
        }
        this.operations.remove(requestId);
        this.operations.put(requestId, new OperationRecord(requestId, action, result, link, now()));
        while (this.operations.size() > OPERATION_CACHE_LIMIT) {
            String eldest = this.operations.keySet().iterator().next();
            this.operations.remove(eldest);
        }
    }

    private static String describe(VerifyResult result) {
        if (result instanceof VerifyResult.Linked) return "linked";
        if (result instanceof VerifyResult.DiscordAlreadyLinked) return "discord_already_linked";
        if (result instanceof VerifyResult.ExpiredCode) return "expired_code";
        return "invalid_code";
    }

    private static String describe(UnlinkResult result) {
        if (result instanceof UnlinkResult.Removed) return "removed";
        if (result instanceof UnlinkResult.NotLinked) return "not_linked";
        if (result instanceof UnlinkResult.StaleVersion) return "stale_version";
        return "ambiguous";
    }

    private static LinkRecord linkOf(VerifyResult result) {
        if (result instanceof VerifyResult.Linked linked) return linked.link();
        if (result instanceof VerifyResult.DiscordAlreadyLinked taken) return taken.link();
        return null;
    }

    private static LinkRecord linkOf(UnlinkResult result) {
        if (result instanceof UnlinkResult.Removed removed) return removed.link();
        if (result instanceof UnlinkResult.StaleVersion stale) return stale.current();
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Kalıcı kod deposu                                                    */
    /* ------------------------------------------------------------------ */

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
        if (!FILE_HEADER.equals(header) && !FILE_HEADER_V2.equals(header) && !FILE_HEADER_V1.equals(header)) {
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
            if (FILE_HEADER_V1.equals(header) && fields.length == 4 && DIGEST.matcher(fields[0]).matches()) {
                pendingSnapshot.put(fields[0], new StoredCode(UUID.fromString(fields[1]), decode(fields[2]),
                        Long.parseLong(fields[3]), null, null));
                return;
            }
            // v2 pending: P, digest, uuid, base64(mcName), expiresAt
            if (FILE_HEADER_V2.equals(header) && fields.length == 5 && "P".equals(fields[0])
                    && DIGEST.matcher(fields[1]).matches()) {
                pendingSnapshot.put(fields[1], new StoredCode(UUID.fromString(fields[2]), decode(fields[3]),
                        Long.parseLong(fields[4]), null, null));
                return;
            }
            // v2 receipt: R, codeDigest, uuid, discordDigest, expiresAt
            if (FILE_HEADER_V2.equals(header) && fields.length == 5 && "R".equals(fields[0])
                    && DIGEST.matcher(fields[1]).matches() && DIGEST.matcher(fields[3]).matches()) {
                usedSnapshot.put(fields[1], new UsedCode(UUID.fromString(fields[2]), fields[3],
                        Long.parseLong(fields[4]), null));
                return;
            }
            // v3 pending: P, digest, uuid, base64(mcName), expiresAt, issuanceId|-, epoch|-
            if (FILE_HEADER.equals(header) && fields.length == 7 && "P".equals(fields[0])
                    && DIGEST.matcher(fields[1]).matches()) {
                pendingSnapshot.put(fields[1], new StoredCode(UUID.fromString(fields[2]), decode(fields[3]),
                        Long.parseLong(fields[4]), token(fields[5]),
                        "-".equals(fields[6]) ? null : Long.parseLong(fields[6])));
                return;
            }
            // v3 receipt: R, codeDigest, uuid, discordDigest, expiresAt, linkId|-
            if (FILE_HEADER.equals(header) && fields.length == 6 && "R".equals(fields[0])
                    && DIGEST.matcher(fields[1]).matches() && DIGEST.matcher(fields[3]).matches()) {
                usedSnapshot.put(fields[1], new UsedCode(UUID.fromString(fields[2]), fields[3],
                        Long.parseLong(fields[4]), token(fields[5])));
                return;
            }
            throw new IllegalArgumentException("tanınmayan kayıt biçimi");
        } catch (IllegalArgumentException error) {
            // İçeriği (kod özeti dahil) hata mesajına veya loga koyma.
            throw new IOException("Bağlantı kodu deposunda bozuk kayıt: satır " + lineNumber, error);
        }
    }

    private static String token(String field) {
        if ("-".equals(field)) return null;
        if (!TOKEN.matcher(field).matches()) throw new IllegalArgumentException("geçersiz kimlik alanı");
        return field;
    }

    private void persist() {
        try {
            Path parent = this.pendingFile.getParent();
            if (parent != null) Files.createDirectories(parent);
            Path temporary = temporaryFile();
            List<String> lines = new ArrayList<>();
            lines.add(FILE_HEADER);
            this.storedCodes.entrySet().stream()
                    .sorted(Map.Entry.comparingByKey(Comparator.naturalOrder()))
                    .map(entry -> encodePending(entry.getKey(), entry.getValue()))
                    .forEach(lines::add);
            this.usedCodes.entrySet().stream()
                    .sorted(Map.Entry.comparingByKey(Comparator.naturalOrder()))
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
        return "P\t" + digest + '\t' + value.uuid() + '\t' + name + '\t' + value.expiresAt()
                + '\t' + (value.issuanceId() == null ? "-" : value.issuanceId())
                + '\t' + (value.epoch() == null ? "-" : value.epoch().toString());
    }

    private static String encodeUsed(String digest, UsedCode value) {
        return "R\t" + digest + '\t' + value.uuid() + '\t' + value.discordDigest() + '\t'
                + value.expiresAt() + '\t' + (value.linkId() == null ? "-" : value.linkId());
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

    private static void runHook(Runnable hook) {
        if (hook != null) hook.run();
    }

    /* ------------------------------------------------------------------ */
    /* Doğrulama yardımcıları                                               */
    /* ------------------------------------------------------------------ */

    static String normalize(String raw) {
        return raw == null ? "" : raw.trim().toUpperCase(Locale.ROOT);
    }

    /** Discord kullanıcı ID'si her zaman string'dir; sayıya çevrilmez. */
    static String requireDiscordId(String raw) {
        String id = raw == null ? "" : raw.trim();
        if (!DISCORD_ID.matcher(id).matches()) {
            throw new IllegalArgumentException("Discord kullanıcı ID'si geçersiz");
        }
        return id;
    }

    static UUID parseUuid(String raw) {
        try {
            return UUID.fromString(raw.trim());
        } catch (IllegalArgumentException | NullPointerException invalid) {
            throw new IllegalArgumentException("Minecraft UUID'si geçersiz");
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static String sourceOr(String source, String fallback) {
        return source == null || source.isBlank() ? fallback : source;
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

    /* ------------------------------------------------------------------ */
    /* Tipler                                                               */
    /* ------------------------------------------------------------------ */

    public record PendingCode(String code, UUID uuid, String mcName, long expiresAt) {
        public boolean expired(long now) {
            return now >= this.expiresAt;
        }
    }

    public record LinkRecord(UUID uuid, String mcName, String currentName, String discordId,
                             String discordTag, long linkedAt, String linkId, Integer elo) {
        public DataStore.LinkRow toRow() {
            return new DataStore.LinkRow(this.uuid, this.mcName, this.discordId, this.discordTag, this.linkedAt);
        }

        /** Oyuncunun bilinen güncel adı; yoksa bağlanırken kaydedilen ad. */
        public String displayName() {
            return this.currentName != null && !this.currentName.isBlank() ? this.currentName : this.mcName;
        }
    }

    public record LinkEvent(long id, long occurredAt, String action, String result, UUID uuid, String mcName,
                            String discordId, String discordTag, String linkId, String actorType, String actorId,
                            String actorName, String source, String reason, String requestId) {
    }

    public record Actor(String type, String id, String name) {
        public static final Actor SYSTEM = new Actor("system", null, null);
    }

    public enum Selector {
        BY_UUID,
        BY_DISCORD,
        BY_NAME
    }

    public record VerifyRequest(String code, String discordId, String discordTag, String requestId, String source) {
    }

    public record UnlinkRequest(Selector selector, String value, String expectedLinkId,
                                Collection<UUID> extraNameCandidates, Actor actor, String reason,
                                String source, String requestId) {
    }

    public record ProbeResult(boolean holder, boolean expired) {
    }

    public record NameCandidate(UUID uuid, List<String> knownNames, LinkRecord link) {
    }

    public record NameResolution(String name, List<NameCandidate> candidates) {
        public boolean ambiguous() {
            return this.candidates.size() > 1;
        }

        public boolean resolved() {
            return this.candidates.size() == 1;
        }

        public UUID uuid() {
            return resolved() ? this.candidates.get(0).uuid() : null;
        }

        public LinkRecord link() {
            return resolved() ? this.candidates.get(0).link() : null;
        }
    }

    public record LinkPage(int total, int offset, int limit, List<LinkRecord> links) {
    }

    public record OperationRecord(String requestId, String action, String result, LinkRecord link, long occurredAt) {
    }

    public record ConsistencyReport(int totalLinks, List<LinkRecord> duplicateNameLinks, List<LinkRecord> renamedLinks,
                                    List<LinkRecord> nameTakenByOtherPlayer, List<LinkRecord> invalidDiscordIds,
                                    List<LinkRecord> unknownLinkTime, List<LinkRecord> missingPlayerRecord,
                                    int pendingCodes, int pendingCodesForLinkedPlayers, List<LinkRecord> links) {
    }

    /** İsim birden fazla hesapla eşleştiğinde fırlatılır; hiçbir kayıt değişmemiştir. */
    public static final class AmbiguousNameException extends IllegalStateException {
        private final transient List<NameCandidate> candidates;

        public AmbiguousNameException(List<NameCandidate> candidates) {
            super("Oyuncu adı birden fazla hesapla eşleşiyor");
            this.candidates = List.copyOf(candidates);
        }

        public List<NameCandidate> candidates() {
            return this.candidates;
        }
    }

    /** Yalnız testler için; üretimde boş kalır. */
    public static final class TestHooks {
        public volatile Runnable beforeLinkCommit;
        public volatile Runnable afterLinkCommit;
        public volatile Runnable beforeUnlinkCommit;
    }

    private record StoredCode(UUID uuid, String mcName, long expiresAt, String issuanceId, Long epoch) {
        private boolean expired(long now) {
            return now >= this.expiresAt;
        }

        private long epochOrZero() {
            return this.epoch == null ? 0L : this.epoch;
        }
    }

    private record UsedCode(UUID uuid, String discordDigest, long expiresAt, String linkId) {
        private boolean expired(long now) {
            return now >= this.expiresAt;
        }
    }

    private enum DecisionKind {
        CREATED,
        ALREADY_LINKED,
        CONSUMED_BY_OTHER,
        REVOKED,
        DISCORD_TAKEN
    }

    private record VerifyDecision(DecisionKind kind, LinkRecord link, boolean sameOperation) {
    }

    @FunctionalInterface
    private interface LockedOperation<T> {
        T run() throws IOException;
    }

    public sealed interface VerifyResult {
        record DiscordAlreadyLinked(DataStore.LinkRow existing, LinkRecord link) implements VerifyResult { }

        record ExpiredCode() implements VerifyResult { }

        record InvalidCode(String reason) implements VerifyResult {
            public InvalidCode() {
                this("unknown");
            }
        }

        record Linked(DataStore.LinkRow row, LinkRecord link, boolean created, boolean replay)
                implements VerifyResult { }
    }

    public sealed interface UnlinkResult {
        record Removed(LinkRecord link, long epoch) implements UnlinkResult { }

        record NotLinked(UUID uuid, boolean resolved) implements UnlinkResult { }

        record StaleVersion(LinkRecord current) implements UnlinkResult { }

        record Ambiguous(List<NameCandidate> candidates) implements UnlinkResult { }
    }
}
