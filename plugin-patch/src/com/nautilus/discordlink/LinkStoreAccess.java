package com.nautilus.discordlink;

import com.nautilus.storage.DataStore;

import javax.sql.DataSource;
import java.lang.reflect.Field;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.UUID;

/** Link tablosu için hata yutmayan ve mevcut bağı asla ezmeyen işlemler. */
final class LinkStoreAccess {
    private final DataSource dataSource;

    LinkStoreAccess(DataStore store) {
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

    DataStore.LinkRow byDiscord(String discordId) {
        return query("discord_id=?", discordId);
    }

    /**
     * INSERT OR IGNORE + aynı transaction içindeki okumalar bir compare-and-set
     * oluşturur. UUID'ye bağlı mevcut Discord hiçbir koşulda overwrite edilmez.
     */
    CreateResult createIfAbsent(DataStore.LinkRow desired) {
        try (Connection connection = this.dataSource.getConnection()) {
            boolean originalAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement statement = connection.prepareStatement(
                        "INSERT OR IGNORE INTO discord_links "
                                + "(uuid,mc_name,discord_id,discord_tag,linked_at) "
                                + "VALUES (?,?,?,?,?)")) {
                    bind(statement, desired);
                    statement.executeUpdate();
                }

                DataStore.LinkRow byUuid = query(connection, "uuid=?", desired.uuid().toString());
                DataStore.LinkRow byDiscord = query(
                        connection, "discord_id=?", desired.discordId());
                CreateResult result;
                if (byUuid != null) {
                    result = desired.discordId().equals(byUuid.discordId())
                            ? new CreateResult(CreateState.LINKED, byUuid)
                            : new CreateResult(CreateState.UUID_ALREADY_LINKED, byUuid);
                } else if (byDiscord != null) {
                    result = new CreateResult(CreateState.DISCORD_ALREADY_LINKED, byDiscord);
                } else {
                    throw new SQLException("Bağlantı eklenemedi ve çakışan kayıt bulunamadı");
                }
                connection.commit();
                connection.setAutoCommit(originalAutoCommit);
                return result;
            } catch (SQLException | RuntimeException error) {
                try {
                    connection.rollback();
                } catch (SQLException rollbackError) {
                    error.addSuppressed(rollbackError);
                }
                throw error;
            }
        } catch (SQLException error) {
            throw new IllegalStateException("Discord bağlantı deposu işlemi başarısız", error);
        }
    }

    private DataStore.LinkRow query(String where, String value) {
        try (Connection connection = this.dataSource.getConnection()) {
            return query(connection, where, value);
        } catch (SQLException error) {
            throw new IllegalStateException("Discord bağlantı deposu okunamadı", error);
        }
    }

    private static DataStore.LinkRow query(Connection connection, String where, String value)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT uuid,mc_name,discord_id,discord_tag,linked_at "
                        + "FROM discord_links WHERE " + where + " LIMIT 1")) {
            statement.setString(1, value);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return null;
                return new DataStore.LinkRow(
                        UUID.fromString(result.getString("uuid")),
                        result.getString("mc_name"),
                        result.getString("discord_id"),
                        result.getString("discord_tag"),
                        result.getLong("linked_at"));
            }
        }
    }

    private static void bind(PreparedStatement statement, DataStore.LinkRow row)
            throws SQLException {
        statement.setString(1, row.uuid().toString());
        statement.setString(2, row.mcName());
        statement.setString(3, row.discordId());
        statement.setString(4, row.discordTag());
        statement.setLong(5, row.linkedAt());
    }

    enum CreateState {
        LINKED,
        UUID_ALREADY_LINKED,
        DISCORD_ALREADY_LINKED
    }

    record CreateResult(CreateState state, DataStore.LinkRow row) { }
}
