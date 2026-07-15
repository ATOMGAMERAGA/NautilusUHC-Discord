import { config } from './config.js';

/*
 * discord.js üretim bağımlılığıdır; ancak bot testleri npm install olmadan
 * saf Node ile koşar. Bu yüzden EmbedBuilder yoksa aynı akıcı API'yi ve
 * `.data` şeklini sunan minimal bir shim kullanılır (yalnız testte devreye
 * girer; üretimde her zaman gerçek discord.js yüklüdür).
 */
let EmbedBuilder;
try {
  ({ EmbedBuilder } = await import('discord.js'));
} catch {
  EmbedBuilder = class EmbedShim {
    constructor() { this.data = {}; }
    setColor(v) { this.data.color = v; return this; }
    setTitle(v) { this.data.title = v; return this; }
    setDescription(v) { this.data.description = v; return this; }
    setThumbnail(url) { this.data.thumbnail = { url }; return this; }
    setImage(url) { this.data.image = { url }; return this; }
    setFooter(v) { this.data.footer = v; return this; }
    setTimestamp(t = new Date()) { this.data.timestamp = t.toISOString?.() ?? t; return this; }
    setAuthor(v) { this.data.author = v; return this; }
    setURL(v) { this.data.url = v; return this; }
    addFields(...fields) {
      this.data.fields = (this.data.fields ?? []).concat(fields.flat());
      return this;
    }
  };
}

/** Nautilus PvP palette. */
export const Colors = {
  main: 0x00b3b3,
  success: 0x2ecc71,
  warn: 0xf1c40f,
  danger: 0xe74c3c,
  info: 0x3498db,
  dark: 0x2c3e50,
};

/** Build a URL to a file the website serves under /assets. */
export const asset = (path) => `${config.siteUrl}/assets/${path.replace(/^\/+/, '')}`;

/**
 * Named handles for the website's own art, reused here so Discord embeds and the
 * site share one identity. Grouped by intent:
 *  - brand: logo/wordmark marks (PNG only — Discord can't render the SVG mark).
 *  - block/item: vanilla Minecraft icons, used as thematic thumbnails.
 * Discord requires https image URLs, so these resolve against config.siteUrl.
 */
export const Assets = {
  /** Circular medallion mark — the global footer icon and brand thumbnail. */
  mark: asset('nautilus-icon-mark.png'),
  /** Wordmark on a scene — a hero banner for setImage (welcome, scheduling). */
  wordmarkScene: asset('nautilus-wordmark-scene.png'),
  /** Plain wordmark. */
  wordmark: asset('nautilus-wordmark.png'),
  /** Thin decorative strip — a divider for setImage at the foot of an embed. */
  divider: asset('nautilus-divider-strip.png'),
  block: {
    cobblestone: asset('mc/block/cobblestone.png'),
    cobweb: asset('mc/block/cobweb.png'),
    oakPlanks: asset('mc/block/oak_planks.png'),
    obsidian: asset('mc/block/obsidian.png'),
  },
  item: {
    goldenApple: asset('mc/item/golden_apple.png'),
    diamondSword: asset('mc/item/diamond_sword.png'),
    diamondAxe: asset('mc/item/diamond_axe.png'),
    diamondChestplate: asset('mc/item/diamond_chestplate.png'),
    ironSword: asset('mc/item/iron_sword.png'),
    bow: asset('mc/item/bow.png'),
    enderPearl: asset('mc/item/ender_pearl.png'),
    fishingRod: asset('mc/item/fishing_rod.png'),
    enchantedBook: asset('mc/item/enchanted_book.png'),
    potion: asset('mc/item/potion.png'),
    diamond: asset('mc/item/diamond.png'),
  },
};

/**
 * Every embed carries the Nautilus mark in its footer, so the whole bot reads as
 * one branded surface. Pass an item/block icon as `icon` to override (e.g. a
 * golden apple on the match-result embed).
 */
export function baseEmbed(color = Colors.main, icon = Assets.mark) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: 'Nautilus PvP • nautilusuhc.com', iconURL: icon })
    .setTimestamp();
}

export function okEmbed(description) {
  return baseEmbed(Colors.success).setDescription(description);
}

export function errEmbed(description) {
  return baseEmbed(Colors.danger).setDescription(description);
}
