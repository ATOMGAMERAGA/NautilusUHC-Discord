/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  org.bukkit.Bukkit
 *  org.bukkit.Material
 *  org.bukkit.World
 *  org.bukkit.command.Command
 *  org.bukkit.command.CommandExecutor
 *  org.bukkit.command.CommandSender
 *  org.bukkit.command.TabCompleter
 *  org.bukkit.entity.HumanEntity
 *  org.bukkit.entity.Player
 *  org.bukkit.event.EventHandler
 *  org.bukkit.event.EventPriority
 *  org.bukkit.event.Listener
 *  org.bukkit.event.inventory.InventoryClickEvent
 *  org.bukkit.event.inventory.InventoryCloseEvent
 *  org.bukkit.event.inventory.InventoryDragEvent
 *  org.bukkit.event.inventory.InventoryType
 *  org.bukkit.event.inventory.PrepareAnvilEvent
 *  org.bukkit.event.player.PlayerQuitEvent
 *  org.bukkit.inventory.AnvilInventory
 *  org.bukkit.inventory.Inventory
 *  org.bukkit.inventory.InventoryHolder
 *  org.bukkit.inventory.ItemStack
 *  org.bukkit.inventory.meta.ItemMeta
 *  org.bukkit.plugin.Plugin
 *  org.bukkit.scheduler.BukkitTask
 */
package com.nautilus.admin;

import com.nautilus.NautilusUHC;
import com.nautilus.admin.GuiPolicy;
import com.nautilus.admin.ScheduleBook;
import com.nautilus.admin.WorldSelection;
import com.nautilus.datapack.DatapackService;
import com.nautilus.reset.WorldRotationService;
import com.nautilus.scenarios.Scenario;
import com.nautilus.schedule.MatchScheduleService;
import com.nautilus.uhcmatch.UhcMatchManager;
import com.nautilus.util.HostPermissions;
import com.nautilus.util.TimeService;
import java.lang.reflect.Field;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.SequencedCollection;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.logging.Level;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.HumanEntity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.inventory.InventoryType;
import org.bukkit.event.inventory.PrepareAnvilEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.AnvilInventory;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;

public final class AdminController
implements Listener,
CommandExecutor,
TabCompleter {
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");
    private static final int[] GRID = new int[]{10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24, 25, 28, 29, 30, 31, 32, 33, 34};
    private final NautilusUHC plugin;
    private final HostPreferences preferences;
    private final Map<UUID, Draft> drafts = new HashMap<UUID, Draft>();
    private final Map<UUID, Long> discordCooldown = new HashMap<UUID, Long>();
    private final BukkitTask refreshTask;
    private boolean shuttingDown;

    public AdminController(NautilusUHC nautilusUHC) {
        this.plugin = nautilusUHC;
        this.preferences = new HostPreferences(nautilusUHC.getDataFolder().toPath().resolve("host-preferences.properties"));
        this.refreshTask = Bukkit.getScheduler().runTaskTimer((Plugin)nautilusUHC, () -> {
            for (Player player : Bukkit.getOnlinePlayers()) {
                Inventory inventory = player.getOpenInventory().getTopInventory();
                InventoryHolder inventoryHolder = inventory.getHolder();
                if (!(inventoryHolder instanceof Page)) continue;
                Page page = (Page)inventoryHolder;
                if (page.refresh == null || page.busy) continue;
                try {
                    if (this.allowed(player)) {
                        page.refresh.run();
                        continue;
                    }
                    player.closeInventory();
                }
                catch (Exception exception) {
                    nautilusUHC.getLogger().log(Level.WARNING, "UHC paneli yenilenemedi", exception);
                }
            }
        }, 40L, 40L);
    }

    public void shutdown() {
        this.shuttingDown = true;
        this.refreshTask.cancel();
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (!(player.getOpenInventory().getTopInventory().getHolder() instanceof Page)) continue;
            player.closeInventory();
        }
        for (Player p : Bukkit.getOnlinePlayers()) this.saveDraft(p);
        this.drafts.clear();
        this.discordCooldown.clear();
    }

    private boolean allowed(Player player) {
        return HostPermissions.isHost((CommandSender)player) && (this.plugin.getAuth() == null || this.plugin.getAuth().isAuthenticated(player));
    }

    public boolean onCommand(CommandSender commandSender, Command command, String string, String[] stringArray) {
        if (!(commandSender instanceof Player)) {
            commandSender.sendMessage("Bu panel oyundan /uhcadmin ile a\u00e7\u0131l\u0131r.");
            return true;
        }
        Player player = (Player)commandSender;
        if (!this.allowed(player)) {
            player.sendMessage("\u00a7cBu panel i\u00e7in host yetkisi ve giri\u015f yapm\u0131\u015f bir hesap gerekli.");
            return true;
        }
        this.home(player);
        return true;
    }

    public List<String> onTabComplete(CommandSender commandSender, Command command, String string, String[] stringArray) {
        return List.of();
    }

    private static ItemStack item(Material material, String string2, String ... stringArray) {
        ItemStack itemStack = new ItemStack(material);
        ItemMeta itemMeta = itemStack.getItemMeta();
        if (itemMeta != null) {
            itemMeta.setDisplayName("\u00a7b" + string2);
            itemMeta.setLore(Arrays.stream(stringArray).map(string -> "\u00a77" + string).toList());
            itemStack.setItemMeta(itemMeta);
        }
        return itemStack;
    }

    private void button(Page page, int n, Material material, String string, Consumer<Player> consumer, String ... stringArray) {
        page.inventory.setItem(n, AdminController.item(material, string, stringArray));
        if (consumer != null) {
            page.actions.put(n, (player, inventoryClickEvent) -> consumer.accept((Player)player));
        }
    }

    private void clickButton(Page page, int n, Material material, String string, BiConsumer<Player, InventoryClickEvent> biConsumer, String ... stringArray) {
        page.inventory.setItem(n, AdminController.item(material, string, stringArray));
        page.actions.put(n, biConsumer);
    }

    private void frame(Page page, Player player, Consumer<Player> consumer) {
        for (int i = 0; i < 54; ++i) {
            if (i >= 9 && i < 45 && i % 9 != 0 && i % 9 != 8) continue;
            page.inventory.setItem(i, AdminController.item(Material.GRAY_STAINED_GLASS_PANE, " ", new String[0]));
        }
        if (consumer != null) {
            this.button(page, 45, Material.ARROW, "Geri", consumer, "\u00d6nceki sayfaya d\u00f6n");
        }
        this.button(page, 49, Material.OAK_DOOR, "Kapat", HumanEntity::closeInventory, new String[0]);
        page.inventory.setItem(53, AdminController.item(Material.CLOCK, "T\u00fcrkiye saati", this.now().format(STAMP), "Europe/Istanbul"));
    }

    private ZonedDateTime now() {
        return Instant.ofEpochMilli(TimeService.currentMillis()).atZone(ScheduleBook.ZONE);
    }

    private void show(Player player, Page page) {
        if (player.isOnline() && this.allowed(player)) {
            player.openInventory(page.inventory);
        }
    }

    private void result(Player player, String string) {
        player.sendMessage((String)(string == null ? "\u00a7a\u0130\u015flem tamamland\u0131." : "\u00a7c" + string));
    }

    private boolean idle(Player player) {
        if (this.plugin.getUhcMatch().isStarted() || this.plugin.getMeetup() != null && this.plugin.getMeetup().isRunning()) {
            player.sendMessage("\u00a7cBu ayar ma\u00e7 veya geri say\u0131m s\u0131ras\u0131nda de\u011fi\u015ftirilemez.");
            return false;
        }
        return true;
    }

    private String status() {
        String string;
        UhcMatchManager uhcMatchManager = this.plugin.getUhcMatch();
        if (uhcMatchManager == null) {
            string = "Haz\u0131r de\u011fil";
        } else {
            switch (uhcMatchManager.phase().name()) {
                case "IDLE": {
                    string = "Ma\u00e7 bekleniyor";
                    break;
                }
                case "COUNTDOWN": {
                    string = "Ba\u015flang\u0131\u00e7 haz\u0131rlan\u0131yor";
                    break;
                }
                case "RUNNING": {
                    string = "Ma\u00e7 devam ediyor";
                    break;
                }
                default: {
                    string = uhcMatchManager.phase().name();
                }
            }
        }
        return string;
    }

    private void home(Player player2) {
        Page page = new Page(player2, "UHC Y\u00f6netimi");
        this.frame(page, player2, null);
        this.button(page, 10, Material.LIME_DYE, "Hemen maç başlat", this::editor, "Kişisel maç ayarlarını kullan", "Plan oluşturmadan güvenli başlangıç");
        this.button(page, 11, Material.CLOCK, "Ma\u00e7 planlama", player -> this.editor((Player)player), "Tarih, saat, d\u00fcnya ve senaryolar", "Discord duyurusuyla kal\u0131c\u0131 ma\u00e7 plan\u0131");
        this.button(page, 13, Material.GRASS_BLOCK, "D\u00fcnyalar", player -> this.worlds((Player)player, 0, false), "Haz\u0131r d\u00fcnya se\u00e7 ve havuzu y\u00f6net", "Y\u00fckl\u00fc d\u00fcnya say\u0131s\u0131 ve haz\u0131rl\u0131k durumu");
        this.button(page, 15, Material.BOOK, "Senaryolar", player -> this.scenarios((Player)player, false), "Mevcut ma\u00e7\u0131n senaryolar\u0131n\u0131 ayarla");
        this.button(page, 20, Material.LEVER, "Giri\u015fler", player -> this.gates((Player)player), "UHC bekleme alan\u0131na giri\u015fleri a\u00e7 / kapat");
        this.button(page, 22, Material.DIAMOND_SWORD, "Ma\u00e7 kontrolleri", player -> this.live((Player)player), "Ba\u015flat, geri say\u0131m\u0131 iptal et, durdur", "A\u015fama, deathmatch ve kat\u0131l\u0131mc\u0131lar");
        this.button(page, 24, Material.PLAYER_HEAD, "Tak\u0131mlar ve oyuncular", player -> new TeamAdminGui(this.plugin).home(player, 0), "Tak\u0131m boyutu, host kat\u0131l\u0131m\u0131 ve oyuncular");
        this.button(page, 29, Material.WRITABLE_BOOK, "Discord", player -> this.discord((Player)player), "Duyurular ve \u00f6zel host mesaj\u0131", "Mevcut Discord bot k\u00f6pr\u00fcs\u00fcn\u00fc kullan\u0131r");
        this.button(page, 31, Material.BOOKSHELF, "Ma\u00e7 takvimi", player -> this.schedule((Player)player, 0, false), "Planlanan ma\u00e7lar, planlayan ki\u015fi", "Ayr\u0131nt\u0131lar, duyuru ve iptal i\u015flemleri");
        this.button(page, 33, Material.COMPARATOR, "Ma\u00e7 \u00f6ncesi kontrol", player -> this.health((Player)player), "D\u00fcnya, datapack, oyuncular ve ba\u011flant\u0131lar");
        page.refresh = () -> {
            WorldRotationService worldRotationService = this.plugin.getWorldRotation();
            page.inventory.setItem(4, AdminController.item(Material.NETHER_STAR, "NautilusUHC \u00b7 " + this.status(), "Giri\u015fler: " + (this.plugin.getUhcHub().entriesOpen() ? "\u00a7aA\u00e7\u0131k" : "\u00a7cKapal\u0131"), "Haz\u0131r havuz: " + worldRotationService.readyPoolCount() + "  \u00b7  Y\u00fckl\u00fc: " + Bukkit.getWorlds().size(), "Bekleyen ma\u00e7: " + this.plugin.getSchedule().upcoming().size(), "T\u00fcrkiye saati: " + this.now().format(STAMP)));
        };
        page.refresh.run();
        this.show(player2, page);
    }

    private void rememberLive(Player player) {
        Draft d=this.draft(player);d.team=TeamPolicy.limit(this.plugin.getTeams().getLimit());d.scenarios.clear();
        d.scenarios.addAll(this.plugin.getScenarios().enabledScenarios().stream().map(Scenario::key).toList());this.saveDraft(player);
    }

    private void saveDraft(Player player) {
        Draft d=this.drafts.get(player.getUniqueId());if(d==null)return;
        Map<String,String> saved=new HashMap<>(Map.of("team",String.valueOf(d.team),"world",d.world,"announce",String.valueOf(d.announce),"scenarios",String.join(",",d.scenarios),"date",d.date.toString(),"hour",String.valueOf(d.hour),"minute",String.valueOf(d.minute)));saved.putAll(d.announcement().preferences());this.preferences.put(player.getUniqueId(),saved);
    }

    private Draft draft(Player player) {
        return this.drafts.computeIfAbsent(player.getUniqueId(), uUID -> {
            Draft draft = new Draft();
            ZonedDateTime zonedDateTime = this.now().plusMinutes(15L);
            draft.date = LocalDate.parse(this.preferences.get(uUID,"date",zonedDateTime.toLocalDate().toString()));
            draft.hour = Math.floorMod(Integer.parseInt(this.preferences.get(uUID,"hour",String.valueOf(zonedDateTime.getHour()))),24);
            draft.minute = Math.floorMod(Integer.parseInt(this.preferences.get(uUID,"minute",String.valueOf(zonedDateTime.getMinute()))),60);
            draft.team = TeamPolicy.limit(Integer.parseInt(this.preferences.get(uUID,"team",String.valueOf(this.plugin.getTeams().getLimit()))));
            draft.announce = Boolean.parseBoolean(this.preferences.get(uUID,"announce",String.valueOf(this.plugin.getSchedule().bridgeAvailable())));
            draft.world = this.preferences.get(uUID,"world","");
            AnnouncementSettings settings=AnnouncementSettings.read(this.preferences,uUID);draft.prize=settings.prize();draft.mentionEveryone=settings.mentionEveryone();draft.mentionHere=settings.mentionHere();
            String keys=this.preferences.get(uUID,"scenarios",String.join(",",this.plugin.getScenarios().enabledScenarios().stream().map(Scenario::key).toList()));
            for(String key:keys.split(",")) if(Scenario.byKey(key)!=null) draft.scenarios.add(key);
            return draft;
        });
    }

    private void editor(Player player3) {
        Draft draft = this.draft(player3);
        if(draft.at() <= System.currentTimeMillis()) {var next=this.now().plusMinutes(15);draft.date=next.toLocalDate();draft.hour=next.getHour();draft.minute=next.getMinute();}
        this.saveDraft(player3);
        Page page = new Page(player3, "Yeni Ma\u00e7");
        this.frame(page, player3, this::home);
        this.button(page, 4, Material.PAPER, "Ma\u00e7 \u00f6zeti", null, draft.date.format(DATE) + " \u00b7 " + String.format("%02d:%02d", draft.hour, draft.minute) + " (T\u00fcrkiye)", "Planlayan: " + player3.getName(), "Tak\u0131m: " + draft.team + "  \u00b7  Senaryo: " + draft.scenarios.size(), "D\u00fcnya: " + (draft.world.isEmpty() ? "Ba\u015flang\u0131\u00e7ta aktif haz\u0131r d\u00fcnya" : draft.world));
        this.clickButton(page, 10, Material.CLOCK, "Tarih \u00b7 " + draft.date.format(DATE), (player, inventoryClickEvent) -> {
            LocalDate localDate = draft.date.plusDays(inventoryClickEvent.isRightClick() ? -1L : 1L);
            if (!localDate.isBefore(this.now().toLocalDate()) && !localDate.isAfter(this.now().toLocalDate().plusDays(365L))) {
                draft.date = localDate;
            }
            this.editor((Player)player);
        }, "Sol t\u0131k: sonraki g\u00fcn", "Sa\u011f t\u0131k: \u00f6nceki g\u00fcn");
        this.clickButton(page, 12, Material.CLOCK, "Saat \u00b7 " + String.format("%02d", draft.hour), (player, inventoryClickEvent) -> {
            draft.hour = Math.floorMod(draft.hour + (inventoryClickEvent.isRightClick() ? -1 : 1), 24);
            this.editor((Player)player);
        }, "Sol t\u0131k: +1 saat", "Sa\u011f t\u0131k: -1 saat");
        this.clickButton(page, 14, Material.CLOCK, "Dakika \u00b7 " + String.format("%02d", draft.minute), (player, inventoryClickEvent) -> {
            int n = inventoryClickEvent.isShiftClick() ? 5 : 1;
            draft.minute = Math.floorMod(draft.minute + (inventoryClickEvent.isRightClick() ? -n : n), 60);
            this.editor((Player)player);
        }, "Sol / sa\u011f t\u0131k: +1 / -1 dakika", "Shift ile: 5 dakika");
        this.clickButton(page, 16, Material.PLAYER_HEAD, "Takım boyutu · " + TeamPolicy.label(draft.team), (player, inventoryClickEvent) -> {
            draft.team = Math.max(1, Math.min(4, draft.team + (inventoryClickEvent.isRightClick() ? -1 : 1)));
            this.editor((Player)player);
        }, "Sol / sa\u011f t\u0131k: art\u0131r / azalt", "FFA = takımsız solo, To2 = duo, To3 = trio, To4 = squad");
        this.button(page, 20, Material.GRASS_BLOCK, "Ma\u00e7 d\u00fcnyas\u0131", player -> this.worlds((Player)player, 0, true), draft.world.isEmpty() ? "Ba\u015flang\u0131\u00e7ta aktif haz\u0131r d\u00fcnya" : draft.world, "Bu se\u00e7im di\u011fer ma\u00e7 ayarlar\u0131n\u0131 de\u011fi\u015ftirmez");
        this.button(page, 22, Material.BOOK, "Ma\u00e7 senaryolar\u0131", player -> this.scenarios((Player)player, true), "Se\u00e7ili: " + draft.scenarios.size(), "Yaln\u0131zca bu plan i\u00e7in kaydedilir");
        this.button(page, 24, draft.announce ? Material.LIME_DYE : Material.GRAY_DYE, "Discord duyurusu \u00b7 " + (draft.announce ? "A\u00e7\u0131k" : "Kapal\u0131"), player -> {
            draft.announce = !draft.announce;
            this.editor((Player)player);
        }, "Plan kaydedildi\u011finde bota duyuru g\u00f6nder", "K\u00f6pr\u00fc ba\u011flant\u0131s\u0131: " + (this.plugin.getSchedule().bridgeAvailable() ? "Ayarl\u0131" : "Haz\u0131r de\u011fil"));
        this.clickButton(page,29,Material.DIAMOND,"Ödül · "+(draft.prize.isBlank()?"Yok":draft.prize),(player,event)->{
            if(event.isRightClick()){draft.prize="";this.editor(player);return;}
            this.inputPrize(player,draft.prize.isBlank()?"Ödül":draft.prize,text->{draft.prize=new AnnouncementSettings(text,false,false).prize();this.editor(player);},()->this.editor(player));
        },"Sol tık: serbest ödül metni yaz","Sağ tık veya boş metin: ödülü kaldır");
        this.button(page,28,draft.mentionEveryone?Material.LIME_DYE:Material.GRAY_DYE,"@everyone · "+(draft.mentionEveryone?"Açık":"Kapalı"),player->{draft.mentionEveryone=!draft.mentionEveryone;this.editor(player);},"Yalnız bu maçın Discord duyuruları");
        this.button(page,30,draft.mentionHere?Material.LIME_DYE:Material.GRAY_DYE,"@here · "+(draft.mentionHere?"Açık":"Kapalı"),player->{draft.mentionHere=!draft.mentionHere;this.editor(player);},"Yalnız bu maçın Discord duyuruları");
        this.button(page, 33, Material.DIAMOND_SWORD, "Hemen başlat", host -> {
            int team=draft.team; String world=draft.world; List<String> selected=List.copyOf(draft.scenarios);AnnouncementSettings announcement=draft.announcement();
            this.confirm(host, "Maçı hemen başlat", List.of("Takım boyutu: "+team, "Dünya: "+(world.isEmpty()?"Aktif hazır dünya":world), "Seçilen senaryolar: "+String.join(", ",selected),"Ödül: "+(announcement.prize().isBlank()?"Yok":announcement.prize()),"@everyone: "+announcement.mentionEveryone()+" · @here: "+announcement.mentionHere()), player -> {
                String error=this.manualStartCheck();
                if(error==null && this.plugin.getTeams().teamNumbers().stream().anyMatch(n -> team>1 && this.plugin.getTeams().memberCount(n)>team))
                    error="Mevcut takımlar seçilen boyuta uygun değil. /teamadmin ile önce takımları düzenle veya temizle.";
                if(error==null) error=WorldSelection.prepareForStart(this.plugin, world);
                if(error!=null) {this.result(player,error);this.editor(player);return;}
                this.saveDraft(player);
                if(team==1)this.plugin.getTeams().clearAssignments();
                this.plugin.getTeams().setLimit(team);
                this.plugin.getScenarios().disableAll();
                for(String key:selected) {Scenario scenario=Scenario.byKey(key);if(scenario!=null)this.plugin.getScenarios().enableScenario(scenario);}
                this.plugin.getUhcMatch().setScenarioOverride(selected);
                AnnouncementRuntime.launch(this.plugin,new MatchAnnouncementContext(player.getUniqueId(),player.getName(),team,selected,announcement),()->this.plugin.getUhcMatch().forceStart(player));
                this.live(player);
            }, this::editor);
        }, "Tarih ve planlama beklemeden başlat", "Yukarıdaki kişisel ayarlar uygulanır");
        this.button(page, 31, Material.EMERALD, "Ma\u00e7\u0131 planla", player2 -> {
            long l = draft.at();
            String string = this.plugin.getSchedule().validate(l);
            if (string != null) {
                this.result((Player)player2, string);
                return;
            }
            List<String> list = List.copyOf(draft.scenarios);
            String string2 = draft.world;
            int n = draft.team;
            boolean bl = draft.announce;
            AnnouncementSettings announcement=draft.announcement();
            this.confirm((Player)player2, "Ma\u00e7\u0131 planla", (List<String>)List.of(draft.date.format(DATE) + " " + String.format("%02d:%02d", draft.hour, draft.minute), "Planlayan: " + player2.getName(), "Tak\u0131m boyutu: " + n, "D\u00fcnya: " + (string2.isEmpty() ? "Aktif haz\u0131r d\u00fcnya" : string2), "Discord: " + (bl ? "Duyuru g\u00f6nder" : "Kapal\u0131"), "Ödül: "+(announcement.prize().isBlank()?"Yok":announcement.prize()), "@everyone: "+announcement.mentionEveryone()+" · @here: "+announcement.mentionHere()), player -> {
                String scheduleError = this.plugin.getSchedule().scheduleDetailed(player.getName(), player.getUniqueId(), l, list, 1.0, string2, n, bl,announcement);
                this.result((Player)player, scheduleError);
                if (scheduleError == null) {
                    this.saveDraft(player);
                    this.drafts.remove(player.getUniqueId());
                    this.schedule((Player)player, 0, false);
                } else {
                    this.editor((Player)player);
                }
            }, this::editor);
        }, "Ayr\u0131nt\u0131lar\u0131 kontrol et ve onayla", "Saat geldi\u011finde haz\u0131rl\u0131k kontrolleri uygulan\u0131r");
        this.button(page, 40, Material.BARRIER, "Tasla\u011f\u0131 temizle", player -> {
            this.preferences.put(player.getUniqueId(), Map.of("team",String.valueOf(Math.max(1,this.plugin.getTeams().getLimit())),"world","","announce",String.valueOf(this.plugin.getSchedule().bridgeAvailable()),"scenarios",String.join(",",this.plugin.getScenarios().enabledScenarios().stream().map(Scenario::key).toList())));
            this.drafts.remove(player.getUniqueId());
            this.editor((Player)player);
        }, "Kaydedilmi\u015f ma\u00e7lar etkilenmez");
        this.show(player3, page);
    }

    private void scenarios(Player player2, boolean bl) {
        Draft draft = bl ? this.draft(player2) : null;
        Page page = new Page(player2, bl ? "Plan Senaryolar\u0131" : "Senaryolar");
        this.frame(page, player2, bl ? this::editor : this::home);
        this.button(page, 4, Material.BOOK, "Senaryo se\u00e7imi", null, bl ? "Bu se\u00e7im yaln\u0131zca planlanan ma\u00e7 i\u00e7indir." : "Mevcut ma\u00e7 ayarlar\u0131; ma\u00e7 s\u0131ras\u0131nda kilitlenir.", "Ye\u015fil: a\u00e7\u0131k \u00b7 Gri: kapal\u0131");
        int n = 0;
        for (Scenario scenario : Scenario.values()) {
            boolean bl2 = bl ? draft.scenarios.contains(scenario.key()) : this.plugin.getScenarios().isEnabled(scenario);
            this.button(page, GRID[n++], bl2 ? Material.LIME_DYE : scenario.icon(), scenario.displayName() + " \u00b7 " + (bl2 ? "A\u00e7\u0131k" : "Kapal\u0131"), player -> {
                if (bl) {
                    if (!draft.scenarios.remove(scenario.key())) {
                        draft.scenarios.add(scenario.key());
                    }
                } else if (this.idle((Player)player)) {
                    this.plugin.getScenarios().toggleScenario(scenario);
                    this.rememberLive(player);
                }
                this.scenarios((Player)player, bl);
            }, scenario.key(), "De\u011fi\u015ftirmek i\u00e7in t\u0131kla");
        }
        this.button(page, 39, Material.LIME_DYE, "Hepsini a\u00e7", player -> {
            if (bl) {
                for (Scenario scenario : Scenario.values()) {
                    draft.scenarios.add(scenario.key());
                }
            } else if (this.idle((Player)player)) {
                for (Scenario scenario : Scenario.values()) {
                    this.plugin.getScenarios().enableScenario(scenario);
                }
            }
            this.scenarios((Player)player, bl);
        }, new String[0]);
        this.button(page, 41, Material.GRAY_DYE, "Hepsini kapat", player -> {
            if (bl) {
                draft.scenarios.clear();
            } else if (this.idle((Player)player)) {
                this.plugin.getScenarios().disableAll();
            }
            this.scenarios((Player)player, bl);
        }, new String[0]);
        if (bl) this.saveDraft(player2);
        this.show(player2, page);
    }

    private void schedule(Player player2, int n, boolean bl) {
        List<MatchScheduleService.Entry> sequencedCollection = bl ? this.plugin.getSchedule().allEntries().reversed() : this.plugin.getSchedule().upcoming();
        int n2 = Math.max(0, (sequencedCollection.size() - 1) / GRID.length);
        int n3 = Math.max(0, Math.min(n2, n));
        Page page = new Page(player2, bl ? "Ma\u00e7 Ge\u00e7mi\u015fi" : "Ma\u00e7 Takvimi");
        this.frame(page, player2, this::home);
        this.button(page, 4, Material.BOOKSHELF, bl ? "Planlama ge\u00e7mi\u015fi" : "Planlanan ma\u00e7lar", null, "Kay\u0131t: " + sequencedCollection.size() + " \u00b7 Sayfa: " + (n3 + 1) + " / " + (n2 + 1), "T\u00fcm saatler T\u00fcrkiye saatidir.", this.plugin.getSchedule().storageError() == null ? "Ayr\u0131nt\u0131 ve i\u015flemler i\u00e7in ma\u00e7a t\u0131kla." : this.plugin.getSchedule().storageError());
        for (int i = 0; i < GRID.length && n3 * GRID.length + i < sequencedCollection.size(); ++i) {
            MatchScheduleService.Entry entry = (MatchScheduleService.Entry)sequencedCollection.get(n3 * GRID.length + i);
            this.button(page, GRID[i], entry.status == ScheduleBook.Status.PLANNED ? Material.CLOCK : Material.PAPER, this.stamp(entry.startAt), player -> this.details((Player)player, entry.id), "Planlayan: " + entry.hostName, "Durum: " + this.state(entry.status), "Tak\u0131m: " + entry.teamLimit + " \u00b7 Senaryo: " + entry.scenarios.size(), "D\u00fcnya: " + (entry.worldName.isEmpty() ? "Aktif haz\u0131r d\u00fcnya" : entry.worldName));
        }
        if (n3 > 0) {
            this.button(page, 46, Material.ARROW, "\u00d6nceki sayfa", player -> this.schedule((Player)player, n3 - 1, bl), new String[0]);
        }
        this.button(page, 48, Material.BOOK, bl ? "Bekleyen ma\u00e7lar" : "Ge\u00e7mi\u015fi g\u00f6ster", player -> this.schedule((Player)player, 0, !bl), new String[0]);
        this.button(page, 50, Material.EMERALD, "Yeni ma\u00e7", this::editor, new String[0]);
        if (n3 < n2) {
            this.button(page, 52, Material.ARROW, "Sonraki sayfa", player -> this.schedule((Player)player, n3 + 1, bl), new String[0]);
        }
        this.show(player2, page);
    }

    private String stamp(long l) {
        return Instant.ofEpochMilli(l).atZone(ScheduleBook.ZONE).format(STAMP);
    }

    private String state(ScheduleBook.Status status) {
        return switch (status) {
            default -> throw new MatchException(null, null);
            case ScheduleBook.Status.PLANNED -> "Planland\u0131";
            case ScheduleBook.Status.STARTING -> "Ba\u015flat\u0131l\u0131yor";
            case ScheduleBook.Status.STARTED -> "Ba\u015flang\u0131\u00e7 kabul edildi";
            case ScheduleBook.Status.CANCELLED -> "\u0130ptal edildi";
            case ScheduleBook.Status.FAILED -> "Ba\u015flayamad\u0131";
            case ScheduleBook.Status.MISSED -> "Saati ka\u00e7\u0131r\u0131ld\u0131";
        };
    }

    private void details(Player player3, UUID uUID) {
        MatchScheduleService.Entry entry = this.plugin.getSchedule().find(uUID);
        if (entry == null) {
            this.result(player3, "Ma\u00e7 kayd\u0131 bulunamad\u0131.");
            this.schedule(player3, 0, false);
            return;
        }
        Page page = new Page(player3, "Ma\u00e7 Ayr\u0131nt\u0131lar\u0131");
        this.frame(page, player3, player -> this.schedule((Player)player, 0, false));
        this.button(page, 4, Material.CLOCK, this.stamp(entry.startAt), null, "Durum: " + this.state(entry.status), "Planlayan: " + entry.hostName, "Kimlik: " + String.valueOf(entry.hostId), "Ma\u00e7: " + String.valueOf(entry.id));
        this.button(page,29,Material.DIAMOND,"Maç ödülü",null,entry.announcement.prize().isBlank()?"Ödülsüz":entry.announcement.prize(),"@everyone: "+(entry.announcement.mentionEveryone()?"Açık":"Kapalı"),"@here: "+(entry.announcement.mentionHere()?"Açık":"Kapalı"));
        this.button(page, 20, Material.GRASS_BLOCK, "D\u00fcnya ve tak\u0131m", null, "D\u00fcnya: " + (entry.worldName.isEmpty() ? "Aktif haz\u0131r d\u00fcnya" : entry.worldName), "Tak\u0131m boyutu: " + entry.teamLimit);
        this.button(page, 22, Material.BOOK, "Senaryolar", null, entry.scenarios.isEmpty() ? "Senaryo yok" : String.join((CharSequence)", ", entry.scenarios));
        this.button(page, 24, Material.PAPER, "\u0130\u015flem sonucu", null, entry.note.isEmpty() ? "Ma\u00e7 ba\u015flang\u0131c\u0131n\u0131 bekliyor." : entry.note, "Discord duyurusu: " + (entry.announce ? "A\u00e7\u0131k" : "Kapal\u0131"));
        if (entry.status == ScheduleBook.Status.PLANNED) {
            this.button(page, 30, Material.WRITABLE_BOOK, "Discord'a tekrar duyur", player2 -> this.confirm((Player)player2, "Ma\u00e7\u0131 duyur", List.of(this.stamp(entry.startAt), "Duyuruyu bota yeniden g\u00f6nderir."), player -> {
                this.sendDiscord((Player)player, () -> this.result((Player)player, this.plugin.getSchedule().reannounce(uUID)));
                this.details((Player)player, uUID);
            }, player -> this.details((Player)player, uUID)), new String[0]);
            this.button(page, 32, Material.BARRIER, "Plan\u0131 iptal et", player2 -> this.confirm((Player)player2, "Plan\u0131 iptal et", List.of(this.stamp(entry.startAt), "Planlayan: " + entry.hostName, "Otomatik ba\u015flang\u0131\u00e7 kald\u0131r\u0131l\u0131r."), player -> {
                MatchScheduleService.Entry cancelledEntry = this.plugin.getSchedule().cancelById(uUID, player.getUniqueId(), player.getName() + " taraf\u0131ndan iptal edildi.");
                this.result((Player)player, cancelledEntry == null ? "Ma\u00e7\u0131n durumu de\u011fi\u015fmi\u015f; art\u0131k iptal edilemez." : null);
                this.details((Player)player, uUID);
            }, player -> this.details((Player)player, uUID)), new String[0]);
        }
        this.show(player3, page);
    }

    private void worlds(Player player3, int n, boolean bl) {
        WorldRotationService worldRotationService = this.plugin.getWorldRotation();
        ArrayList<String> arrayList = new ArrayList<String>();
        World world = worldRotationService.currentOrNull();
        if (world != null) {
            arrayList.add(world.getName());
        }
        for (String string : worldRotationService.readyPoolWorldNames()) {
            if (arrayList.contains(string)) continue;
            arrayList.add(string);
        }
        int n2 = Math.max(0, (arrayList.size() - 1) / GRID.length);
        int n3 = Math.max(0, Math.min(n, n2));
        Page page = new Page(player3, bl ? "Plan D\u00fcnyas\u0131" : "D\u00fcnya Y\u00f6netimi");
        this.frame(page, player3, bl ? this::editor : this::home);
        page.refresh = () -> this.button(page, 4, Material.MAP, "D\u00fcnya durumu", null, "Haz\u0131r havuz: " + worldRotationService.readyPoolCount() + " \u00b7 Y\u00fckl\u00fc: " + Bukkit.getWorlds().size(), "Aktif: " + (worldRotationService.currentOrNull() == null ? "Yok" : worldRotationService.currentOrNull().getName()), "Haz\u0131rl\u0131k: " + worldRotationService.preparationStatusLine(), "Havuz: %" + worldRotationService.poolProgressPercent() + " \u00b7 " + worldRotationService.poolEtaText());
        page.refresh.run();
        for (int i = 0; i < GRID.length && n3 * GRID.length + i < arrayList.size(); ++i) {
            String string = (String)arrayList.get(n3 * GRID.length + i);
            boolean bl2 = world != null && world.getName().equals(string);
            boolean bl3 = bl2 ? worldRotationService.isPrepared() : worldRotationService.readyPoolWorldNames().contains(string);
            this.button(page, GRID[i], bl2 ? Material.EMERALD : Material.GRASS_BLOCK, string, player2 -> {
                if (bl) {
                    if (!bl3) {
                        this.result((Player)player2, "Bu d\u00fcnya hen\u00fcz haz\u0131r de\u011fil.");
                        return;
                    }
                    this.draft((Player)player2).world = string;
                    this.editor((Player)player2);
                } else if (bl2) {
                    this.result((Player)player2, "Bu d\u00fcnya zaten aktif.");
                } else {
                    this.confirm((Player)player2, "Haz\u0131r d\u00fcnyay\u0131 se\u00e7", List.of(string, "Ma\u00e7 d\u00fcnyas\u0131 bu haz\u0131r d\u00fcnya olacak.", "Mevcut d\u00fcnya silinmez."), player -> {
                        String string2 = this.plugin.getSchedule().upcoming().stream().anyMatch(entry -> string.equals(entry.worldName)) ? "Bu d\u00fcnya planlanm\u0131\u015f bir ma\u00e7a ayr\u0131lm\u0131\u015f." : null;
                        this.result((Player)player, string2 == null ? WorldSelection.select(this.plugin, string) : string2);
                        this.worlds((Player)player, n3, false);
                    }, player -> this.worlds((Player)player, n3, false));
                }
            }, bl2 ? "Aktif UHC d\u00fcnyas\u0131" : "Haz\u0131r d\u00fcnya havuzu", bl3 ? "\u00a7aHaz\u0131r" : "\u00a7eHaz\u0131rlan\u0131yor", bl ? "Bu ma\u00e7 i\u00e7in se\u00e7" : "Aktif d\u00fcnya yapmak i\u00e7in t\u0131kla");
        }
        if (bl) {
            this.button(page, 40, Material.COMPASS, "Ba\u015flang\u0131\u00e7ta aktif haz\u0131r d\u00fcnya", player -> {
                this.draft((Player)player).world = "";
                this.editor((Player)player);
            }, "D\u00fcnya sabitlemesini kald\u0131r\u0131r");
        } else {
            this.button(page, 37, Material.GRASS_BLOCK, "Yeni d\u00fcnya y\u00fckle", player2 -> this.confirm((Player)player2, "Yeni d\u00fcnya y\u00fckle", List.of("Mevcut y\u00fckleme ak\u0131\u015f\u0131n\u0131 kullan\u0131r.", "Aktif d\u00fcnya varsa \u00f6nce g\u00fcvenle s\u0131f\u0131rla."), player -> {
                if (this.idle((Player)player)) {
                    this.plugin.getUhcMatch().requestWorldLoad((CommandSender)player);
                }
                this.worlds((Player)player, 0, false);
            }, player -> this.worlds((Player)player, 0, false)), new String[0]);
            this.button(page, 38, worldRotationService.poolRunning() ? Material.RED_DYE : Material.LIME_DYE, "Havuz \u00fcretimi \u00b7 " + (worldRotationService.poolRunning() ? "\u00c7al\u0131\u015f\u0131yor" : "Durdu"), player -> {
                if (!this.idle((Player)player)) {
                    return;
                }
                if (worldRotationService.poolRunning()) {
                    worldRotationService.stopPoolGeneration((CommandSender)player);
                } else {
                    worldRotationService.startPoolGeneration((CommandSender)player);
                }
                this.worlds((Player)player, n3, false);
            }, "T\u0131kla: " + (worldRotationService.poolRunning() ? "\u00fcretimi durdur" : "\u00fcretimi ba\u015flat"));
            this.clickButton(page, 39, Material.CHEST, "Hedef d\u00fcnya \u00b7 " + worldRotationService.poolTarget(), (player, inventoryClickEvent) -> {
                if (this.idle((Player)player)) {
                    worldRotationService.setPoolTarget(Math.max(1, Math.min(worldRotationService.maxPoolWorlds(), worldRotationService.poolTarget() + (inventoryClickEvent.isRightClick() ? -1 : 1))), (CommandSender)player);
                }
                this.worlds((Player)player, n3, false);
            }, "Sol / sa\u011f t\u0131k: +1 / -1 d\u00fcnya");
            this.button(page, 40, Material.REPEATER, "\u00dcretim h\u0131z\u0131 \u00b7 " + worldRotationService.poolSpeed().name(), player -> {
                if (this.idle((Player)player)) {
                    worldRotationService.cyclePoolSpeed((CommandSender)player);
                }
                this.worlds((Player)player, n3, false);
            }, "S\u0131radaki h\u0131z i\u00e7in t\u0131kla");
            this.button(page, 41, Material.MAP, "Y\u00fckl\u00fc d\u00fcnyalar", player -> this.loadedWorlds((Player)player, 0), "Sunucuda y\u00fckl\u00fc: " + Bukkit.getWorlds().size());
            this.button(page, 43, Material.TNT, "Aktif d\u00fcnyay\u0131 s\u0131f\u0131rla", player2 -> {
                World activeWorld = worldRotationService.currentOrNull();
                if (activeWorld == null) {
                    this.result((Player)player2, "Aktif d\u00fcnya yok.");
                    return;
                }
                String string = activeWorld.getName();
                this.confirm((Player)player2, "D\u00fcnyay\u0131 s\u0131f\u0131rla", List.of(string, "Bu d\u00fcnyan\u0131n ma\u00e7 verileri silinir.", "D\u00fcnya s\u0131f\u0131rlama ak\u0131\u015f\u0131n\u0131 ba\u015flat\u0131r."), player -> {
                    World confirmedWorld = worldRotationService.currentOrNull();
                    if (confirmedWorld == null || !string.equals(confirmedWorld.getName())) {
                        this.result((Player)player, "Aktif d\u00fcnya de\u011fi\u015fmi\u015f; tekrar kontrol et.");
                    } else if (this.plugin.getSchedule().upcoming().stream().anyMatch(entry -> string.equals(entry.worldName))) {
                        this.result((Player)player, "Bu d\u00fcnya planlanm\u0131\u015f ma\u00e7a ayr\u0131lm\u0131\u015f; \u00f6nce plan\u0131 iptal et.");
                    } else if (this.idle((Player)player)) {
                        this.plugin.getUhcMatch().requestWorldReset((CommandSender)player);
                    }
                    this.worlds((Player)player, 0, false);
                }, player -> this.worlds((Player)player, 0, false));
            }, new String[0]);
        }
        if (n3 > 0) {
            this.button(page, 46, Material.ARROW, "\u00d6nceki", player -> this.worlds((Player)player, n3 - 1, bl), new String[0]);
        }
        if (n3 < n2) {
            this.button(page, 52, Material.ARROW, "Sonraki", player -> this.worlds((Player)player, n3 + 1, bl), new String[0]);
        }
        this.show(player3, page);
    }

    private void loadedWorlds(Player player2, int n) {
        List list = Bukkit.getWorlds();
        int n2 = Math.max(0, (list.size() - 1) / GRID.length);
        int n3 = Math.max(0, Math.min(n, n2));
        Page page = new Page(player2, "Y\u00fckl\u00fc D\u00fcnyalar");
        this.frame(page, player2, player -> this.worlds((Player)player, 0, false));
        this.button(page, 4, Material.MAP, "Toplam " + list.size() + " d\u00fcnya", null, "Bu sayfa yaln\u0131zca bilgi g\u00f6sterir.");
        for (int i = 0; i < GRID.length && n3 * GRID.length + i < list.size(); ++i) {
            World world = (World)list.get(n3 * GRID.length + i);
            this.button(page, GRID[i], Material.GRASS_BLOCK, world.getName(), null, "Oyuncu: " + world.getPlayers().size());
        }
        if (n3 > 0) {
            this.button(page, 46, Material.ARROW, "\u00d6nceki", player -> this.loadedWorlds((Player)player, n3 - 1), new String[0]);
        }
        if (n3 < n2) {
            this.button(page, 52, Material.ARROW, "Sonraki", player -> this.loadedWorlds((Player)player, n3 + 1), new String[0]);
        }
        this.show(player2, page);
    }

    private void gates(Player player2) {
        Page page = new Page(player2, "UHC Giri\u015fleri");
        this.frame(page, player2, this::home);
        boolean bl = this.plugin.getUhcHub().entriesOpen();
        this.button(page, 4, bl ? Material.LIME_DYE : Material.RED_DYE, "Giri\u015fler \u00b7 " + (bl ? "A\u00e7\u0131k" : "Kapal\u0131"), null, "Oyuncular /uhcgiris ile bekleme alan\u0131na girer.", "Discord hesab\u0131 ba\u011flant\u0131s\u0131 kontrol edilir.");
        this.button(page, 20, Material.LIME_DYE, "Giri\u015fleri a\u00e7", player -> {
            if (!this.plugin.getUhcMatch().isStarted()) {
                this.plugin.getUhcHub().setEntriesOpen(true);
                this.result((Player)player, null);
            } else {
                this.result((Player)player, "Aktif ma\u00e7ta bekleme alan\u0131 giri\u015fleri a\u00e7\u0131lamaz.");
            }
            this.gates((Player)player);
        }, new String[0]);
        this.button(page, 24, Material.RED_DYE, "Giri\u015fleri kapat", player -> {
            this.plugin.getUhcHub().setEntriesOpen(false);
            this.result((Player)player, null);
            this.gates((Player)player);
        }, new String[0]);
        this.clickButton(page, 31, Material.CLOCK, "Plan \u00f6ncesi otomatik a\u00e7ma", (player, inventoryClickEvent) -> {
            long l = this.plugin.getConfig().getInt("uhcAdmin.schedule.openEntriesMinutesBefore", -1);
            long l2 = inventoryClickEvent.isRightClick() ? -1L : (l < 0L ? 15L : (l == 15L ? 30L : (l == 30L ? 60L : -1L)));
            this.plugin.getConfig().set("uhcAdmin.schedule.openEntriesMinutesBefore", (Object)l2);
            this.plugin.saveConfig();
            this.gates((Player)player);
        }, "\u015eu an: " + this.autoOpenLabel(), "Sol t\u0131k: kapal\u0131 \u2192 15 \u2192 30 \u2192 60 dakika", "Sa\u011f t\u0131k: otomatik a\u00e7may\u0131 kapat");
        this.show(player2, page);
    }

    private String autoOpenLabel() {
        int n = this.plugin.getConfig().getInt("uhcAdmin.schedule.openEntriesMinutesBefore", -1);
        return n < 0 ? "Kapal\u0131" : n + " dakika \u00f6nce";
    }

    private void live(Player player3) {
        UhcMatchManager uhcMatchManager = this.plugin.getUhcMatch();
        Page page = new Page(player3, "Ma\u00e7 Kontrolleri");
        this.frame(page, player3, this::home);
        page.refresh = () -> this.button(page, 4, Material.DIAMOND_SWORD, this.status(), null, "Host: " + uhcMatchManager.matchHost(), "Kat\u0131l\u0131mc\u0131: " + uhcMatchManager.participantCount() + " \u00b7 Hayatta: " + uhcMatchManager.aliveCount(), "S\u00fcre: " + uhcMatchManager.elapsedSecondsPublic() + " saniye", "S\u0131radaki a\u015fama: " + uhcMatchManager.nextPhaseName());
        page.refresh.run();
        this.button(page, 10, Material.CLOCK, "Geri say\u0131mla ba\u015flat", player2 -> this.confirm((Player)player2, "Geri say\u0131m\u0131 ba\u015flat", List.of("Mevcut senaryolar ve tak\u0131m ayar\u0131 kullan\u0131l\u0131r.", "Oyuncular UHC bekleme alan\u0131nda olmal\u0131."), player -> {
            String string = this.manualStartCheck();
            if (string == null) {
                string = WorldSelection.prepareForStart(this.plugin, "");
            }
            if (string == null) {
                this.launchLive(player,()->uhcMatchManager.start((CommandSender)player));
            } else {
                this.result((Player)player, string);
            }
            this.live((Player)player);
        }, this::live), new String[0]);
        this.button(page, 12, Material.LIME_DYE, "Hemen ba\u015flat", player2 -> this.confirm((Player)player2, "UHC'yi hemen ba\u015flat", List.of("Uzun geri say\u0131m\u0131 atlar.", "G\u00fcvenli haz\u0131rl\u0131k ve da\u011f\u0131t\u0131m uygulan\u0131r."), player -> {
            String string = this.manualStartCheck();
            if (string == null) {
                string = WorldSelection.prepareForStart(this.plugin, "");
            }
            if (string == null) {
                this.launchLive(player,()->uhcMatchManager.forceStart((CommandSender)player));
            } else {
                this.result((Player)player, string);
            }
            this.live((Player)player);
        }, this::live), new String[0]);
        this.button(page, 14, Material.YELLOW_DYE, "Geri say\u0131m\u0131 iptal et", player2 -> this.confirm((Player)player2, "Geri say\u0131m iptali", List.of("\u00c7al\u0131\u015fan ba\u015flang\u0131\u00e7 sayac\u0131 iptal edilir."), player -> {
            uhcMatchManager.cancelCountdown((CommandSender)player);
            if(!uhcMatchManager.isStarted())AnnouncementRuntime.clear();
            this.live((Player)player);
        }, this::live), new String[0]);
        this.button(page, 16, Material.RED_DYE, "Ma\u00e7\u0131 durdur", player2 -> this.confirm((Player)player2, "UHC'yi durdur", List.of("Mevcut ma\u00e7 bitirilir.", "Normal ma\u00e7 sonu temizli\u011fi uygulan\u0131r."), player -> {
            uhcMatchManager.stop((CommandSender)player);
            this.live((Player)player);
        }, this::live), new String[0]);
        this.button(page, 20, Material.REPEATER, "Sonraki a\u015famaya ge\u00e7", player2 -> this.confirm((Player)player2, "A\u015famay\u0131 ilerlet", List.of("S\u0131radaki: " + uhcMatchManager.nextPhaseName(), "Zamanlay\u0131c\u0131y\u0131 beklemeden uygular."), player -> {
            if (uhcMatchManager.isRunning()) {
                player.sendMessage("\u00a7b" + uhcMatchManager.advancePhase());
            } else {
                this.result((Player)player, "\u00c7al\u0131\u015fan ma\u00e7 yok.");
            }
            this.live((Player)player);
        }, this::live), new String[0]);
        this.button(page, 22, Material.TNT, "Deathmatch ba\u015flat", player2 -> this.confirm((Player)player2, "Deathmatch ba\u015flat", List.of("Deathmatch a\u015famas\u0131na erken ge\u00e7ilir."), player -> {
            if (uhcMatchManager.isRunning() && !uhcMatchManager.isDeathmatchActive()) {
                uhcMatchManager.startDeathmatchNow();
            } else {
                this.result((Player)player, "Deathmatch ba\u015flat\u0131labilecek ma\u00e7 yok.");
            }
            this.live((Player)player);
        }, this::live), new String[0]);
        this.button(page, 24, Material.PLAYER_HEAD, "Kat\u0131l\u0131mc\u0131lar", player -> this.players((Player)player, 0), new String[0]);
        this.button(page, 31, Material.COMPARATOR, "Ma\u00e7 \u00f6ncesi kontrol", this::health, new String[0]);
        this.show(player3, page);
    }

    private String manualStartCheck() {
        WorldRotationService worldRotationService = this.plugin.getWorldRotation();
        World world = worldRotationService.currentOrNull();
        String string = world != null ? world.getName() : worldRotationService.readyPoolWorldNames().stream().findFirst().orElse("");
        return this.plugin.getSchedule().upcoming().stream().anyMatch(entry -> !entry.worldName.isEmpty() && string.equals(entry.worldName)) ? "Bu d\u00fcnya planlanm\u0131\u015f ma\u00e7a ayr\u0131lm\u0131\u015f; \u00f6nce o plan\u0131 iptal et." : null;
    }

    private void teams(Player player3) {
        Page page = new Page(player3, "Tak\u0131mlar ve Oyuncular");
        this.frame(page, player3, this::home);
        int n = this.plugin.getTeams().getLimit();
        this.button(page, 4, Material.PLAYER_HEAD, "Tak\u0131m durumu", null, "Tak\u0131m boyutu: " + n, "Tak\u0131m say\u0131s\u0131: " + this.plugin.getTeams().teamNumbers().size(), "\u00c7evrimi\u00e7i: " + Bukkit.getOnlinePlayers().size());
        this.button(page,20,Material.PLAYER_HEAD,"Takım boyutu · "+TeamPolicy.label(n),player->new TeamAdminGui(this.plugin).home(player,0),"FFA (takımsız), To2, To3 veya To4 seç");
        this.button(page, 22, Material.COMPASS, "Host kat\u0131l\u0131m\u0131 \u00b7 " + (this.plugin.getUhcMatch().isHostParticipating(player3) ? "Oynuyorsun" : "\u0130zliyorsun"), player -> {
            if (this.idle((Player)player)) {
                this.plugin.getUhcMatch().setHostParticipation((CommandSender)player, !this.plugin.getUhcMatch().isHostParticipating((Player)player));
            }
            this.teams((Player)player);
        }, "Kendi ma\u00e7a kat\u0131l\u0131m\u0131n\u0131 de\u011fi\u015ftir");
        this.button(page, 24, Material.BOOK, "Oyuncu listesi", player -> this.players((Player)player, 0), new String[0]);
        this.button(page, 30, Material.REPEATER, "Tak\u0131mlar\u0131 rastgele da\u011f\u0131t", player2 -> this.confirm((Player)player2, "Tak\u0131mlar\u0131 kar\u0131\u015ft\u0131r", List.of("Mevcut tak\u0131m komutunun ak\u0131\u015f\u0131n\u0131 uygular."), player -> {
            if (this.idle((Player)player)) {
                player.performCommand("team randomize");
            }
            this.teams((Player)player);
        }, this::teams), new String[0]);
        this.button(page, 32, Material.BARRIER, "Tak\u0131mlar\u0131 temizle", player2 -> this.confirm((Player)player2, "Tak\u0131mlar\u0131 temizle", List.of("T\u00fcm mevcut tak\u0131m atamalar\u0131 kald\u0131r\u0131l\u0131r."), player -> {
            if (this.idle((Player)player)) {
                this.plugin.getTeams().clearAssignments();
            }
            this.teams((Player)player);
        }, this::teams), new String[0]);
        this.show(player3, page);
    }

    private void players(Player player3, int n) {
        ArrayList<Player> arrayList = new ArrayList<Player>(Bukkit.getOnlinePlayers());
        arrayList.sort(Comparator.comparing(CommandSender::getName));
        int n2 = Math.max(0, (arrayList.size() - 1) / GRID.length);
        int n3 = Math.max(0, Math.min(n, n2));
        Page page = new Page(player3, "Oyuncular");
        this.frame(page, player3, this::teams);
        this.button(page, 4, Material.PLAYER_HEAD, "\u00c7evrimi\u00e7i oyuncular \u00b7 " + arrayList.size(), null, "Oyuncuya t\u0131kla: ayr\u0131nt\u0131lar ve i\u015flemler");
        for (int i = 0; i < GRID.length && n3 * GRID.length + i < arrayList.size(); ++i) {
            Player player4 = (Player)arrayList.get(n3 * GRID.length + i);
            this.button(page, GRID[i], Material.PLAYER_HEAD, player4.getName(), player2 -> this.player((Player)player2, player4.getUniqueId()), "Tak\u0131m: " + this.plugin.getTeams().getTeam(player4), "Hayatta: " + this.plugin.getUhcMatch().isAlive(player4.getUniqueId()), "UHC bekleme alan\u0131nda: " + this.plugin.getUhcHub().isInHub(player4));
        }
        if (n3 > 0) {
            this.button(page, 46, Material.ARROW, "\u00d6nceki", player -> this.players((Player)player, n3 - 1), new String[0]);
        }
        if (n3 < n2) {
            this.button(page, 52, Material.ARROW, "Sonraki", player -> this.players((Player)player, n3 + 1), new String[0]);
        }
        this.show(player3, page);
    }

    private void player(Player player3, UUID uUID) {
        Player player4 = Bukkit.getPlayer((UUID)uUID);
        if (player4 == null) {
            this.result(player3, "Oyuncu \u00e7evrimd\u0131\u015f\u0131.");
            this.players(player3, 0);
            return;
        }
        String string = player4.getName();
        Page page = new Page(player3, "Oyuncu \u00b7 " + string);
        this.frame(page, player3, player -> this.players((Player)player, 0));
        this.button(page, 4, Material.PLAYER_HEAD, string, null, "Tak\u0131m: " + this.plugin.getTeams().getTeam(player4), "Discord ba\u011fl\u0131: " + this.plugin.getUhcHub().isLinked(player4), "Ma\u00e7 kat\u0131l\u0131mc\u0131s\u0131: " + this.plugin.getUhcMatch().isParticipant(uUID), "Hayatta: " + this.plugin.getUhcMatch().isAlive(uUID));
        this.button(page, 20, Material.COMPASS, "Oyuncuya git", player -> {
            Player player2 = Bukkit.getPlayer((UUID)uUID);
            if (player2 == null) {
                this.result((Player)player, "Oyuncu \u00e7evrimd\u0131\u015f\u0131.");
            } else {
                player.closeInventory();
                if (!player.teleport(player2.getLocation())) {
                    this.result((Player)player, "I\u015f\u0131nlanma ba\u015fka bir eklenti taraf\u0131ndan engellendi.");
                }
            }
        }, new String[0]);
        this.button(page, 22, Material.GOLDEN_APPLE, "Dirilt", player2 -> this.confirm((Player)player2, "Oyuncuyu dirilt", List.of(string, "Mevcut revive ak\u0131\u015f\u0131 uygulan\u0131r."), player -> {
            if (Bukkit.getPlayer((UUID)uUID) != null) {
                player.performCommand("revive " + string);
            } else {
                this.result((Player)player, "Oyuncu \u00e7evrimd\u0131\u015f\u0131.");
            }
            this.players((Player)player, 0);
        }, player -> this.player((Player)player, uUID)), new String[0]);
        this.button(page, 24, Material.CHEST, "\u00d6l\u00fcm envanterini a\u00e7", player -> {
            player.closeInventory();
            player.performCommand("reviveinv " + string);
        }, new String[0]);
        this.button(page, 31, Material.IRON_DOOR, "Bekleme alan\u0131na g\u00f6nder", player -> {
            Player player2 = Bukkit.getPlayer((UUID)uUID);
            if (player2 == null) {
                this.result((Player)player, "Oyuncu \u00e7evrimd\u0131\u015f\u0131.");
            } else if (this.idle((Player)player)) {
                this.plugin.getUhcHub().sendToHub(player2);
            }
            this.player((Player)player, uUID);
        }, new String[0]);
        this.show(player3, page);
    }

    private void launchLive(Player player,Runnable start){
        Draft draft=this.draft(player);this.saveDraft(player);
        int team=TeamPolicy.limit(this.plugin.getTeams().getLimit());
        if(team>1 && this.plugin.getTeams().teamNumbers().stream().anyMatch(number->this.plugin.getTeams().memberCount(number)>team)){this.result(player,"Mevcut takım seçilen boyuttan büyük; önce takımları düzenle.");return;}
        if(team==1)this.plugin.getTeams().clearAssignments();this.plugin.getTeams().setLimit(team);
        AnnouncementRuntime.launch(this.plugin,new MatchAnnouncementContext(player.getUniqueId(),player.getName(),team,this.plugin.getScenarios().enabledScenarios().stream().map(Scenario::key).toList(),draft.announcement()),start);
    }

    private void discord(Player player2) {
        Page page = new Page(player2, "Discord Duyurular\u0131");
        this.frame(page, player2, this::home);
        boolean bl = this.plugin.getSchedule().bridgeAvailable();
        Draft draft=this.draft(player2);
        this.button(page,10,draft.mentionEveryone?Material.LIME_DYE:Material.GRAY_DYE,"@everyone · "+(draft.mentionEveryone?"Açık":"Kapalı"),player->{draft.mentionEveryone=!draft.mentionEveryone;this.saveDraft(player);this.discord(player);},"Yeni maç taslağına kaydedilir","Mevcut planlar kendi ayarlarını korur");
        this.button(page,12,draft.mentionHere?Material.LIME_DYE:Material.GRAY_DYE,"@here · "+(draft.mentionHere?"Açık":"Kapalı"),player->{draft.mentionHere=!draft.mentionHere;this.saveDraft(player);this.discord(player);},"Yeni maç taslağına kaydedilir","Mevcut planlar kendi ayarlarını korur");
        this.button(page, 4, bl ? Material.LIME_DYE : Material.RED_DYE, "Discord k\u00f6pr\u00fcs\u00fc \u00b7 " + (bl ? "Ayarl\u0131" : "Haz\u0131r de\u011fil"), null, "Bot adresi ve ortak anahtar config \u00fczerinden okunur.", "G\u00f6nderim, bot k\u00f6pr\u00fcs\u00fcne teslim iste\u011fidir.", "Mesaj\u0131n Discord'a ula\u015ft\u0131\u011f\u0131n\u0131 bot logundan kontrol et.");
        this.button(page, 20, Material.WRITABLE_BOOK, "\u00d6zel host mesaj\u0131", player -> this.input((Player)player, "Discord Mesaj\u0131", "Duyuru metni", string -> this.confirm((Player)player, "Discord mesaj\u0131 g\u00f6nder", List.of(string), receiver -> {
            this.sendDiscord(receiver, () -> {
                this.plugin.getIntegration().bridge().hostMessage(receiver.getName(), (String)string, true);
                receiver.sendMessage("\u00a7aMesaj Discord k\u00f6pr\u00fcs\u00fcne g\u00f6nderildi.");
            });
            this.discord(receiver);
        }, this::discord), () -> this.discord((Player)player)), "\u00d6rs ekran\u0131nda mesaj\u0131 yaz", "Sonu\u00e7 \u00f6\u011fesine t\u0131klay\u0131p \u00f6nizlemeyi onayla");
        this.button(page, 22, Material.LEVER, "Giri\u015f duyurusu", player -> this.discordMessage((Player)player, this.plugin.getUhcHub().entriesOpen() ? "UHC giri\u015fleri a\u00e7\u0131ld\u0131! /uhcgiris ile bekleme alan\u0131na kat\u0131labilirsin." : "UHC giri\u015fleri kapat\u0131ld\u0131. Yeni duyurular\u0131 bekle."), new String[0]);
        this.button(page, 24, Material.CLOCK, "S\u0131radaki ma\u00e7\u0131 duyur", player -> {
            MatchScheduleService.Entry entry = this.plugin.getSchedule().next();
            if (entry == null) {
                this.result((Player)player, "Planlanm\u0131\u015f ma\u00e7 yok.");
            } else {
                this.details((Player)player, entry.id);
            }
        }, new String[0]);
        this.button(page, 31, Material.PAPER, "Ma\u00e7 kurallar\u0131n\u0131 duyur", player -> this.discordMessage((Player)player, "NautilusUHC | Tak\u0131m boyutu: " + this.plugin.getTeams().getLimit() + " | Senaryolar: " + String.join((CharSequence)", ", this.plugin.getScenarios().enabledScenarios().stream().map(Scenario::displayName).toList()) + " | Sunucu: nautilusuhc.com"), new String[0]);
        this.show(player2, page);
    }

    private void discordMessage(Player player2, String string) {
        this.confirm(player2, "Discord duyurusu", List.of(string), player -> {
            this.sendDiscord((Player)player, () -> {
                this.plugin.getIntegration().bridge().hostMessage(player.getName(), string, true);
                player.sendMessage("\u00a7aDuyuru Discord k\u00f6pr\u00fcs\u00fcne g\u00f6nderildi.");
            });
            this.discord((Player)player);
        }, this::discord);
    }

    private void sendDiscord(Player player, Runnable runnable) {
        if (!this.plugin.getSchedule().bridgeAvailable()) {
            this.result(player, "Discord k\u00f6pr\u00fcs\u00fc haz\u0131r de\u011fil.");
            return;
        }
        long l = System.currentTimeMillis();
        Long l2 = this.discordCooldown.get(player.getUniqueId());
        if (l2 != null && l - l2 < 30000L) {
            this.result(player, "Yeni duyuru i\u00e7in 30 saniye bekle.");
            return;
        }
        runnable.run();
        this.discordCooldown.put(player.getUniqueId(), l);
    }

    private void input(Player player, String string, String string2, Consumer<String> consumer, Runnable runnable) {
        Page page = new Page(player, string, consumer, runnable);
        page.inventory.setItem(0, AdminController.item(Material.PAPER, string2, new String[0]));
        this.show(player, page);
    }

    private void inputPrize(Player player,String initial,Consumer<String> accept,Runnable escape){
        Page page=new Page(player,"Maç Ödülü",accept,escape);page.allowBlank=true;
        page.inventory.setItem(0,AdminController.item(Material.PAPER,initial,"Boş bırak: ödülsüz maç"));this.show(player,page);
    }

    private void health(Player player2) {
        Page page = new Page(player2, "Ma\u00e7 \u00d6ncesi Kontrol");
        this.frame(page, player2, this::home);
        WorldRotationService worldRotationService = this.plugin.getWorldRotation();
        String string = WorldSelection.preflight(this.plugin, "");
        this.button(page, 4, string == null ? Material.LIME_DYE : Material.RED_DYE, string == null ? "Ba\u015flang\u0131\u00e7 kontrolleri haz\u0131r" : "Kontrol gerekli", null, string == null ? "Ma\u00e7 motorunun ba\u015flang\u0131\u00e7 kontrolleri ayr\u0131ca uygulan\u0131r." : string);
        this.button(page, 11, Material.GRASS_BLOCK, "D\u00fcnya", null, "Aktif: " + (worldRotationService.currentOrNull() == null ? "Yok" : worldRotationService.currentOrNull().getName()), "Haz\u0131r: " + worldRotationService.isPrepared(), worldRotationService.preparationStatusLine(), "Haz\u0131r havuz: " + worldRotationService.readyPoolCount());
        this.button(page, 13, Material.BOOK, "Datapack", null, "D\u00fcnya \u00fcretimi etkin: " + DatapackService.isWorldgenActive(), "Zorunlu: " + this.plugin.getConfig().getBoolean("worldReset.requireDatapack", true));
        this.button(page, 15, Material.PLAYER_HEAD, "Oyuncular ve giri\u015fler", null, "\u00c7evrimi\u00e7i: " + Bukkit.getOnlinePlayers().size(), "UHC bekleme alan\u0131: " + Bukkit.getOnlinePlayers().stream().filter(player -> this.plugin.getUhcHub().isInHub((Player)player)).count(), "Giri\u015fler: " + (this.plugin.getUhcHub().entriesOpen() ? "A\u00e7\u0131k" : "Kapal\u0131"));
        String[] stringArray = new String[4];
        stringArray[0] = "T\u00fcrkiye: " + this.now().format(STAMP);
        stringArray[1] = "Saat senkronu: " + (TimeService.isSynced() ? (TimeService.isStale() ? "Eski" : "G\u00fcncel") : "Sistem saati");
        stringArray[2] = "Bekleyen ma\u00e7: " + this.plugin.getSchedule().upcoming().size();
        stringArray[3] = this.plugin.getSchedule().storageError() == null ? "Takvim kayd\u0131 okunuyor." : this.plugin.getSchedule().storageError();
        this.button(page, 20, Material.CLOCK, "Saat ve takvim", null, stringArray);
        this.button(page, 22, Material.WRITABLE_BOOK, "Discord", null, "K\u00f6pr\u00fc ayarl\u0131: " + this.plugin.getSchedule().bridgeAvailable(), "Ger\u00e7ek Discord teslimat\u0131 bot logundan do\u011frulan\u0131r.");
        this.button(page, 24, Material.SHIELD, "Sunucu", null, "LibertyBans: " + Bukkit.getPluginManager().isPluginEnabled("LibertyBans"), "TPS: " + String.format(Locale.ROOT, "%.1f", Bukkit.getTPS()[0]), "UHC modu: " + this.plugin.getConfig().getBoolean("uhcMode", true), "Ma\u00e7 a\u015famas\u0131: " + this.status());
        this.button(page, 40, Material.SUNFLOWER, "Yeniden kontrol et", this::health, new String[0]);
        this.show(player2, page);
    }

    private void confirm(Player player2, String string, List<String> list, Consumer<Player> consumer, Consumer<Player> consumer2) {
        String string2 = this.operationSnapshot();
        Page page = new Page(player2, "Onay \u00b7 " + string);
        this.frame(page, player2, consumer2);
        this.button(page, 4, Material.PAPER, string, null, (String[])this.wrap(list).toArray(String[]::new));
        this.button(page, 20, Material.LIME_DYE, "Onayla", player -> {
            if (!GuiPolicy.sameOperation(string2, this.operationSnapshot())) {
                this.result((Player)player, "Ma\u00e7 veya ayarlar de\u011fi\u015fmi\u015f; i\u015flemi yeniden a\u00e7\u0131p kontrol et.");
                consumer2.accept((Player)player);
                return;
            }
            consumer.accept((Player)player);
        }, "\u0130\u015flemi uygula");
        this.button(page, 24, Material.RED_DYE, "Vazge\u00e7", consumer2, "\u0130\u015flem uygulanmaz");
        this.show(player2, page);
    }

    private String operationSnapshot() {
        try {
            UhcMatchManager uhcMatchManager = this.plugin.getUhcMatch();
            Field field = uhcMatchManager.getClass().getDeclaredField("matchEpoch");
            field.setAccessible(true);
            World world = this.plugin.getWorldRotation().currentOrNull();
            return field.getInt(uhcMatchManager) + ":" + uhcMatchManager.phase().name() + ":" + (world == null ? "" : world.getName()) + ":" + this.plugin.getTeams().getLimit() + ":" + String.valueOf(this.plugin.getScenarios().enabledScenarios().stream().map(Scenario::key).sorted().toList()) + ":" + uhcMatchManager.nextPhaseName();
        }
        catch (ReflectiveOperationException reflectiveOperationException) {
            this.plugin.getLogger().log(Level.SEVERE, "Ma\u00e7 i\u015flem kimli\u011fi okunamad\u0131", reflectiveOperationException);
            return null;
        }
    }

    private List<String> wrap(List<String> list) {
        ArrayList<String> arrayList = new ArrayList<String>();
        for (String string : list) {
            if (string == null) continue;
            while (string.length() > 44) {
                int n = string.lastIndexOf(32, 44);
                if (n < 10) {
                    n = 44;
                }
                arrayList.add(string.substring(0, n));
                string = string.substring(n).stripLeading();
            }
            arrayList.add(string);
        }
        return arrayList;
    }

    @EventHandler(priority=EventPriority.HIGHEST)
    public void click(InventoryClickEvent event) {
        Inventory inventory=event.getView().getTopInventory();
        if(!(inventory.getHolder() instanceof Page page))return;
        event.setCancelled(true);
        if(!(event.getWhoClicked() instanceof Player player) || page.busy || !GuiPolicy.mayAct(page.owner,player.getUniqueId(),this.allowed(player),event.getRawSlot(),inventory.getSize()))return;
        if(page.input!=null) {
            if(event.getRawSlot()!=2)return;
            String raw=event.getView() instanceof org.bukkit.inventory.view.AnvilView anvil?anvil.getRenameText():null;
            if(raw==null||(!page.allowBlank&&raw.isBlank())||raw.length()>240){player.sendMessage("§cMesaj 1–240 karakter olmalı.");return;}
            String text=raw.strip().replaceAll("[\\p{Cntrl}§]","");
            this.defer(player,page,()->page.input.accept(text));return;
        }
        BiConsumer<Player,InventoryClickEvent> action=page.actions.get(event.getRawSlot());
        if(action!=null)this.defer(player,page,()->action.accept(player,event));
    }

    private void defer(Player player, Page page, Runnable runnable) {
        page.busy = true;
        Bukkit.getScheduler().runTask((Plugin)this.plugin, () -> {
            try {
                if (player.isOnline() && this.allowed(player) && player.getOpenInventory().getTopInventory() == page.inventory) {
                    runnable.run();
                }
            }
            catch (Exception exception) {
                this.plugin.getLogger().log(Level.SEVERE, "UHC y\u00f6netim i\u015flemi ba\u015far\u0131s\u0131z", exception);
                player.sendMessage("\u00a7c\u0130\u015flem uygulanamad\u0131; ayr\u0131nt\u0131 konsola yaz\u0131ld\u0131.");
                if (player.isOnline()) {
                    this.home(player);
                }
            }
            finally {
                page.busy = false;
            }
        });
    }

    @EventHandler(priority=EventPriority.HIGHEST)
    public void drag(InventoryDragEvent inventoryDragEvent) {
        if (inventoryDragEvent.getView().getTopInventory().getHolder() instanceof Page) {
            inventoryDragEvent.setCancelled(true);
        }
    }

    @EventHandler
    public void prepare(PrepareAnvilEvent prepareAnvilEvent) {
        Object object = prepareAnvilEvent.getInventory().getHolder();
        if (object instanceof Page) {
            Page page = (Page)object;
            if (page.input != null && (object = prepareAnvilEvent.getView().getRenameText()) != null && (page.allowBlank || !((String)object).isBlank())) {
                prepareAnvilEvent.getView().setRepairCost(0);
                prepareAnvilEvent.setResult(AdminController.item(Material.PAPER, ((String)object).isBlank()?"Ödülsüz":(String)object, "Mesaj\u0131 \u00f6nizlemek i\u00e7in t\u0131kla"));
            }
        }
    }

    @EventHandler
    public void close(InventoryCloseEvent inventoryCloseEvent) {
        InventoryHolder inventoryHolder = inventoryCloseEvent.getInventory().getHolder();
        if (inventoryHolder instanceof Page) {
            Page page = (Page)inventoryHolder;
            if (page.input != null) {
                HumanEntity humanEntity;
                page.inventory.clear();
                if (!this.shuttingDown && this.plugin.isEnabled() && !page.busy && page.escape != null && (humanEntity = inventoryCloseEvent.getPlayer()) instanceof Player) {
                    Player closingPlayer = (Player)humanEntity;
                    Bukkit.getScheduler().runTask((Plugin)this.plugin, () -> this.lambda$close$0(closingPlayer, page));
                }
            }
        }
    }

    @EventHandler
    public void quit(PlayerQuitEvent playerQuitEvent) {
        this.saveDraft(playerQuitEvent.getPlayer());
        this.drafts.remove(playerQuitEvent.getPlayer().getUniqueId());
        this.discordCooldown.remove(playerQuitEvent.getPlayer().getUniqueId());
    }

    private /* synthetic */ void lambda$close$0(Player player, Page page) {
        if (!this.shuttingDown && this.plugin.isEnabled() && player.isOnline() && this.allowed(player) && player.getOpenInventory().getTopInventory().getType() == InventoryType.CRAFTING) {
            page.escape.run();
        }
    }

    private static /* synthetic */ void lambda$click$1(BiConsumer biConsumer, Player player, InventoryClickEvent inventoryClickEvent) {
        biConsumer.accept(player, inventoryClickEvent);
    }

    private static /* synthetic */ void lambda$click$0(Page page, String string) {
        page.input.accept(string);
    }

    private static final class Page
    implements InventoryHolder {
        final UUID owner;
        final Map<Integer, BiConsumer<Player, InventoryClickEvent>> actions = new HashMap<Integer, BiConsumer<Player, InventoryClickEvent>>();
        final Inventory inventory;
        boolean busy;
        Runnable refresh;
        Consumer<String> input;
        boolean allowBlank;
        Runnable escape;

        Page(Player player, String string) {
            this.owner = player.getUniqueId();
            this.inventory = Bukkit.createInventory((InventoryHolder)this, (int)54, (String)("\u00a78Nautilus \u00a77\u203a \u00a70" + string));
        }

        Page(Player player, String string, Consumer<String> consumer, Runnable runnable) {
            this.owner = player.getUniqueId();
            this.input = consumer;
            this.escape = runnable;
            this.inventory = Bukkit.createInventory((InventoryHolder)this, (InventoryType)InventoryType.ANVIL, (String)string);
        }

        public Inventory getInventory() {
            return this.inventory;
        }
    }

    private static final class Draft {
        LocalDate date;
        int hour;
        int minute;
        int team;
        String world = "";
        boolean announce;
        String prize="";boolean mentionEveryone;boolean mentionHere;
        AnnouncementSettings announcement(){return new AnnouncementSettings(prize,mentionEveryone,mentionHere);}
        Set<String> scenarios = new LinkedHashSet<String>();

        private Draft() {
        }

        long at() {
            return ScheduleBook.at(this.date, this.hour, this.minute);
        }
    }
}

