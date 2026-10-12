/*
 * Decompiled with CFR 0.152.
 *
 * Could not load the following classes:
 *  com.nautilus.NautilusUHC
 *  com.nautilus.bridge.BridgeClient
 *  com.nautilus.bridge.BridgeHttpServer
 *  com.nautilus.bridge.BridgePoller
 *  com.nautilus.bridge.BridgeSnapshots
 *  com.nautilus.bridge.MatchMessagePolicy
 *  com.nautilus.discordlink.LinkService
 *  com.nautilus.moderation.ModerationService
 *  com.nautilus.stats.EloEngine$Entrant
 *  com.nautilus.stats.EloEngine$Kill
 *  com.nautilus.stats.EloEngine$Result
 *  com.nautilus.stats.MatchHistoryService
 *  com.nautilus.stats.MatchTracker
 *  com.nautilus.stats.PlayerStats
 *  com.nautilus.stats.StatsService
 *  com.nautilus.storage.DataStore
 *  com.nautilus.storage.MatchData
 *  com.nautilus.storage.MatchData$KillSnapshot
 *  com.nautilus.storage.MatchData$Participant
 *  com.nautilus.storage.YamlStore
 *  com.nautilus.uhcmatch.UhcMatchManager
 *  net.kyori.adventure.text.Component
 *  net.kyori.adventure.text.TextComponent
 *  net.kyori.adventure.text.format.NamedTextColor
 *  net.kyori.adventure.text.format.TextColor
 *  net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer
 *  org.bukkit.Bukkit
 *  org.bukkit.World
 *  org.bukkit.entity.Player
 *  org.bukkit.plugin.Plugin
 */
package com.nautilus.bridge;

import com.nautilus.NautilusUHC;
import com.nautilus.bridge.BridgeClient;
import com.nautilus.bridge.BridgeHttpServer;
import com.nautilus.bridge.BridgePoller;
import com.nautilus.bridge.BridgeSnapshots;
import com.nautilus.bridge.MatchMessagePolicy;
import com.nautilus.discordlink.LinkService;
import com.nautilus.moderation.ModerationService;
import com.nautilus.stats.EloEngine;
import com.nautilus.stats.MatchHistoryService;
import com.nautilus.stats.MatchTracker;
import com.nautilus.stats.PlayerStats;
import com.nautilus.stats.StatsService;
import com.nautilus.storage.DataStore;
import com.nautilus.storage.MatchData;
import com.nautilus.storage.YamlStore;
import com.nautilus.uhcmatch.UhcMatchManager;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;

public final class NautilusIntegration {
    private final NautilusUHC plugin;
    private final ModerationService moderation;
    private final DataStore store;
    private final StatsService stats;
    private final MatchHistoryService history;
    private final LinkService links;
    private final BridgeClient bridge;
    private MatchTracker tracker;
    private BridgeHttpServer http;
    private BridgePoller poller;
    private volatile long openMatchId = -1L;

    public NautilusIntegration(NautilusUHC plugin, ModerationService moderation) {
        this.plugin = plugin;
        this.moderation = moderation;
        this.store = new DataStore(NautilusIntegration.resolveDbFile(plugin), plugin.getLogger());
        YamlStore.init((DataStore)this.store, (Plugin)plugin);
        this.stats = new StatsService(plugin, this.store);
        this.history = new MatchHistoryService(plugin, this.store);
        this.links = new LinkService(this.store);
        this.bridge = new BridgeClient((Plugin)plugin);
        this.stats.setBridge(this.bridge);
        this.moderation.wire(this.store, this.bridge);
    }

    public void attachMatch(UhcMatchManager match) {
        this.tracker = new MatchTracker(match);
        BridgeSnapshots snapshots = new BridgeSnapshots(this.plugin, this.stats, this.moderation, this.store);
        this.http = new BridgeHttpServer(this.plugin, snapshots, this.stats, this.moderation, this.links, this.store, this.bridge);
    }

    public void startHttp() {
        if (this.http != null) {
            this.http.start();
        }
        this.logBridgeDiagnostics();
        this.poller = new BridgePoller((Plugin)this.plugin);
        this.poller.start();
    }

    public void shutdown() {
        if (this.poller != null) {
            this.poller.stop();
            this.poller = null;
        }
        if (this.http != null) {
            this.http.stop();
        }
        this.stats.save();
        YamlStore.shutdown();
        this.backupDatabase();
        this.store.close();
    }

    private void logBridgeDiagnostics() {
        boolean bridgeOn = this.plugin.getConfig().getBoolean("bridge.enabled", false);
        String botUrl = this.plugin.getConfig().getString("bridge.bot-url", "");
        String token = this.plugin.getConfig().getString("bridge.token", "");
        if (!bridgeOn) {
            return;
        }
        if (botUrl == null || botUrl.isBlank()) {
            this.plugin.getLogger().severe("K\u00d6PR\u00dc EKS\u0130K AYAR: bridge.bot-url BO\u015e. Discord'a ma\u00e7 ba\u015flang\u0131\u00e7/sonu\u00e7 duyurusu G\u00d6NDER\u0130LEMEZ. config.yml'de bot adresini yaz, \u00f6rn: bridge.bot-url: https://bot.nautilusuhc.com");
        }
        if (token == null || token.isBlank()) {
            this.plugin.getLogger().severe("K\u00d6PR\u00dc EKS\u0130K AYAR: bridge.token BO\u015e. Botun BRIDGE_SECRET de\u011feriyle birebir ayn\u0131 olmal\u0131.");
        }
        if (!this.plugin.getConfig().getBoolean("bridge.public-stats.enabled", false)) {
            this.plugin.getLogger().warning("bridge.public-stats.enabled kapal\u0131 \u2014 web sitesi lider tablosu/canl\u0131 ma\u00e7 verisini alamaz. Ters k\u00f6pr\u00fcde bu u\u00e7lar internete A\u00c7ILMAZ, yaln\u0131z bot \u00fczerinden okunur; a\u00e7\u0131k b\u0131rakmak g\u00fcvenlidir.");
        }
        if (this.bridge.enabled()) {
            this.plugin.getLogger().info("K\u00f6pr\u00fc eventleri etkin \u2192 " + botUrl);
        }
    }

    private static File resolveDbFile(NautilusUHC plugin) {
        File dbFile = new File(plugin.getDataFolder(), "nautilus-main.db");
        File legacy = new File(plugin.getDataFolder(), "nautilus.db");
        if (!dbFile.exists() && legacy.exists()) {
            boolean ok = true;
            for (String suffix : new String[]{"", "-wal", "-shm"}) {
                File from = new File(plugin.getDataFolder(), "nautilus.db" + suffix);
                File to = new File(plugin.getDataFolder(), "nautilus-main.db" + suffix);
                if (!from.exists() || from.renameTo(to)) continue;
                ok = false;
            }
            if (ok) {
                plugin.getLogger().info("Veritaban\u0131 nautilus.db \u2192 nautilus-main.db olarak ta\u015f\u0131nd\u0131.");
            } else {
                plugin.getLogger().warning("nautilus.db yeni ada ta\u015f\u0131namad\u0131; eski dosya kullan\u0131lacak.");
                return legacy;
            }
        }
        return dbFile;
    }

    private void backupDatabase() {
        try {
            File[] backups;
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss").format(new Date());
            File backupDir = new File(this.plugin.getDataFolder(), "backups");
            File target = new File(backupDir, "nautilus-main-" + stamp + ".db");
            if (this.store.backupTo(target)) {
                this.plugin.getLogger().info("Kapan\u0131\u015f yede\u011fi al\u0131nd\u0131: backups/" + target.getName());
            }
            if ((backups = backupDir.listFiles((dir, name) -> name.startsWith("nautilus-main-") && name.endsWith(".db"))) != null && backups.length > 10) {
                Arrays.sort(backups, Comparator.comparing(File::getName));
                for (int i = 0; i < backups.length - 10; ++i) {
                    if (backups[i].delete()) continue;
                    this.plugin.getLogger().warning("Eski yedek silinemedi: " + backups[i].getName());
                }
            }
        }
        catch (Throwable t) {
            this.plugin.getLogger().warning("Kapan\u0131\u015f yede\u011fi al\u0131namad\u0131: " + t.getMessage());
        }
    }

    public DataStore store() {
        return this.store;
    }

    public StatsService stats() {
        return this.stats;
    }

    public LinkService links() {
        return this.links;
    }

    public BridgeClient bridge() {
        return this.bridge;
    }

    public MatchTracker tracker() {
        return this.tracker;
    }

    public ModerationService moderation() {
        return this.moderation;
    }

    public void onMatchStarted(String host, int players, List<String> scenarioKeys) {
        if (this.tracker != null) {
            this.tracker.begin(scenarioKeys);
        }
        long seed = 0L;
        UhcMatchManager uhc = this.plugin.getUhcMatch();
        if (uhc != null && uhc.world() != null) {
            seed = uhc.world().getSeed();
        }
        long startedAt = System.currentTimeMillis();
        long matchSeed = seed;
        this.store.submitWrite(() -> {
            this.openMatchId = this.store.openMatch(matchSeed, startedAt);
        });
        com.nautilus.admin.AnnouncementRuntime.start(this.plugin,host,scenarioKeys);
        if (this.bridge.enabled()) {
            this.bridge.matchStart(host, players, scenarioKeys, false);
        }
    }

    public void onPhase(String phase, long elapsedSecs, int aliveCount, Integer borderSize) {
        if (this.bridge.enabled() && this.plugin.getConfig().getBoolean("bridge.events.phase-change", true)) {
            this.bridge.phaseChange(phase, elapsedSecs, aliveCount, borderSize, false);
        }
    }

    public void onMatchCancelled(String host, String reason) {
        com.nautilus.admin.AnnouncementRuntime.clear();
        if (this.tracker != null) {
            this.tracker.reset();
        }
        long endedAt = System.currentTimeMillis();
        this.store.submitWrite(() -> {
            long openId = this.openMatchId;
            this.openMatchId = -1L;
            if (openId > 0L) {
                this.store.closeOpenMatch(openId, "ABORTED", endedAt);
            }
        });
        if (this.bridge.enabled()) {
            this.bridge.matchCancelled("-", host, reason, false);
        }
    }

    public void completeMatch(Object winner, Set<UUID> participants, Set<UUID> alive, long durationSecs, World world, String host) {
        UUID uuid;
        if (this.tracker == null) {
            return;
        }
        this.tracker.captureSurvivors(alive);
        LinkedHashSet<UUID> played = new LinkedHashSet<UUID>(this.tracker.eliminationOrder());
        played.addAll(alive);
        if (played.isEmpty()) {
            this.tracker.reset();
            return;
        }
        Map<UUID,Integer> placement = this.tracker.placements(alive, played);
        LinkedHashSet<UUID> winners = new LinkedHashSet<UUID>();
        String winnerName = null;
        String winnerTeam = null;
        if (winner instanceof Integer) {
            Integer teamNumber = (Integer)winner;
            winnerTeam = "takim-" + teamNumber;
            for (UUID uUID : this.plugin.getTeams().getMembers(teamNumber.intValue())) {
                if (!played.contains(uUID)) continue;
                winners.add(uUID);
            }
            winnerName = PlainTextComponentSerializer.plainText().serialize(this.plugin.getTeams().displayName(teamNumber.intValue()));
        } else if (winner instanceof UUID && played.contains(uuid = (UUID)winner)) {
            Object teamNumber;
            Player p;
            winners.add(uuid);
            winnerName = this.stats.get(uuid).name();
            if ("?".equals(winnerName) && (p = Bukkit.getPlayer((UUID)uuid)) != null) {
                winnerName = p.getName();
            }
            if ((teamNumber = this.plugin.getTeams().getTeam(uuid)) != null) {
                winnerTeam = "takim-" + (Integer)teamNumber;
            }
        }
        ArrayList<EloEngine.Entrant> entrants = new ArrayList<EloEngine.Entrant>();
        HashMap<UUID, Integer> deaths = new HashMap<UUID, Integer>();
        for (UUID uUID : played) {
            PlayerStats s = this.stats.get(uUID);
            entrants.add(new EloEngine.Entrant(uUID, s.elo(), s.games(), placement.getOrDefault(uUID, played.size()).intValue(), this.tracker.killsOf(uUID)));
            deaths.put(uUID, this.tracker.deathsOf(uUID));
        }
        ArrayList<EloEngine.Kill> kills = new ArrayList<EloEngine.Kill>();
        for (MatchData.KillSnapshot k : this.tracker.killSnapshots()) {
            if (!played.contains(k.killerUuid()) || !played.contains(k.victimUuid())) continue;
            kills.add(new EloEngine.Kill(k.killerUuid(), k.victimUuid()));
        }
        for (UUID uuid3 : played) {
            if (winners.contains(uuid3)) {
                this.stats.addWin(uuid3);
            } else {
                this.stats.markLoss(uuid3);
            }
            this.stats.addPlaytime(uuid3, this.tracker.playtimeOf(uuid3, durationSecs));
        }
        List<EloEngine.Result> list = this.stats.applyElo(entrants, kills, winners, deaths);
        HashMap<UUID, EloEngine.Result> byUuid = new HashMap<UUID, EloEngine.Result>();
        for (EloEngine.Result r : list) {
            byUuid.put(r.uuid(), r);
        }
        for (UUID uuid4 : played) {
            Player player;
            EloEngine.Result r = (EloEngine.Result)byUuid.get(uuid4);
            if (r == null || (player = Bukkit.getPlayer((UUID)uuid4)) == null) continue;
            int delta = r.delta();
            String sign = delta >= 0 ? "+" : "";
            MatchMessagePolicy.suppressEloMessage((Player)player, (Component)Component.text((String)("Elo: " + sign + delta + " (" + r.eloAfter() + ")"), (TextColor)(delta >= 0 ? NamedTextColor.GREEN : NamedTextColor.RED)));
        }
        double winnerHealth = 0.0;
        for (UUID uUID : winners) {
            Player p = Bukkit.getPlayer((UUID)uUID);
            if (p == null) continue;
            winnerHealth = Math.max(winnerHealth, p.getHealth());
        }
        ArrayList<MatchData.Participant> participantRows = new ArrayList<MatchData.Participant>();
        for (UUID uuid6 : played) {
            PlayerStats s = this.stats.get(uuid6);
            EloEngine.Result r = (EloEngine.Result)byUuid.get(uuid6);
            Integer teamNumber = this.plugin.getTeams().getTeam(uuid6);
            participantRows.add(new MatchData.Participant(uuid6, s.name(), teamNumber != null ? "takim-" + teamNumber : null, this.tracker.killsOf(uuid6), this.tracker.deathsOf(uuid6), placement.getOrDefault(uuid6, played.size()).intValue(), alive.contains(uuid6), r != null ? r.eloBefore() : s.elo(), r != null ? r.eloAfter() : s.elo()));
        }
        String string = String.join((CharSequence)",", this.tracker.activeScenarios());
        long now = System.currentTimeMillis();
        MatchData data = new MatchData(world != null ? world.getSeed() : 0L, winnerName, winnerTeam, winnerTeam, durationSecs, string, played.size(), now, now - durationSecs * 1000L, winnerHealth, participantRows, this.tracker.inventories(), this.tracker.killSnapshots());
        ArrayList topKills = new ArrayList();
        played.stream().sorted(Comparator.<UUID>comparingInt(u -> this.tracker.killsOf(u)).reversed()).limit(5L).forEach(u -> topKills.add(new AbstractMap.SimpleEntry<String, Integer>(this.stats.get(u).name(), this.tracker.killsOf(u))));
        String mvpName = null;
        int mvpKills = 0;
        if (!topKills.isEmpty() && (Integer)((Map.Entry)topKills.get(0)).getValue() > 0) {
            mvpName = (String)((Map.Entry)topKills.get(0)).getKey();
            mvpKills = (Integer)((Map.Entry)topKills.get(0)).getValue();
        }
        if (mvpName != null) {
            MatchMessagePolicy.broadcastMvpToOps((Component)((TextComponent)Component.text((String)"\ud83c\udfc6 Ma\u00e7\u0131n MVP'si: ", (TextColor)NamedTextColor.GOLD).append((Component)Component.text(mvpName, (TextColor)NamedTextColor.AQUA))).append((Component)Component.text((String)(" (" + mvpKills + " kill)"), (TextColor)NamedTextColor.GRAY)));
        }
        String finalWinner = winnerName;
        String finalMvpName = mvpName;
        int finalMvpKills = mvpKills;
        int playedCount = played.size();
        List<String> winnerNames=winners.stream().map(uuidWinner->{
            String name=this.stats.get(uuidWinner).name();Player player=Bukkit.getPlayer(uuidWinner);
            return player!=null?player.getName():name==null||name.equals("?")?uuidWinner.toString():name;
        }).toList();
        com.nautilus.admin.MatchAnnouncementContext.Completion announcement=com.nautilus.admin.AnnouncementRuntime.captureEnd(this.plugin,host,this.tracker.activeScenarios(),winnerNames);
        this.history.record(data, () -> {
            long openId = this.openMatchId;
            this.openMatchId = -1L;
            return openId;
        }, id -> {
            if (id > 0L && finalMvpName != null) {
                this.store.updateMatchMvp(id, finalMvpName, 0, finalMvpKills);
            }
            if (this.bridge.enabled()) {
                com.nautilus.admin.AnnouncementRuntime.withCompleted(announcement,()->this.bridge.matchEnd(id, finalWinner, durationSecs, playedCount, topKills, finalMvpName, finalMvpKills, false));
            }
        });
        this.tracker.reset();
    }
}
