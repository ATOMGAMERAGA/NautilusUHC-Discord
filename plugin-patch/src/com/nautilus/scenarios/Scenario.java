/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  org.bukkit.Material
 */
package com.nautilus.scenarios;

import com.nautilus.scenarios.AnonymousListener;
import com.nautilus.scenarios.GoldenHeadsListener;
import com.nautilus.scenarios.HasteyBoysListener;
import com.nautilus.scenarios.NoCleanListener;
import com.nautilus.scenarios.NoFallListener;
import com.nautilus.scenarios.SafeLootListener;
import com.nautilus.scenarios.ScenarioListener;
import com.nautilus.scenarios.ShieldlessListener;
import com.nautilus.scenarios.SpeedyMinersListener;
import java.util.Locale;
import org.bukkit.Material;

public enum Scenario {
    SAFE_LOOT("safe_loot", Material.CHEST, SafeLootListener.class),
    AUTO_SMELT("auto_smelt", Material.FURNACE, null),
    TEAM_BACKPACKS("team_backpacks", Material.ENDER_CHEST, null),
    LUCKY_ORES("lucky_ores", Material.DIAMOND_ORE, null),
    GOLDEN_HEADS("golden_heads", Material.PLAYER_HEAD, GoldenHeadsListener.class),
    NO_CLEAN("no_clean", Material.TOTEM_OF_UNDYING, NoCleanListener.class),
    HASTEY_BOYS("hastey_boys", Material.SUGAR, HasteyBoysListener.class),
    NO_FALL("no_fall", Material.FEATHER, NoFallListener.class),
    TIME_BOMB("time_bomb", Material.TNT, null),
    SHIELDLESS("shieldless", Material.BARRIER, ShieldlessListener.class),
    SPEEDY_MINERS("speedy_miners", Material.GOLDEN_PICKAXE, SpeedyMinersListener.class),
    ANONYMOUS("anonymous", Material.NAME_TAG, AnonymousListener.class),
    VEINMINER("veinminer", Material.IRON_PICKAXE, null),
    NO_FIRE("no_fire", Material.LAVA_BUCKET, NoFireListener.class);

    private final String key;
    private final Material icon;
    private final Class<? extends ScenarioListener> listener;

    private Scenario(String key, Material icon, Class<? extends ScenarioListener> listener) {
        this.key = key;
        this.icon = icon;
        this.listener = listener;
    }

    public String key() {
        return this.key;
    }

    public Material icon() {
        return this.icon;
    }

    public Class<? extends ScenarioListener> listener() {
        return this.listener;
    }

    public String displayName() {
        if (this == NO_FIRE) return "Ateşten Korunma";
        String[] words = this.key.split("_");
        StringBuilder sb = new StringBuilder();
        for (String word : words) {
            if (!sb.isEmpty()) {
                sb.append(' ');
            }
            sb.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1).toLowerCase(Locale.ROOT));
        }
        return sb.toString();
    }

    public static Scenario byKey(String key) {
        for (Scenario scenario : Scenario.values()) {
            if (!scenario.key.equalsIgnoreCase(key)) continue;
            return scenario;
        }
        return null;
    }
}

