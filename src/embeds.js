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

/* ------------------------------------------------------------------ */
/* Marka                                                               */
/* ------------------------------------------------------------------ */

/**
 * Tek isimlendirme kuralı:
 *  - Discord/topluluk markası → "Nautilus PvP"
 *  - Minecraft UHC ürünü/sunucusu → "NautilusUHC"
 * Metinlerde bu ikisi dışında bir varyant kullanılmaz.
 */
export const Brand = {
  community: 'Nautilus PvP',
  product: 'NautilusUHC',
  domain: 'nautilusuhc.com',
};

/* ------------------------------------------------------------------ */
/* Semantik renkler                                                    */
/* ------------------------------------------------------------------ */

/**
 * Renk asla dekoratif seçilmez; anlam taşır.
 *   brand   → marka yüzeyleri, paneller, nötr bilgi kartları
 *   success → tamamlanan işlem, olumlu durum
 *   warn    → dikkat gerektiren durum, geri alınabilir yaptırım
 *   danger  → hata, yıkıcı işlem, ceza
 *   info    → bilgilendirme, liste, rapor
 *   neutral → boş durum / pasif / arşiv
 */
export const Colors = {
  brand: 0x00b3b3,
  success: 0x2ecc71,
  warn: 0xf1c40f,
  danger: 0xe74c3c,
  info: 0x3498db,
  neutral: 0x2c3e50,

  /* Geriye dönük adlar — mevcut çağrılar kırılmasın diye korunur. */
  main: 0x00b3b3,
  dark: 0x2c3e50,
};

/* ------------------------------------------------------------------ */
/* Discord limitleri                                                   */
/* ------------------------------------------------------------------ */

/** Discord'un embed limitleri — her metin bunlara göre kırpılır. */
export const Limits = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  footer: 2048,
  author: 256,
};

/** Metni limite sığdırır; kırpılan metnin sonuna "…" konur. */
export function fit(text, max) {
  if (text == null) return text;
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Embed üreticisini limitlere karşı sağlamlaştırır: başlık/açıklama/alan
 * metinleri kırpılır, 25'ten fazla alan sessizce düşürülür, boş alan değeri
 * geçerli bir yer tutucuya çevrilir. Böylece dinamik veri (oyuncu adı, sebep,
 * transcript parçası) hiçbir zaman Discord tarafından reddedilen bir embed
 * üretemez.
 */
function harden(Base) {
  return class NautilusEmbed extends Base {
    setTitle(value) {
      return super.setTitle(fit(value, Limits.title));
    }

    setDescription(value) {
      return super.setDescription(fit(value, Limits.description));
    }

    setFooter(footer) {
      if (!footer) return super.setFooter(footer);
      const raw = typeof footer === 'string' ? { text: footer } : footer;
      return super.setFooter({ ...raw, text: fit(raw.text, Limits.footer) });
    }

    setAuthor(author) {
      if (!author) return super.setAuthor(author);
      return super.setAuthor({ ...author, name: fit(author.name, Limits.author) });
    }

    addFields(...fields) {
      const incoming = fields.flat().filter(Boolean).map((f) => ({
        ...f,
        name: fit(f.name, Limits.fieldName) || '​',
        value: fit(f.value, Limits.fieldValue) || '—',
      }));
      const room = Limits.fields - (this.data.fields?.length ?? 0);
      if (room <= 0) return this;
      return super.addFields(incoming.slice(0, room));
    }
  };
}

const NautilusEmbed = harden(EmbedBuilder);

/* ------------------------------------------------------------------ */
/* Görseller                                                           */
/* ------------------------------------------------------------------ */

/** Build a URL to a file the website serves under /assets. */
export const asset = (path) => `${config.siteUrl}/assets/${path.replace(/^\/+/, '')}`;

/**
 * Named handles for the website's own art, reused here so Discord embeds and the
 * site share one identity. Grouped by intent:
 *  - brand: logo/wordmark marks (PNG only — Discord can't render the SVG mark).
 *  - block/item: vanilla Minecraft icons, used as thematic thumbnails.
 * Discord requires https image URLs, so these resolve against config.siteUrl.
 *
 * Kullanım kuralı: thumbnail yalnız bağlamı olan yüzeylerde (profil, maç,
 * envanter, sıralama, hesap bağlama); büyük görsel yalnız hoş geldin ve
 * kritik maç duyurularında. Sıradan başarı/hata mesajlarına görsel konmaz.
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

/* ------------------------------------------------------------------ */
/* Temel yapı taşları                                                  */
/* ------------------------------------------------------------------ */

/**
 * Marka altbilgisi. Bağlama özel bilgi (sayfa, toplam, durum) öne yazılır:
 *   brandFooter('Sayfa 1/3') → "Sayfa 1/3 • Nautilus PvP"
 * Hiç parça verilmezse site adresi eklenir.
 */
export function brandFooter(...parts) {
  const extra = parts.filter(Boolean).map(String);
  const text = extra.length
    ? [...extra, Brand.community].join(' • ')
    : `${Brand.community} • ${Brand.domain}`;
  return { text: fit(text, Limits.footer), iconURL: Assets.mark };
}

/**
 * Her embed'in ortak iskeleti: semantik renk + marka altbilgisi.
 *
 * Zaman damgası BİLEREK varsayılan değildir — ephemeral bir "rol verildi"
 * kartında saat bilgisi gürültüdür. Zamanın gerçekten anlamlı olduğu yerler
 * (staff logları, maç duyuruları, durum panosu) `.setTimestamp()` çağırır.
 */
export function baseEmbed(color = Colors.brand, icon = Assets.mark) {
  return new NautilusEmbed()
    .setColor(color)
    .setFooter(icon === Assets.mark ? brandFooter() : { ...brandFooter(), iconURL: icon });
}

/** Başlık + açıklamayı tek adımda kuran iç yardımcı. */
function semantic(color, description, title) {
  const e = baseEmbed(color);
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  return e;
}

/** Tamamlanan işlem. Açıklama "ne değişti"yi söyler, renk "başarılı"yı. */
export function okEmbed(description, title) {
  return semantic(Colors.success, description, title);
}

/** Hata. Mümkünse kullanıcının atacağı adımı da içerir. */
export function errEmbed(description, title) {
  return semantic(Colors.danger, description, title);
}

/** Dikkat gerektiren ama hata olmayan durum. */
export function warnEmbed(description, title) {
  return semantic(Colors.warn, description, title);
}

/** Bilgilendirme / liste / rapor. */
export function infoEmbed(description, title) {
  return semantic(Colors.info, description, title);
}

/** Pasif, arşiv veya "şu an bir şey yok" durumları. */
export function neutralEmbed(description, title) {
  return semantic(Colors.neutral, description, title);
}

/**
 * Boş durum kartı: "kayıt yok" demek yerine bağlamı ve varsa sıradaki adımı
 * gösterir. `hint` ikinci satıra düşer.
 */
export function emptyEmbed(title, description, hint) {
  return neutralEmbed([description, hint].filter(Boolean).join('\n'), title);
}

/* Okunabilirlik için ikinci adlar — yeni kod bunları da kullanabilir. */
export const successEmbed = okEmbed;
export const errorEmbed = errEmbed;
export const warningEmbed = warnEmbed;

/* ------------------------------------------------------------------ */
/* Köprü (Minecraft) hatalarının sınıflandırılması                     */
/* ------------------------------------------------------------------ */

/**
 * Köprü/plugin yanıtını kullanıcıya gösterilebilir bir hâle çevirir.
 *
 * KURAL: ham hata metni (`res.error`), HTTP durum kodu, uç nokta adı veya
 * istisna mesajı kullanıcıya ASLA gösterilmez — bunlar yalnız konsola yazılır.
 * Burası saf bir fonksiyondur; test edilebilir.
 *
 * @returns {{ kind: string, title: string, description: string }}
 */
export function classifyBridgeError(res = {}) {
  const status = Number(res?.status);
  const errorCode = String(res?.errorCode ?? '');

  // Taşıma katmanının kendi kodları status'tan ÖNCE gelir: bunların HTTP
  // karşılığı yoktur ve "kayıt bulunamadı" gibi yanlış bir anlama düşmemeleri
  // gerekir (bkz. linkflow.js — sahte "kod geçersiz" arızasının kökeni).
  if (errorCode === 'plugin_not_connected') {
    return {
      kind: 'not_connected',
      title: 'Minecraft Plugin Bağlantısı Yok',
      description: 'Minecraft eklentisi şu anda bota bağlı değil.\n'
        + 'Sunucu açıldığında tekrar dene; sorun sürerse bir yetkiliye bildir.',
    };
  }
  if (errorCode === 'bridge_misconfigured') {
    return {
      kind: 'misconfigured',
      title: 'Köprü Ayarı Hatalı',
      description: 'İstek Minecraft eklentisine yönlendirilemiyor.\n'
        + 'Lütfen bir yetkiliye bildir.',
    };
  }
  if (errorCode === 'multiple_plugin_instances') {
    return {
      kind: 'ambiguous_plugin_instance',
      title: 'Birden Fazla Sunucu Bağlı',
      description: 'Köprüye birden fazla Minecraft sunucusu bağlı; isteğin hangisine gideceği '
        + 'belirsiz olduğu için gönderilmedi.\nLütfen bir yetkiliye bildir.',
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: 'permission',
      title: 'İşlem Reddedildi',
      description: 'Bu işlem için gerekli yetkiye sahip değilsin.',
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      title: 'Kayıt Bulunamadı',
      description: 'Aradığın kayıt Minecraft sunucusunda bulunamadı.',
    };
  }
  if (status === 409) {
    return {
      kind: 'conflict',
      title: 'İşlem Yapılamadı',
      description: 'Bu kayıt şu anki durumuyla çakışıyor. Güncel durumu kontrol edip tekrar dene.',
    };
  }
  if (status === 429) {
    return {
      kind: 'rate_limited',
      title: 'Çok Fazla İstek',
      description: 'Minecraft sunucusu şu anda çok fazla istek alıyor. Birkaç saniye sonra tekrar dene.',
    };
  }
  if (status >= 500) {
    return {
      kind: 'server_error',
      title: 'İşlem Tamamlanamadı',
      description: 'Minecraft sunucusu isteği işleyemedi. Sorun sürerse bir yetkiliye bildir.',
    };
  }
  if (status >= 400) {
    return {
      kind: 'invalid',
      title: 'İşlem Tamamlanamadı',
      description: 'Gönderilen bilgiler Minecraft sunucusu tarafından kabul edilmedi. Bilgileri kontrol edip tekrar dene.',
    };
  }
  return {
    kind: 'unreachable',
    title: 'Sunucuya Ulaşılamıyor',
    description: 'Minecraft sunucusu şu anda yanıt vermiyor.\nBirkaç dakika sonra tekrar dene.',
  };
}

/**
 * Köprü hatası için hazır embed. Ham hata konsola düşer, kullanıcı yalnızca
 * sınıflandırılmış Türkçe mesajı görür.
 *
 * @param {object} res mcapi yanıtı ({ ok:false, error, status })
 * @param {object} [opts] { context } — konsol logunda görünen çağrı adı.
 */
export function bridgeErrorEmbed(res, { context } = {}) {
  const info = classifyBridgeError(res);
  if (res?.error) {
    // Korelasyon kimliği ve backend hata kodu logda kalır; kullanıcı yalnız
    // sınıflandırılmış metni görür.
    const trace = [res.correlationId && `cid=${res.correlationId}`, res.errorCode && `code=${res.errorCode}`]
      .filter(Boolean).join(' ');
    console.warn(`[köprü] ${context ?? 'istek'} başarısız (${info.kind})${trace ? ` ${trace}` : ''}: ${res.error}`);
  }
  return errEmbed(info.description, info.title);
}

/**
 * Beklenmeyen istisnalar için tek tip son çare. Gerçek hata çağıranın
 * console.error'unda kalır.
 */
export function failureEmbed(hint) {
  return errEmbed(
    ['İşlem tamamlanamadı. Lütfen tekrar dene.', hint].filter(Boolean).join('\n'),
    'Bir Şeyler Ters Gitti',
  );
}
