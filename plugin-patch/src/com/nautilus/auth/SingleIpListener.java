package com.nautilus.auth;

import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.Map;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerLoginEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;

/** All Bukkit access and connection state changes happen on the server thread. */
public final class SingleIpListener implements Listener {
    private static final long PENDING_TIMEOUT_TICKS = 20L * 60L;
    private static final Component DUPLICATE_MESSAGE = Component.text(
            "Aynı IP adresinden yalnızca bir oyuncu çevrimiçi olabilir. Önce diğer hesabınızdan çıkın.");
    private final Plugin plugin;
    private final SingleIpSessions sessions = new SingleIpSessions();
    // A new connection may reuse a UUID. Keep the actual Player reference so an
    // old connection's quit cannot remove the new connection's reservation.
    private final Map<Player, Connection> connections = new IdentityHashMap<>();
    private final Map<PlayerLoginEvent, Connection> logins = new IdentityHashMap<>();

    private static final class Connection {
        private final SingleIpSessions.Claim claim;
        private BukkitTask timeout;
        private boolean joined;

        private Connection(SingleIpSessions.Claim claim) {
            this.claim = claim;
        }
    }

    private SingleIpListener(Plugin plugin) {
        this.plugin = plugin;
    }

    public static void install(Plugin plugin) {
        SingleIpListener listener = new SingleIpListener(plugin);
        Bukkit.getPluginManager().registerEvents(listener, plugin);
        // Also covers plugin installation/reload while players are in the lobby.
        for (Player player : new ArrayList<>(Bukkit.getOnlinePlayers())) {
            InetSocketAddress address = player.getAddress();
            if (address == null || address.getAddress() == null) continue;
            SingleIpSessions.Claim claim = listener.sessions.claim(address.getAddress(), player.getUniqueId());
            if (claim == null) {
                player.kick(DUPLICATE_MESSAGE);
            } else {
                Connection connection = new Connection(claim);
                connection.joined = true;
                listener.connections.put(player, connection);
            }
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onLogin(PlayerLoginEvent event) {
        if (event.getResult() != PlayerLoginEvent.Result.ALLOWED) return;
        Player player = event.getPlayer();
        SingleIpSessions.Claim claim = sessions.claim(event.getAddress(), player.getUniqueId());
        if (claim == null) {
            event.disallow(PlayerLoginEvent.Result.KICK_OTHER, DUPLICATE_MESSAGE);
            return;
        }
        Connection connection = new Connection(claim);
        connections.put(player, connection);
        logins.put(event, connection);
        connection.timeout = Bukkit.getScheduler().runTaskLater(plugin, () -> {
            connection.timeout = null;
            if (connections.get(player) != connection || connection.joined) return;
            // Player.isOnline() checks UUID presence, which can describe a
            // different connection after a reconnect. Compare this session.
            if (Bukkit.getPlayer(player.getUniqueId()) == player) {
                connection.joined = true;
            } else {
                release(player, connection);
            }
        }, PENDING_TIMEOUT_TICKS);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void afterLogin(PlayerLoginEvent event) {
        Connection connection = logins.remove(event);
        if (connection != null && event.getResult() != PlayerLoginEvent.Result.ALLOWED) {
            release(event.getPlayer(), connection);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        Connection connection = connections.get(player);
        if (connection == null) {
            // An unusually delayed configuration phase may outlive the pending
            // timeout. Re-check ownership before keeping that player online.
            InetSocketAddress address = player.getAddress();
            SingleIpSessions.Claim claim = address == null || address.getAddress() == null
                    ? null : sessions.claim(address.getAddress(), player.getUniqueId());
            if (claim == null) {
                player.kick(DUPLICATE_MESSAGE);
                return;
            }
            connection = new Connection(claim);
            connections.put(player, connection);
        }
        connection.joined = true;
        cancelTimeout(connection);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        Connection connection = connections.get(event.getPlayer());
        if (connection != null) release(event.getPlayer(), connection);
    }

    private void release(Player player, Connection connection) {
        cancelTimeout(connection);
        if (connections.get(player) == connection) connections.remove(player);
        sessions.release(connection.claim);
    }

    private static void cancelTimeout(Connection connection) {
        if (connection.timeout != null) {
            connection.timeout.cancel();
            connection.timeout = null;
        }
    }
}
