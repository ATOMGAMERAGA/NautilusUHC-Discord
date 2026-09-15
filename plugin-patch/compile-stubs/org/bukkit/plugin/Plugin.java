package org.bukkit.plugin;

import org.bukkit.configuration.file.FileConfiguration;

import java.io.File;
import java.util.logging.Logger;

/** Yalnız derleme stub'ı. */
public interface Plugin {
    FileConfiguration getConfig();

    Logger getLogger();

    File getDataFolder();
}
