package org.bukkit.entity;

import org.bukkit.OfflinePlayer;
import org.bukkit.command.CommandSender;

import java.util.UUID;

/** Yalnız derleme stub'ı. */
public interface Player extends CommandSender, OfflinePlayer {
    @Override
    UUID getUniqueId();

    @Override
    String getName();
}
