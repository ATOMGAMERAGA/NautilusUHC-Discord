/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  org.bukkit.Bukkit
 *  org.bukkit.command.CommandSender
 *  org.bukkit.entity.Player
 *  org.bukkit.plugin.Plugin
 *  org.bukkit.scheduler.BukkitTask
 */
package com.nautilus.schedule;

import com.nautilus.NautilusUHC;
import com.nautilus.admin.AdminBootstrap;
import com.nautilus.admin.ScheduleBook;
import com.nautilus.admin.StartCoordinator;
import com.nautilus.admin.WorldSelection;
import com.nautilus.reset.WorldRotationService;
import com.nautilus.scenarios.Scenario;
import com.nautilus.util.TimeService;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.logging.Level;
import org.bukkit.Bukkit;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;

public final class MatchScheduleService {
    public static final DateTimeFormatter HHMM = DateTimeFormatter.ofPattern("HH:mm");
    private final NautilusUHC plugin;
    private ScheduleBook book;
    private String storageError;
    private BukkitTask task;
    private final Set<UUID> queue = new LinkedHashSet<UUID>();
    private final Map<UUID, List<String>> hostOptions = new HashMap<UUID, List<String>>();
    private final Set<UUID> entryOpened = new HashSet<UUID>();

    public MatchScheduleService(NautilusUHC nautilusUHC) {
        this.plugin = nautilusUHC;
        try {
            this.book = new ScheduleBook(nautilusUHC.getDataFolder().toPath().resolve("admin-schedule.properties"), 120000L, (long)Math.max(5, nautilusUHC.getConfig().getInt("uhcAdmin.schedule.minIntervalMinutes", 90)) * 60000L);
        }
        catch (Exception exception) {
            this.storageError = "Ma\u00e7 takvimi okunamad\u0131; dosya korunuyor. Konsolu kontrol et.";
            nautilusUHC.getLogger().log(Level.SEVERE, this.storageError, exception);
        }
    }

    public ZoneId zone() {
        return ScheduleBook.ZONE;
    }

    public long todayAt(int n, int n2) {
        return ScheduleBook.at(Instant.ofEpochMilli(TimeService.currentMillis()).atZone(this.zone()).toLocalDate(), n, n2);
    }

    public String storageError() {
        return this.storageError;
    }

    public String validate(long l) {
        return this.storageError != null ? this.storageError : this.book.validate(TimeService.currentMillis(), l);
    }

    public String schedule(String string, UUID uUID, long l, List<String> list) {
        return this.schedule(string, uUID, l, list, 1.0);
    }

    public String schedule(String string, UUID uUID, long l, List<String> list, double d) {
        return this.scheduleDetailed(string, uUID, l, list, d, "", this.plugin.getTeams().getLimit(), true);
    }

    public String scheduleDetailed(String string2, UUID uUID, long l, List<String> list, double d, String string3, int n, boolean bl) {
        return scheduleDetailed(string2,uUID,l,list,d,string3,n,bl,com.nautilus.admin.AnnouncementSettings.DEFAULT);
    }

    public String scheduleDetailed(String string2,UUID uUID,long l,List<String> list,double d,String string3,int n,boolean bl,com.nautilus.admin.AnnouncementSettings announcement) {
        if (this.storageError != null) {return this.storageError;}
        if (string3 == null) {
            return "Ge\u00e7ersiz d\u00fcnya se\u00e7imi.";
        }
        if (list == null || list.stream().anyMatch(string -> Scenario.byKey(string) == null)) {
            return "Bilinmeyen senaryo se\u00e7ildi.";
        }
        if (!string3.isEmpty() && !this.available(string3)) {
            return "Se\u00e7ilen d\u00fcnya art\u0131k haz\u0131r de\u011fil.";
        }
        if (!string3.isEmpty() && this.upcoming().stream().anyMatch(entry -> string3.equals(entry.worldName))) {
            return "Bu d\u00fcnya ba\u015fka bir planlanm\u0131\u015f ma\u00e7a ayr\u0131lm\u0131\u015f.";
        }
        if (bl && !this.bridgeAvailable()) {
            return "Discord k\u00f6pr\u00fcs\u00fc haz\u0131r de\u011fil; \u00f6nce ba\u011flant\u0131y\u0131 ayarla veya Discord duyurusunu kapat.";
        }
        try {
            ScheduleBook.Plan plan = this.book.add(TimeService.currentMillis(), l, string2, uUID, list, d, string3, n, bl,announcement);
            if (bl) {
                this.notifySafely(() -> this.scheduledNotice(new Entry(plan)));
            }
            return null;
        }
        catch (RuntimeException runtimeException) {
            this.plugin.getLogger().log(Level.WARNING, "UHC planlama i\u015flemi uygulanamad\u0131", runtimeException);
            return runtimeException.getMessage();
        }
    }

    private boolean available(String string) {
        WorldRotationService worldRotationService = this.plugin.getWorldRotation();
        return worldRotationService != null && (worldRotationService.readyPoolWorldNames().contains(string) || worldRotationService.currentOrNull() != null && worldRotationService.currentOrNull().getName().equals(string) && worldRotationService.isPrepared());
    }

    public boolean bridgeAvailable() {
        return this.plugin.getIntegration() != null && this.plugin.getIntegration().bridge() != null && this.plugin.getIntegration().bridge().enabled();
    }

    public Entry cancel(UUID uUID, String string) {
        return this.upcoming().stream().filter(entry -> entry.hostId.equals(uUID)).findFirst().map(entry -> this.cancelById(entry.id, uUID, string)).orElse(null);
    }

    public Entry cancelById(UUID uUID, UUID uUID2, String string) {
        if (this.book == null) {
            return null;
        }
        ScheduleBook.Plan plan = this.book.get(uUID);
        if (plan == null || plan.status() != ScheduleBook.Status.PLANNED) {
            return null;
        }
        ScheduleBook.Plan plan2 = this.book.transition(uUID, ScheduleBook.Status.CANCELLED, string);
        if (plan2.announce() && this.bridgeAvailable()) {
            this.notifySafely(() -> this.plugin.getIntegration().bridge().matchCancelled(this.slot(plan2.startAt()), plan2.hostName(), string, true));
        }
        this.entryOpened.remove(uUID);
        return new Entry(plan2);
    }

    public List<Entry> upcoming() {
        return this.book == null ? List.of() : this.book.planned().stream().map(Entry::new).toList();
    }

    public List<Entry> allEntries() {
        return this.book == null ? List.of() : this.book.all().stream().map(Entry::new).toList();
    }

    public List<Entry> todayEntries() {
        LocalDate localDate = Instant.ofEpochMilli(TimeService.currentMillis()).atZone(this.zone()).toLocalDate();
        return this.allEntries().stream().filter(entry -> entry.status == ScheduleBook.Status.PLANNED || entry.status == ScheduleBook.Status.STARTED).filter(entry -> Instant.ofEpochMilli(entry.startAt).atZone(this.zone()).toLocalDate().equals(localDate)).toList();
    }

    public Entry next() {
        return this.upcoming().stream().findFirst().orElse(null);
    }

    public Entry find(UUID uUID) {
        return this.book == null || this.book.get(uUID) == null ? null : new Entry(this.book.get(uUID));
    }

    public synchronized boolean joinQueue(UUID uUID) {
        return uUID != null && this.queue.add(uUID);
    }

    public synchronized boolean leaveQueue(UUID uUID) {
        return this.queue.remove(uUID);
    }

    public synchronized List<UUID> queued() {
        return List.copyOf(this.queue);
    }

    public synchronized void clearQueue() {
        this.queue.clear();
    }

    public List<String> hostScenarios(UUID uUID) {
        return this.hostOptions.getOrDefault(uUID, this.plugin.getScenarios().enabledScenarios().stream().map(Scenario::key).toList());
    }

    public void setHostScenarios(UUID uUID, List<String> list) {
        this.hostOptions.put(uUID, List.copyOf(list));
    }

    public boolean toggleHostScenario(UUID uUID, Scenario scenario) {
        boolean bl;
        ArrayList<String> arrayList = new ArrayList<String>(this.hostScenarios(uUID));
        boolean bl2 = bl = !arrayList.remove(scenario.key());
        if (bl) {
            arrayList.add(scenario.key());
        }
        this.setHostScenarios(uUID, arrayList);
        return bl;
    }

    public void quickJoin(Player player) {
        if (this.plugin.getUhcHub() != null) {
            this.plugin.getUhcHub().sendToHub(player);
        }
    }

    public void startTask() {
        if (this.task == null && this.book != null && this.storageError == null) {
            this.task = Bukkit.getScheduler().runTaskTimer((Plugin)this.plugin, this::tick, 20L, 20L);
        }
    }

    public void stopTask() {
        if (this.task != null) {
            this.task.cancel();
            this.task = null;
        }
        this.queue.clear();
        this.hostOptions.clear();
        this.entryOpened.clear();
    }

    private String slot(long l) {
        return Instant.ofEpochMilli(l).atZone(this.zone()).format(DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"));
    }

    private void scheduledNotice(Entry entry) {
        com.nautilus.admin.AnnouncementRuntime.withScheduled(new com.nautilus.admin.MatchAnnouncementContext(entry.hostId,entry.hostName,entry.teamLimit,entry.scenarios,entry.announcement), () -> this.plugin.getIntegration().bridge().matchScheduled(this.slot(entry.startAt), entry.startAt, entry.hostName, entry.scenarios, true));
    }

    public String reannounce(UUID uUID) {
        Entry entry = this.find(uUID);
        if (entry == null || entry.status != ScheduleBook.Status.PLANNED) {
            return "Ma\u00e7 art\u0131k planlanm\u0131\u015f durumda de\u011fil.";
        }
        if (!this.bridgeAvailable()) {
            return "Discord k\u00f6pr\u00fcs\u00fc haz\u0131r de\u011fil.";
        }
        this.scheduledNotice(entry);
        return null;
    }

    private void tick() {
        long l = TimeService.currentMillis();
        long l2 = (long)Math.max(0, this.plugin.getConfig().getInt("uhcAdmin.schedule.lateGraceSeconds", 120)) * 1000L;
        for (final ScheduleBook.Plan plan : this.book.planned()) {
            try {
                long l3 = this.plugin.getConfig().getInt("uhcAdmin.schedule.openEntriesMinutesBefore", -1);
                if (l3 >= 0L && l >= plan.startAt() - l3 * 60000L && l < plan.startAt() && !this.plugin.getUhcMatch().isStarted() && this.entryOpened.add(plan.id()) && this.plugin.getUhcHub() != null) {
                    this.plugin.getUhcHub().setEntriesOpen(true);
                }
                if (l < plan.startAt()) continue;
                if (l - plan.startAt() > l2) {
                    this.fail(plan, ScheduleBook.Status.MISSED, "Sunucu planlanan saatte haz\u0131r de\u011fildi; ge\u00e7 ba\u015flayan ma\u00e7 engellendi.");
                    continue;
                }
                Object object = WorldSelection.preflight(this.plugin, plan.worldName());
                if (object != null) {
                    this.fail(plan, ScheduleBook.Status.FAILED, (String)object);
                    continue;
                }
                final Set<Scenario> set = this.plugin.getScenarios().enabledScenarios();
                final int n = this.plugin.getTeams().getLimit();
                final double d = this.plugin.getUhcMatch().timeScale();
                for (String string : plan.scenarios()) {
                    if (Scenario.byKey(string) != null) continue;
                    object = "Planlanan senaryo bulunamad\u0131: " + string;
                    break;
                }
                if (object != null) {
                    this.fail(plan, ScheduleBook.Status.FAILED, (String)object);
                    continue;
                }
                StartCoordinator.Outcome outcome = StartCoordinator.execute(this.book, plan, new StartCoordinator.Port(){

                    @Override
                    public String prepare() {
                        if(plan.teamLimit()>1 && MatchScheduleService.this.plugin.getTeams().teamNumbers().stream().anyMatch(team->MatchScheduleService.this.plugin.getTeams().memberCount(team)>plan.teamLimit()))return "Mevcut takım planlanan boyuttan büyük; önce takımları düzenle.";
                        return WorldSelection.prepareForStart(MatchScheduleService.this.plugin, plan.worldName());
                    }

                    @Override
                    public void apply() {
                        if(plan.teamLimit()==1)MatchScheduleService.this.plugin.getTeams().clearAssignments();
                        MatchScheduleService.this.plugin.getTeams().setLimit(plan.teamLimit());
                        MatchScheduleService.this.plugin.getScenarios().disableAll();
                        for (String string : plan.scenarios()) {
                            MatchScheduleService.this.plugin.getScenarios().enableScenario(Scenario.byKey(string));
                        }
                        MatchScheduleService.this.plugin.getUhcMatch().setTimeScale(plan.timeScale());
                        MatchScheduleService.this.plugin.getUhcMatch().setScenarioOverride(plan.scenarios());
                    }

                    @Override
                    public boolean start() {
                        final boolean[] result={false};
                        com.nautilus.admin.AnnouncementRuntime.launch(MatchScheduleService.this.plugin,new com.nautilus.admin.MatchAnnouncementContext(plan.hostId(),plan.hostName(),plan.teamLimit(),plan.scenarios(),plan.announcement()),()->result[0]=MatchScheduleService.this.plugin.getUhcMatch().forceStartScheduled(plan.hostName()));
                        boolean accepted=result[0];
                        if(accepted) com.nautilus.admin.LaunchAnnouncement.mark(com.nautilus.bridge.FeatureBridge.matchEpoch(MatchScheduleService.this.plugin),plan.announce());
                        return accepted;
                    }

                    @Override
                    public boolean active() {
                        return MatchScheduleService.this.plugin.getUhcMatch().isStarted();
                    }

                    @Override
                    public boolean running() {
                        return MatchScheduleService.this.plugin.getUhcMatch().isRunning();
                    }

                    @Override
                    public void cancel() {
                        MatchScheduleService.this.plugin.getUhcMatch().cancelCountdown((CommandSender)Bukkit.getConsoleSender());
                    }

                    @Override
                    public void closeGate() {
                        if (MatchScheduleService.this.plugin.getUhcHub() != null) {
                            MatchScheduleService.this.plugin.getUhcHub().setEntriesOpen(false);
                        }
                    }

                    @Override
                    public void restore() {
                        MatchScheduleService.this.plugin.getTeams().setLimit(n);
                        MatchScheduleService.this.plugin.getUhcMatch().setTimeScale(d);
                        MatchScheduleService.this.plugin.getUhcMatch().setScenarioOverride(null);
                        MatchScheduleService.this.plugin.getScenarios().disableAll();
                        for (Scenario scenario : set) {
                            MatchScheduleService.this.plugin.getScenarios().enableScenario(scenario);
                        }
                    }
                });
                if (!outcome.accepted()) {
                    this.notifyFailure(plan, outcome.error());
                }
                if (outcome.error() != null) {
                    this.plugin.getLogger().warning(outcome.error());
                }
                if (!outcome.stopScheduler()) continue;
                this.storageError = outcome.error();
                this.stopTask();
                return;
            }
            catch (Exception exception) {
                this.plugin.getLogger().log(Level.SEVERE, "Planlanm\u0131\u015f UHC ba\u015flat\u0131lamad\u0131", exception);
                ScheduleBook.Plan plan2 = this.book.get(plan.id());
                if (plan2 != null && plan2.status() == ScheduleBook.Status.STARTING && this.plugin.getUhcMatch().isStarted()) {
                    this.storageError = "Ba\u015flang\u0131\u00e7 sonucu belirsiz; \u00e7al\u0131\u015fan ma\u00e7 korundu ve otomatik planlama durduruldu.";
                    this.stopTask();
                    return;
                }
                if (plan2 == null || plan2.status() != ScheduleBook.Status.STARTING && plan2.status() != ScheduleBook.Status.PLANNED) continue;
                try {
                    this.fail(plan2, ScheduleBook.Status.FAILED, "Ba\u015flang\u0131\u00e7 hatas\u0131; konsolu kontrol et.");
                }
                catch (Exception exception2) {
                    this.plugin.getLogger().log(Level.SEVERE, "Ba\u015flang\u0131\u00e7 sonucu kaydedilemedi", exception2);
                    this.storageError = "Takvim diske yaz\u0131lamad\u0131; otomatik planlama durduruldu.";
                    this.stopTask();
                    return;
                }
            }
        }
    }

    private void fail(ScheduleBook.Plan plan, ScheduleBook.Status status, String string) {
        this.book.transition(plan.id(), status, string);
        this.notifyFailure(plan, string);
    }

    private void notifyFailure(ScheduleBook.Plan plan, String string) {
        this.plugin.getLogger().warning("UHC plan\u0131 " + String.valueOf(plan.id()) + ": " + string);
        Player player = Bukkit.getPlayer((UUID)plan.hostId());
        if (player != null) {
            player.sendMessage("\u00a7cPlanlanan UHC ba\u015flayamad\u0131: \u00a7f" + string);
        }
        if (plan.announce() && this.bridgeAvailable()) {
            this.notifySafely(() -> this.plugin.getIntegration().bridge().matchCancelled(this.slot(plan.startAt()), plan.hostName(), string, true));
        }
    }

    private void notifySafely(Runnable runnable) {
        try {
            runnable.run();
        }
        catch (RuntimeException runtimeException) {
            this.plugin.getLogger().log(Level.WARNING, "Takvim i\u015flemi kaydedildi; Discord bildirimi g\u00f6nderilemedi.", runtimeException);
        }
    }

    public static final class Entry {
        public final long startAt;
        public final String hostName;
        public final UUID hostId;
        public final List<String> scenarios;
        public final double timeScale;
        public boolean started;
        final Set<Long> announced = new HashSet<Long>();
        public final UUID id;
        public final String worldName;
        public final int teamLimit;
        public final boolean announce;
        public final com.nautilus.admin.AnnouncementSettings announcement;
        public final ScheduleBook.Status status;
        public final String note;

        Entry(long l, String string, UUID uUID, List<String> list, double d) {
            this(new ScheduleBook.Plan(UUID.randomUUID(), l, string, uUID, list, d, "", 1, true, 0L, ScheduleBook.Status.PLANNED, ""));
        }

        Entry(ScheduleBook.Plan plan) {
            this.startAt = plan.startAt();
            this.hostName = plan.hostName();
            this.hostId = plan.hostId();
            this.scenarios = plan.scenarios();
            this.timeScale = plan.timeScale();
            this.id = plan.id();
            this.worldName = plan.worldName();
            this.teamLimit = plan.teamLimit();
            this.announce = plan.announce();
            this.announcement=plan.announcement();
            this.status = plan.status();
            this.note = plan.note();
            this.started = this.status == ScheduleBook.Status.STARTED;
        }

        public String timeLabel(ZoneId zoneId) {
            return Instant.ofEpochMilli(this.startAt).atZone(zoneId).format(HHMM);
        }
    }
}

