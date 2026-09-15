package com.nautilus.discordlink;

import com.nautilus.storage.DataStore;

import javax.sql.DataSource;
import java.io.File;
import java.lang.reflect.Field;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Link tabloları için hata yutmayan, transaction'lı ve mevcut bağı asla ezmeyen işlemler.
 *
 * DataStore'un link metotları SQL hatasını null/false'a çevirir. Burada her
 * hata IllegalStateException olarak yukarı taşınır; altyapı arızası "kod
 * geçersiz" ya da "bağlantı yok" diye maskelenmez.
 *
 * Şema değişiklikleri yalnız eklemelidir (eski JAR yeni sütun/tabloları yok sayar):
 *  - discord_links.link_id        : her bağlantı oluşturmanın değişmez sürümü
 *  - discord_link_epochs          : UUID başına unlink sayacı (eski kod/makbuz iptali)
 *  - discord_link_events          : link/unlink denetim geçmişi (ham kod saklanmaz)
 */
final class LinkStoreAccess {
    static final String LEGACY_LINK_ID_PREFIX = "legacy-";
    private static final int MAX_NAME = 64;
    private static final int MAX_TAG = 64;
    private static final int MAX_REASON = 500;
    private static final String LINK_SELECT = "SELECT l.uuid, l.mc_name, l.discord_id, l.discord_tag, "
            + "l.linked_at, l.link_id, p.name AS current_name, p.elo AS elo "
            + "FROM discord_links l LEFT JOIN players p ON p.uuid = l.uuid ";
    private static final String EVENT_SELECT = "SELECT id, occurred_at, action, result, uuid, mc_name, "
            + "discord_id, discord_tag, link_id, actor_type, actor_id, actor_name, source, reason, "
            + "correlation_id FROM discord_link_events ";

    private final DataStore store;
    private final DataSource dataSource;

    LinkStoreAccess(DataStore store) {
        this.store = store;
        try {
            Field field = DataStore.class.getDeclaredField("pool");
            if (!field.trySetAccessible()) {
                throw new IllegalStateException("Discord bağlantı deposuna erişim açılamadı");
            }
            Object value = field.get(store);
            if (!(value instanceof DataSource source)) {
                throw new IllegalStateException("Discord bağlantı deposu DataSource değil");
            }
            this.dataSource = source;
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("Discord bağlantı deposu bulunamadı", error);
        }
    }

    record MigrationReport(boolean linkIdColumnAdded, File backup, boolean backupSucceeded) { }

    @FunctionalInterface
    interface SqlWork<T> {
        T run(Connection connection) throws SQLException;
    }

    /** Eklemeli şema geçişi. link_id sütunu ilk kez eklenecekse önce DB yedeği alınır. */
    MigrationReport migrate(File backupDirectory, long now) {
        boolean needsColumn = read(connection -> !columnExists(connection, "discord_links", "link_id"));
        File backup = null;
        boolean backupSucceeded = true;
        if (needsColumn && backupDirectory != null) {
            backup = new File(backupDirectory, "nautilus-main-pre-link-1.2.2-" + now + ".db");
            //noinspection ResultOfMethodCallIgnored
            backupDirectory.mkdirs();
            backupSucceeded = this.store.backupTo(backup);
        }
        inTransaction(connection -> {
            try (Statement statement = connection.createStatement()) {
                if (!columnExists(connection, "discord_links", "link_id")) {
                    statement.executeUpdate("ALTER TABLE discord_links ADD COLUMN link_id TEXT");
                }
                statement.executeUpdate("CREATE TABLE IF NOT EXISTS discord_link_epochs ("
                        + "uuid TEXT PRIMARY KEY, epoch INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
                statement.executeUpdate("CREATE TABLE IF NOT EXISTS discord_link_events ("
                        + "id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL, "
                        + "action TEXT NOT NULL, result TEXT NOT NULL, uuid TEXT, mc_name TEXT, "
                        + "discord_id TEXT, discord_tag TEXT, link_id TEXT, actor_type TEXT NOT NULL, "
                        + "actor_id TEXT, actor_name TEXT, source TEXT NOT NULL, reason TEXT, "
                        + "correlation_id TEXT)");
                statement.executeUpdate("CREATE INDEX IF NOT EXISTS idx_link_events_uuid "
                        + "ON discord_link_events(uuid, id)");
                statement.executeUpdate("CREATE INDEX IF NOT EXISTS idx_link_events_discord "
                        + "ON discord_link_events(discord_id, id)");
                statement.executeUpdate("CREATE INDEX IF NOT EXISTS idx_link_events_correlation "
                        + "ON discord_link_events(correlation_id)");
            }
            ensureLinkIds(connection);
            try (Statement statement = connection.createStatement()) {
                statement.executeUpdate("CREATE UNIQUE INDEX IF NOT EXISTS idx_links_link_id "
                        + "ON discord_links(link_id)");
            }
            return null;
        });
        return new MigrationReport(needsColumn, backup, backupSucceeded);
    }

    <T> T inTransaction(SqlWork<T> work) {
        try (Connection connection = this.dataSource.getConnection()) {
            boolean originalAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                T result = work.run(connection);
                connection.commit();
                return result;
            } catch (SQLException | RuntimeException error) {
                try {
                    connection.rollback();
                } catch (SQLException rollbackError) {
                    error.addSuppressed(rollbackError);
                }
                throw error;
            } finally {
                try {
                    connection.setAutoCommit(originalAutoCommit);
                } catch (SQLException ignored) {
                    // Havuz bağlantıyı iade ederken durumu ayrıca sıfırlar.
                }
            }
        } catch (SQLException error) {
            throw new IllegalStateException("Discord bağlantı deposu işlemi başarısız", error);
        }
    }

    <T> T read(SqlWork<T> work) {
        try (Connection connection = this.dataSource.getConnection()) {
            return work.run(connection);
        } catch (SQLException error) {
            throw new IllegalStateException("Discord bağlantı deposu okunamadı", error);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Bağlantılar                                                          */
    /* ------------------------------------------------------------------ */

    LinkService.LinkRecord byUuid(Connection connection, UUID uuid) throws SQLException {
        return queryOne(connection, LINK_SELECT + "WHERE l.uuid = ? LIMIT 1", uuid.toString());
    }

    LinkService.LinkRecord byDiscord(Connection connection, String discordId) throws SQLException {
        return queryOne(connection, LINK_SELECT + "WHERE l.discord_id = ? LIMIT 1", discordId);
    }

    /**
     * Eski sürümlerin (ya da DataStore.linkCreate'in) link_id'siz eklediği satırlara
     * kalıcı bir sürüm kimliği verir. Yazma transaction'larının ilk ifadesi olarak
     * çalışır; SQLite yazma kilidini en başta aldığı için okuma→yazma yükseltmesi
     * sırasında başka bir yazarla yarışılmaz.
     */
    void ensureLinkIds(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate("UPDATE discord_links SET link_id = '" + LEGACY_LINK_ID_PREFIX
                    + "' || lower(hex(randomblob(12))) WHERE link_id IS NULL");
        }
    }

    void insertLink(Connection connection, UUID uuid, String mcName, String discordId,
                    String discordTag, long linkedAt, String linkId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO discord_links (uuid, mc_name, discord_id, discord_tag, linked_at, link_id) "
                        + "VALUES (?, ?, ?, ?, ?, ?)")) {
            statement.setString(1, uuid.toString());
            statement.setString(2, limit(mcName == null ? "" : mcName, MAX_NAME));
            statement.setString(3, discordId);
            statement.setString(4, limit(discordTag, MAX_TAG));
            statement.setLong(5, linkedAt);
            statement.setString(6, linkId);
            statement.executeUpdate();
        }
    }

    /** Karşılaştır-ve-sil: yalnız beklenen sürüm hâlâ duruyorsa siler. */
    boolean deleteLink(Connection connection, UUID uuid, String linkId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "DELETE FROM discord_links WHERE uuid = ? AND link_id = ?")) {
            statement.setString(1, uuid.toString());
            statement.setString(2, linkId);
            return statement.executeUpdate() == 1;
        }
    }

    int countLinks(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery("SELECT COUNT(*) FROM discord_links")) {
            return result.next() ? result.getInt(1) : 0;
        }
    }

    /** En son eşleşenler önce; eşit zamanda UUID kararlı ikinci anahtardır. */
    List<LinkService.LinkRecord> listLinks(Connection connection, int offset, int limit) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                LINK_SELECT + "ORDER BY l.linked_at DESC, l.uuid ASC LIMIT ? OFFSET ?")) {
            statement.setInt(1, limit);
            statement.setInt(2, offset);
            return readLinks(statement);
        }
    }

    List<LinkService.LinkRecord> allLinks(Connection connection) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                LINK_SELECT + "ORDER BY l.linked_at DESC, l.uuid ASC")) {
            return readLinks(statement);
        }
    }

    List<LinkService.LinkRecord> duplicateNameLinks(Connection connection) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(LINK_SELECT
                + "WHERE lower(l.mc_name) IN (SELECT lower(mc_name) FROM discord_links "
                + "GROUP BY lower(mc_name) HAVING COUNT(*) > 1) ORDER BY lower(l.mc_name), l.linked_at")) {
            return readLinks(statement);
        }
    }

    List<LinkService.LinkRecord> nameTakenByOtherPlayer(Connection connection) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(LINK_SELECT
                + "WHERE EXISTS (SELECT 1 FROM players o WHERE o.name = l.mc_name COLLATE NOCASE "
                + "AND o.uuid <> l.uuid) ORDER BY lower(l.mc_name), l.linked_at")) {
            return readLinks(statement);
        }
    }

    /* ------------------------------------------------------------------ */
    /* İsim çözümleme                                                        */
    /* ------------------------------------------------------------------ */

    /** Adı birebir (büyük/küçük harf duyarsız) taşıyan tüm bilinen UUID'ler. Kısmi eşleşme yok. */
    List<UUID> uuidsByName(Connection connection, String name) throws SQLException {
        Set<UUID> uuids = new LinkedHashSet<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT uuid FROM discord_links WHERE mc_name = ? COLLATE NOCASE "
                        + "UNION SELECT uuid FROM players WHERE name = ? COLLATE NOCASE")) {
            statement.setString(1, name);
            statement.setString(2, name);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    UUID uuid = parseUuid(result.getString(1));
                    if (uuid != null) uuids.add(uuid);
                }
            }
        }
        return new ArrayList<>(uuids);
    }

    List<String> knownNames(Connection connection, UUID uuid) throws SQLException {
        Set<String> names = new LinkedHashSet<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT name FROM players WHERE uuid = ? UNION ALL "
                        + "SELECT mc_name FROM discord_links WHERE uuid = ?")) {
            statement.setString(1, uuid.toString());
            statement.setString(2, uuid.toString());
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    String name = result.getString(1);
                    if (name != null && !name.isBlank()) names.add(name);
                }
            }
        }
        return new ArrayList<>(names);
    }

    /* ------------------------------------------------------------------ */
    /* Epoch (unlink sayacı)                                                 */
    /* ------------------------------------------------------------------ */

    long epoch(UUID uuid) {
        return read(connection -> epoch(connection, uuid));
    }

    long epoch(Connection connection, UUID uuid) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT epoch FROM discord_link_epochs WHERE uuid = ?")) {
            statement.setString(1, uuid.toString());
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? result.getLong(1) : 0L;
            }
        }
    }

    long bumpEpoch(Connection connection, UUID uuid, long now) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO discord_link_epochs (uuid, epoch, updated_at) VALUES (?, 1, ?) "
                        + "ON CONFLICT(uuid) DO UPDATE SET epoch = epoch + 1, updated_at = excluded.updated_at")) {
            statement.setString(1, uuid.toString());
            statement.setLong(2, now);
            statement.executeUpdate();
        }
        return epoch(connection, uuid);
    }

    /* ------------------------------------------------------------------ */
    /* Denetim geçmişi                                                       */
    /* ------------------------------------------------------------------ */

    long insertEvent(Connection connection, LinkService.LinkEvent event) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO discord_link_events (occurred_at, action, result, uuid, mc_name, discord_id, "
                        + "discord_tag, link_id, actor_type, actor_id, actor_name, source, reason, correlation_id) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            statement.setLong(1, event.occurredAt());
            statement.setString(2, event.action());
            statement.setString(3, event.result());
            statement.setString(4, event.uuid() == null ? null : event.uuid().toString());
            statement.setString(5, limit(event.mcName(), MAX_NAME));
            statement.setString(6, event.discordId());
            statement.setString(7, limit(event.discordTag(), MAX_TAG));
            statement.setString(8, event.linkId());
            statement.setString(9, event.actorType() == null ? "system" : limit(event.actorType(), 32));
            statement.setString(10, limit(event.actorId(), 64));
            statement.setString(11, limit(event.actorName(), MAX_NAME));
            statement.setString(12, event.source() == null ? "unknown" : limit(event.source(), 32));
            statement.setString(13, limit(event.reason(), MAX_REASON));
            statement.setString(14, limit(event.requestId(), 64));
            statement.executeUpdate();
        }
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery("SELECT last_insert_rowid()")) {
            return result.next() ? result.getLong(1) : 0L;
        }
    }

    /** uuid ve discordId birlikte verilirse ikisinden birine dokunan olaylar döner. */
    List<LinkService.LinkEvent> history(Connection connection, UUID uuid, String discordId,
                                        int limit, Long beforeId) throws SQLException {
        StringBuilder sql = new StringBuilder(EVENT_SELECT).append("WHERE 1 = 1");
        List<Object> params = new ArrayList<>();
        if (uuid != null && discordId != null) {
            sql.append(" AND (uuid = ? OR discord_id = ?)");
            params.add(uuid.toString());
            params.add(discordId);
        } else if (uuid != null) {
            sql.append(" AND uuid = ?");
            params.add(uuid.toString());
        } else if (discordId != null) {
            sql.append(" AND discord_id = ?");
            params.add(discordId);
        }
        if (beforeId != null) {
            sql.append(" AND id < ?");
            params.add(beforeId);
        }
        sql.append(" ORDER BY id DESC LIMIT ?");
        params.add(limit);
        try (PreparedStatement statement = connection.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) {
                Object param = params.get(i);
                if (param instanceof Long number) {
                    statement.setLong(i + 1, number);
                } else if (param instanceof Integer number) {
                    statement.setInt(i + 1, number);
                } else {
                    statement.setString(i + 1, (String) param);
                }
            }
            List<LinkService.LinkEvent> events = new ArrayList<>();
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) events.add(readEvent(result));
            }
            return events;
        }
    }

    LinkService.LinkEvent latestEventByCorrelation(Connection connection, String requestId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                EVENT_SELECT + "WHERE correlation_id = ? ORDER BY id DESC LIMIT 1")) {
            statement.setString(1, requestId);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? readEvent(result) : null;
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Yardımcılar                                                           */
    /* ------------------------------------------------------------------ */

    private static boolean columnExists(Connection connection, String table, String column) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery("PRAGMA table_info(" + table + ")")) {
            while (result.next()) {
                if (column.equalsIgnoreCase(result.getString("name"))) return true;
            }
            return false;
        }
    }

    private static LinkService.LinkRecord queryOne(Connection connection, String sql, String value)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, value);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? readLink(result) : null;
            }
        }
    }

    private static List<LinkService.LinkRecord> readLinks(PreparedStatement statement) throws SQLException {
        List<LinkService.LinkRecord> links = new ArrayList<>();
        try (ResultSet result = statement.executeQuery()) {
            while (result.next()) links.add(readLink(result));
        }
        return links;
    }

    private static LinkService.LinkRecord readLink(ResultSet result) throws SQLException {
        UUID uuid = parseUuid(result.getString("uuid"));
        if (uuid == null) throw new SQLException("discord_links tablosunda geçersiz UUID kaydı");
        int elo = result.getInt("elo");
        Integer eloValue = result.wasNull() ? null : elo;
        return new LinkService.LinkRecord(
                uuid,
                result.getString("mc_name"),
                result.getString("current_name"),
                result.getString("discord_id"),
                result.getString("discord_tag"),
                result.getLong("linked_at"),
                result.getString("link_id"),
                eloValue);
    }

    private static LinkService.LinkEvent readEvent(ResultSet result) throws SQLException {
        return new LinkService.LinkEvent(
                result.getLong("id"),
                result.getLong("occurred_at"),
                result.getString("action"),
                result.getString("result"),
                parseUuid(result.getString("uuid")),
                result.getString("mc_name"),
                result.getString("discord_id"),
                result.getString("discord_tag"),
                result.getString("link_id"),
                result.getString("actor_type"),
                result.getString("actor_id"),
                result.getString("actor_name"),
                result.getString("source"),
                result.getString("reason"),
                result.getString("correlation_id"));
    }

    private static UUID parseUuid(String raw) {
        if (raw == null) return null;
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    static String limit(String value, int max) {
        if (value == null) return null;
        return value.length() <= max ? value : value.substring(0, max);
    }
}
