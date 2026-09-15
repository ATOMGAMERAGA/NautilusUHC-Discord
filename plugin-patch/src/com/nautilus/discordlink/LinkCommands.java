package com.nautilus.discordlink;

import com.nautilus.bridge.BridgeClient;
import com.nautilus.bridge.BridgeInstance;
import com.nautilus.util.HostPermissions;
import com.nautilus.util.Messages;
import com.nautilus.util.Text;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.logging.Level;

/**
 * /link ve /unlink komutları.
 *
 * /unlink kullanımları:
 *   /unlink &lt;oyuncu&gt; [sebep]        birebir oyuncu adı (çevrimdışı dahil)
 *   /unlink mc &lt;oyuncu&gt; [sebep]     geriye uyumlu ad kullanımı
 *   /unlink dc &lt;discordId&gt; [sebep]  Discord kullanıcı ID'si
 *   /unlink uuid &lt;uuid&gt; [sebep]     kesin Minecraft UUID'si
 *
 * İsim hiçbir zaman kısmi ya da "ilk bulunan" eşleşmeyle çözülmez; ad birden
 * fazla hesapla eşleşirse hiçbir şey silinmez ve UUID/Discord ID istenir.
 */
public final class LinkCommands implements CommandExecutor, TabCompleter {
    static final String UNLINK_PERMISSION = "nautilus.mod.unlink";

    private final Plugin plugin;
    private final LinkService links;
    private final BridgeClient bridge;

    public LinkCommands(Plugin plugin, LinkService links, BridgeClient bridge) {
        this.plugin = plugin;
        this.links = links;
        this.bridge = bridge;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (command.getName().equalsIgnoreCase("unlink")) {
            return this.unlink(sender, args);
        }
        return this.link(sender);
    }

    private boolean link(CommandSender sender) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Text.plain(Text.smallCaps(Messages.get("common.players-only", "sadece oyuncular")),
                    NamedTextColor.RED));
            return true;
        }
        Optional<LinkService.LinkRecord> existing;
        try {
            existing = this.links.recordByUuid(player.getUniqueId());
        } catch (IllegalStateException error) {
            this.warn("/link bağlantı durumu okunamadı (" + player.getUniqueId() + ")", error);
            player.sendMessage(Text.plain(Messages.get("link.status-unavailable",
                    "Bağlantı durumun şu an okunamadı; kod üretilmedi. Biraz sonra tekrar dene."), NamedTextColor.RED));
            return true;
        }
        if (existing.isPresent()) {
            player.sendMessage(Text.plain(Text.smallCaps(Messages.get("link.already-linked", "hesabın zaten bağlı"))
                    + " · " + existing.get().discordTag(), NamedTextColor.YELLOW));
            return true;
        }
        LinkService.PendingCode code;
        try {
            code = this.links.issueCode(player.getUniqueId(), player.getName(), BridgeInstance.id(this.plugin));
        } catch (IllegalStateException error) {
            this.warn("/link kodu üretilemedi (" + player.getUniqueId() + ")", error);
            player.sendMessage(Text.plain(Messages.get("link.code-unavailable",
                    "Bağlantı kodu şu an üretilemedi; biraz sonra tekrar dene."), NamedTextColor.RED));
            return true;
        }
        long minutes = Math.max(1L, (code.expiresAt() - System.currentTimeMillis()) / 60000L);
        player.sendMessage(Component.empty());
        player.sendMessage(Text.plain(Text.smallCaps(Messages.get("link.header",
                "Discord sunucumuza katılmak için /discord komutunu kullanabilirsin.")), NamedTextColor.AQUA));
        player.sendMessage(Text.plain(Messages.get("link.code-info",
                "Discord'daki hesap bağlama düğmesine bu kodu gir:"), NamedTextColor.GRAY));
        player.sendMessage(((TextComponent) Component.text("   " + code.code(), NamedTextColor.GREEN, TextDecoration.BOLD)
                .clickEvent(ClickEvent.copyToClipboard(code.code())))
                .hoverEvent(Component.text(Messages.get("link.click-to-copy", "kopyalamak için tıkla"))));
        player.sendMessage(Text.plain(Messages.get("link.code-expiry", "Kod %dakika% dakika geçerlidir.")
                .replace("%dakika%", String.valueOf(minutes)), NamedTextColor.DARK_GRAY));
        player.sendMessage(Component.empty());
        return true;
    }

    private boolean unlink(CommandSender sender, String[] args) {
        // plugin.yml bu izni zaten ister; handler katmanında da açıkça denetlenir.
        if (!sender.hasPermission(UNLINK_PERMISSION)) {
            sender.sendMessage(Text.plain(Text.smallCaps(Messages.get("mod.no-permission", "bu komutu kullanma yetkin yok")),
                    NamedTextColor.RED));
            return true;
        }
        // 1.2.1'deki ek host koşulu korunur (yetki genişletilmez).
        if (HostPermissions.denyIfNotHost(sender)) {
            return true;
        }
        if (args.length == 0) {
            this.usage(sender);
            return true;
        }

        String mode = args[0].toLowerCase(Locale.ROOT);
        LinkService.Selector selector;
        String value;
        int reasonFrom;
        if ((mode.equals("mc") || mode.equals("dc") || mode.equals("uuid")) && args.length >= 2) {
            selector = switch (mode) {
                case "dc" -> LinkService.Selector.BY_DISCORD;
                case "uuid" -> LinkService.Selector.BY_UUID;
                default -> LinkService.Selector.BY_NAME;
            };
            value = args[1];
            reasonFrom = 2;
        } else {
            selector = LinkService.Selector.BY_NAME;
            value = args[0];
            reasonFrom = 1;
        }
        String reason = args.length > reasonFrom
                ? String.join(" ", Arrays.copyOfRange(args, reasonFrom, args.length))
                : null;
        if (selector == LinkService.Selector.BY_NAME && (value.isBlank() || value.length() > 32)) {
            this.usage(sender);
            return true;
        }

        List<UUID> bukkitCandidates = selector == LinkService.Selector.BY_NAME
                ? bukkitCandidates(value)
                : List.of();
        LinkService.Actor actor = sender instanceof Player staff
                ? new LinkService.Actor("minecraft_staff", staff.getUniqueId().toString(), staff.getName())
                : new LinkService.Actor("console", null, sender.getName());

        LinkService.UnlinkResult result;
        try {
            result = this.links.unlink(new LinkService.UnlinkRequest(selector, value, null, bukkitCandidates,
                    actor, reason, "minecraft_command", UUID.randomUUID().toString()));
        } catch (IllegalArgumentException invalid) {
            sender.sendMessage(Text.plain(invalid.getMessage(), NamedTextColor.RED));
            return true;
        } catch (IllegalStateException unavailable) {
            this.warn("/unlink işlenemedi (" + selector + ")", unavailable);
            sender.sendMessage(Text.plain(Messages.get("link.store-unavailable",
                    "Bağlantı deposuna erişilemedi; hiçbir değişiklik yapılmadı."), NamedTextColor.RED));
            return true;
        }

        if (result instanceof LinkService.UnlinkResult.Removed removed) {
            LinkService.LinkRecord link = removed.link();
            sender.sendMessage(Text.plain(Text.smallCaps(Messages.get("link.removed", "bağlantı kaldırıldı"))
                    + " · " + link.displayName() + " (" + link.uuid() + ") ↔ Discord " + link.discordId(),
                    NamedTextColor.GREEN));
            if (this.bridge != null && this.plugin.getConfig().getBoolean("bridge.events.link-removed", true)) {
                this.bridge.linkRemoved(link.displayName(), link.discordId(), "game");
            }
        } else if (result instanceof LinkService.UnlinkResult.NotLinked notLinked) {
            if (notLinked.resolved()) {
                sender.sendMessage(Text.plain(Messages.get("link.not-linked",
                        "Bu hesabın aktif bir Discord bağlantısı yok; değişiklik yapılmadı."), NamedTextColor.YELLOW));
            } else {
                sender.sendMessage(Text.plain(Text.smallCaps(Messages.get("link.not-found",
                        "böyle bir bağlantı bulunamadı")), NamedTextColor.RED));
            }
        } else if (result instanceof LinkService.UnlinkResult.Ambiguous ambiguous) {
            sender.sendMessage(Text.plain(Messages.get("link.ambiguous",
                    "Bu ad birden fazla hesapla eşleşiyor; hiçbir bağlantı kaldırılmadı. UUID ya da Discord ID ile tekrar dene:"),
                    NamedTextColor.YELLOW));
            for (LinkService.NameCandidate candidate : ambiguous.candidates()) {
                String linkState = candidate.link() == null
                        ? "bağlantısız"
                        : "bağlı: Discord " + candidate.link().discordId();
                sender.sendMessage(Text.plain(" · " + candidate.uuid() + " — " + String.join(", ", candidate.knownNames())
                        + " — " + linkState, NamedTextColor.GRAY));
            }
            sender.sendMessage(Text.plain("/unlink uuid <uuid> [sebep]", NamedTextColor.GRAY));
        } else {
            sender.sendMessage(Text.plain(Messages.get("link.changed",
                    "Bağlantı işlem sırasında değişti; güncel durumu kontrol edip tekrar dene."), NamedTextColor.YELLOW));
        }
        return true;
    }

    /** Sunucunun yetkili kayıtlarından birebir ad eşleşmeleri (çevrimiçi + önbellekteki çevrimdışı). */
    private static List<UUID> bukkitCandidates(String name) {
        List<UUID> candidates = new ArrayList<>(2);
        Player online = Bukkit.getPlayerExact(name);
        if (online != null) {
            candidates.add(online.getUniqueId());
        }
        OfflinePlayer cached = Bukkit.getOfflinePlayerIfCached(name);
        if (cached != null && cached.getName() != null && cached.getName().equalsIgnoreCase(name)
                && !candidates.contains(cached.getUniqueId())) {
            candidates.add(cached.getUniqueId());
        }
        return candidates;
    }

    private void usage(CommandSender sender) {
        sender.sendMessage(Text.plain(Messages.get("link.unlink-usage-v2",
                "/unlink <oyuncu> [sebep] · /unlink mc <oyuncu> · /unlink dc <discord id> · /unlink uuid <uuid>"),
                NamedTextColor.RED));
    }

    private void warn(String message, Throwable error) {
        this.plugin.getLogger().log(Level.WARNING, "[link] " + message, error);
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (command.getName().equalsIgnoreCase("unlink") && args.length == 1) {
            return List.of("mc", "dc", "uuid");
        }
        return List.of();
    }
}
