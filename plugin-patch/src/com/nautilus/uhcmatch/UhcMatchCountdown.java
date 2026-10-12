/*
 * Decompiled with CFR 0.152.
 *
 * Could not load the following classes:
 *  com.nautilus.uhcmatch.UhcMatchManager
 *  com.nautilus.util.Text
 *  net.kyori.adventure.text.Component
 *  net.kyori.adventure.text.TextComponent
 *  net.kyori.adventure.text.format.NamedTextColor
 *  net.kyori.adventure.text.format.TextColor
 *  net.kyori.adventure.title.Title
 *  net.kyori.adventure.title.Title$Times
 *  org.bukkit.Bukkit
 *  org.bukkit.Sound
 *  org.bukkit.entity.Player
 *  org.bukkit.plugin.Plugin
 *  org.bukkit.scheduler.BukkitRunnable
 *  org.bukkit.scheduler.BukkitTask
 */
package com.nautilus.uhcmatch;

import com.nautilus.uhcmatch.UhcMatchManager;
import com.nautilus.util.Text;
import java.time.Duration;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.title.Title;
import org.bukkit.Bukkit;
import org.bukkit.Sound;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitRunnable;
import org.bukkit.scheduler.BukkitTask;

public class UhcMatchCountdown {
    private final Plugin plugin;
    private final UhcMatchManager manager;
    private final int totalSeconds;
    private BukkitTask task;
    private volatile int elapsedSeconds;

    public UhcMatchCountdown(Plugin plugin, UhcMatchManager manager, int totalSeconds) {
        this.plugin = plugin;
        this.manager = manager;
        this.totalSeconds = totalSeconds;
    }

    public void begin() {
        if (this.totalSeconds <= 0) {
            this.finishCountdown();
            return;
        }
        this.announceTime(this.totalSeconds);
        this.task = new BukkitRunnable(){

            public void run() {
                ++UhcMatchCountdown.this.elapsedSeconds;
                int remaining = UhcMatchCountdown.this.totalSeconds - UhcMatchCountdown.this.elapsedSeconds;
                if (remaining == 600 || remaining == 300 || remaining == 60 || remaining == 30) {
                    UhcMatchCountdown.this.announceTime(remaining);
                }
                if (remaining >= 1 && remaining <= 10) {
                    boolean early = remaining > 3;
                    Component number = early ? Text.bold((String)String.valueOf(remaining), (NamedTextColor)NamedTextColor.AQUA) : Text.bold((String)String.valueOf(remaining), (NamedTextColor)NamedTextColor.RED);
                    for (Player player : Bukkit.getOnlinePlayers()) {
                        player.showTitle(Title.title((Component)number, (Component)Text.plain((String)"UHC ba\u015fl\u0131yor", (NamedTextColor)NamedTextColor.GRAY), (Title.Times)Title.Times.times((Duration)Duration.ZERO, (Duration)Duration.ofMillis(900L), (Duration)Duration.ofMillis(100L))));
                        if (early) {
                            player.playSound(player.getLocation(), Sound.BLOCK_NOTE_BLOCK_PLING, 1.0f, 1.0f + (float)(10 - remaining) * 0.06f);
                            continue;
                        }
                        player.playSound(player.getLocation(), Sound.BLOCK_NOTE_BLOCK_BELL, 1.0f, 1.5f);
                    }
                }
                if (remaining <= 0) {
                    this.cancel();
                    UhcMatchCountdown.this.finishCountdown();
                }
            }
        }.runTaskTimer(this.plugin, 20L, 20L);
    }

    private void finishCountdown() {
        com.nautilus.admin.AnnouncementRuntime.finishCountdown(this.manager::onCountdownFinished,this.manager::isStarted);
    }

    private void announceTime(int seconds) {
        String time = seconds >= 60 ? seconds / 60 + " dakika" : seconds + " saniye";
        Bukkit.broadcast((Component)((TextComponent)((TextComponent)Component.text((String)"\u25c6 ", (TextColor)NamedTextColor.AQUA).append(Text.bold((String)"Nautilus UHC", (NamedTextColor)NamedTextColor.AQUA))).append(Text.plain((String)" \u00b7 ", (NamedTextColor)NamedTextColor.DARK_GRAY))).append(Text.plain((String)(time + " sonra ba\u015flayacak!"), (NamedTextColor)NamedTextColor.YELLOW)));
        for (Player player : Bukkit.getOnlinePlayers()) {
            player.playSound(player.getLocation(), Sound.UI_BUTTON_CLICK, 0.7f, 1.2f);
        }
    }

    public int remainingSeconds() {
        return Math.max(0, this.totalSeconds - this.elapsedSeconds);
    }

    public void cancel() {
        if (this.task != null) {
            this.task.cancel();
            this.task = null;
        }
    }
}
