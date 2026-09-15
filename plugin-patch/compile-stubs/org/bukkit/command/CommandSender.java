package org.bukkit.command;

import net.kyori.adventure.text.Component;

/** Yalnız derleme stub'ı. */
public interface CommandSender {
    void sendMessage(Component message);

    boolean hasPermission(String permission);

    String getName();
}
