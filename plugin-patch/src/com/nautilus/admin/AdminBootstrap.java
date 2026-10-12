/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  org.bukkit.Bukkit
 *  org.bukkit.command.CommandExecutor
 *  org.bukkit.command.PluginCommand
 *  org.bukkit.command.TabCompleter
 *  org.bukkit.event.Listener
 *  org.bukkit.plugin.Plugin
 */
package com.nautilus.admin;

import com.nautilus.NautilusUHC;
import com.nautilus.admin.AdminController;
import org.bukkit.Bukkit;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.PluginCommand;
import org.bukkit.command.TabCompleter;
import org.bukkit.event.Listener;
import org.bukkit.plugin.Plugin;

public final class AdminBootstrap {
    private static AdminController controller;
    private static final ThreadLocal<Integer> announcementTeam;

    private AdminBootstrap() {
    }

    public static boolean isScheduledAnnouncement() { return announcementTeam.get() != null; }

    public static int announcementTeamLimit(int n) {
        Integer n2 = announcementTeam.get();
        return n2 == null ? n : n2;
    }

    public static void withAnnouncementTeam(int n, Runnable runnable) {
        announcementTeam.set(n);
        try {
            runnable.run();
        }
        finally {
            announcementTeam.remove();
        }
    }

    public static void install(NautilusUHC nautilusUHC) {
        if (!nautilusUHC.isEnabled() || nautilusUHC.getUhcMatch() == null || nautilusUHC.getSchedule() == null) {
            return;
        }
        PluginCommand pluginCommand = nautilusUHC.getCommand("uhcadmin");
        if (pluginCommand == null) {
            throw new IllegalStateException("/uhcadmin plugin.yml kayd\u0131 eksik");
        }
        nautilusUHC.getTeams().setLimit(TeamPolicy.limit(nautilusUHC.getTeams().getLimit()));
        if(nautilusUHC.getTeams().getLimit()==1)nautilusUHC.getTeams().clearAssignments();
        controller = new AdminController(nautilusUHC);
        pluginCommand.setExecutor((CommandExecutor)controller);
        pluginCommand.setTabCompleter((TabCompleter)controller);
        Bukkit.getPluginManager().registerEvents((Listener)controller, (Plugin)nautilusUHC);
        TeamAdminGui teams = new TeamAdminGui(nautilusUHC);
        nautilusUHC.getCommand("teamadmin").setExecutor(teams);
        Bukkit.getPluginManager().registerEvents(teams, nautilusUHC);
        com.nautilus.auth.SingleIpListener.install(nautilusUHC);
        nautilusUHC.getLogger().info("/uhcadmin y\u00f6netim paneli ve kal\u0131c\u0131 ma\u00e7 takvimi haz\u0131r.");
    }

    public static void shutdown() {
        if (controller != null) {
            controller.shutdown();
            controller = null;
        }
    }

    static {
        announcementTeam = new ThreadLocal();
    }
}

