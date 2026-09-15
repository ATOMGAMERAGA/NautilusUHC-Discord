import com.nautilus.discordlink.LinkService;
import com.nautilus.storage.DataStore;

import javax.sql.DataSource;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.logging.Logger;

/**
 * Gerçek DataStore + SQLite ile izole test ortamı. Yalnız 1.2.1'de de bulunan
 * API'yi kullanır; böylece regresyon testleriyle birlikte eski JAR'a karşı da derlenir.
 */
final class LinkTestEnv implements AutoCloseable {
    static final String PENDING_FILE_PROPERTY = "nautilus.link.pending-file";

    final Path root;
    final Path database;
    final Path pending;
    final DataStore store;

    LinkTestEnv(String name) throws Exception {
        this.root = Files.createTempDirectory("nautilus-link-" + name + "-");
        this.database = this.root.resolve("nautilus-main.db");
        this.pending = this.root.resolve("pending-link-codes.dat");
        System.setProperty(PENDING_FILE_PROPERTY, this.pending.toString());
        this.store = new DataStore(this.database.toFile(), Logger.getAnonymousLogger());
    }

    /** Aynı depo üzerinde yeni servis örneği (plugin restart'ı / stale örnek). */
    LinkService service() {
        System.setProperty(PENDING_FILE_PROPERTY, this.pending.toString());
        return new LinkService(this.store);
    }

    /** players tablosuna (isim değişikliği/çevrimdışı oyuncu kaydı) yazar. */
    void player(java.util.UUID uuid, String name) throws Exception {
        update("INSERT INTO players (uuid, name, updated_at) VALUES (?, ?, 0) "
                + "ON CONFLICT(uuid) DO UPDATE SET name = excluded.name", uuid.toString(), name);
    }

    int update(String sql, Object... params) throws Exception {
        try (Connection connection = pool().getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, params);
            return statement.executeUpdate();
        }
    }

    String string(String sql, Object... params) throws Exception {
        try (Connection connection = pool().getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, params);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? result.getString(1) : null;
            }
        }
    }

    long number(String sql, Object... params) throws Exception {
        try (Connection connection = pool().getConnection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            bind(statement, params);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? result.getLong(1) : -1L;
            }
        }
    }

    DataSource pool() throws Exception {
        Field field = DataStore.class.getDeclaredField("pool");
        field.setAccessible(true);
        return (DataSource) field.get(this.store);
    }

    private static void bind(PreparedStatement statement, Object... params) throws Exception {
        for (int i = 0; i < params.length; i++) {
            Object value = params[i];
            statement.setObject(i + 1, value instanceof java.util.UUID ? value.toString() : value);
        }
    }

    @Override
    public void close() {
        this.store.close();
    }

    static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
