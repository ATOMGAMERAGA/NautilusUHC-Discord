/**
 * Destek (ticket) sistemi saf iş mantığı — BAĞIMLILIKSIZ modül.
 *
 * Bu dosya bilerek discord.js, db.js veya config.js import ETMEZ: bot testleri
 * npm install olmadan saf Node ile koşar ve buradaki durum makinesi, SLA
 * hesabı, transcript üretimi ve açma-limiti kuralları birim test edilir.
 * Discord'a dokunan her şey tickets.js'te kalır.
 */

/* ------------------------------------------------------------------ */
/* Talep türleri                                                       */
/* ------------------------------------------------------------------ */

/**
 * Talep türleri. `desc` panel menüsünde, `subjectHint`/`extraHint` ise modal
 * yer tutucularında görünür — kullanıcı ne yazacağını örnekten anlar.
 */
export const TICKET_TYPES = {
  genel: {
    label: 'Genel Destek', emoji: '🎫', desc: 'Sorular ve diğer yardım talepleri',
    subjectHint: 'Örn: Maça nasıl katılırım?',
  },
  hesap: {
    label: 'Hesap Bağlantısı', emoji: '🔗', desc: 'Minecraft hesabını bağlarken yaşanan sorunlar',
    subjectHint: 'Örn: Bağlantı kodum çalışmıyor',
  },
  sikayet: {
    label: 'Oyuncu Şikâyeti', emoji: '🚨', desc: 'Kural ihlali bildir',
    extraField: 'Şikâyet edilen oyuncu', extraHint: 'Örn: Atom',
    subjectHint: 'Örn: Maçta takım ihlali',
  },
  itiraz: {
    label: 'Ceza İtirazı', emoji: '⚖️', desc: 'Aldığın ban veya susturmaya itiraz et',
    extraField: 'Oyuncu adı / ceza no', extraHint: 'Örn: Atom veya #124',
    subjectHint: 'Örn: Haksız ban itirazı',
  },
  teknik: {
    label: 'Teknik Sorun', emoji: '🔧', desc: 'Bağlantı, bot veya sunucu kaynaklı sorunlar',
    subjectHint: 'Örn: Sunucuya bağlanamıyorum',
  },
  magaza: {
    label: 'Mağaza / Ödeme', emoji: '💳', desc: 'Satın alma ve ödeme sorunları',
    subjectHint: 'Örn: Ödemem hesabıma geçmedi',
  },
  diger: {
    label: 'Diğer', emoji: '💬', desc: 'Listede olmayan bir konu',
    subjectHint: 'Konuyu tek cümleyle özetle',
  },
};

export function ticketTypeLabel(type) {
  return TICKET_TYPES[type]?.label ?? TICKET_TYPES.genel.label;
}

/* ------------------------------------------------------------------ */
/* Durum makinesi                                                      */
/* ------------------------------------------------------------------ */

export const STATUSES = ['open', 'pending', 'closed'];

export const STATUS_LABELS = {
  open: 'Açık',
  pending: 'Beklemede',
  closed: 'Kapalı',
};

/** Geçerli durum geçişleri. closed→open = yeniden açma. */
const TRANSITIONS = {
  open: ['pending', 'closed'],
  pending: ['open', 'closed'],
  closed: ['open'],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/**
 * Bir durumu geçirir; geçersiz geçişte { ok: false, error } döner.
 * closed→open geçişi reopen_count'u artırır ve kapanış alanlarını sıfırlar.
 * Girdi nesnesi DEĞİŞTİRİLMEZ; uygulanacak alanlar `changes` içinde döner.
 */
export function applyTransition(ticket, to) {
  const from = ticket.status;
  if (!STATUSES.includes(to)) {
    return { ok: false, error: `Geçersiz durum: ${to}` };
  }
  if (!canTransition(from, to)) {
    return { ok: false, error: `Geçersiz durum geçişi: ${STATUS_LABELS[from] ?? from} → ${STATUS_LABELS[to] ?? to}` };
  }
  const changes = { status: to };
  if (from === 'closed' && to === 'open') {
    changes.reopen_count = (ticket.reopen_count ?? 0) + 1;
    changes.closed_at = null;
    changes.closed_by = null;
    changes.close_reason = null;
    changes.satisfaction = ticket.satisfaction ?? null; // memnuniyet puanı tarihsel olarak kalır
  }
  return { ok: true, changes };
}

/* ------------------------------------------------------------------ */
/* Öncelik                                                             */
/* ------------------------------------------------------------------ */

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export const PRIORITY_LABELS = {
  low: 'Düşük',
  normal: 'Normal',
  high: 'Yüksek',
  urgent: 'Acil',
};

/** Öncelik döngüsü: low → normal → high → urgent → low. */
export function nextPriority(priority) {
  const i = PRIORITIES.indexOf(priority);
  return PRIORITIES[(i + 1) % PRIORITIES.length];
}

/* ------------------------------------------------------------------ */
/* SLA hesabı                                                          */
/* ------------------------------------------------------------------ */

/** Önceliğe göre ilk yanıt hedefi (dakika). */
export const DEFAULT_SLA_MINUTES = {
  urgent: 30,
  high: 60,
  normal: 240,
  low: 1440,
};

export function slaTargetMinutes(priority, overrides = {}) {
  const v = overrides[priority] ?? DEFAULT_SLA_MINUTES[priority] ?? DEFAULT_SLA_MINUTES.normal;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SLA_MINUTES.normal;
}

/**
 * SLA durumu: ilk yanıt verilmiş mi, hedef aşılmış mı, ne kadar kaldı?
 * @returns {{ targetMinutes, dueAt, responded, breached, remainingMs }}
 */
export function slaState(ticket, now = Date.now(), overrides = {}) {
  const targetMinutes = slaTargetMinutes(ticket.priority, overrides);
  const dueAt = ticket.created_at + targetMinutes * 60_000;
  const responded = ticket.first_response_at != null;
  if (responded) {
    return {
      targetMinutes,
      dueAt,
      responded: true,
      breached: ticket.first_response_at > dueAt,
      remainingMs: 0,
    };
  }
  return {
    targetMinutes,
    dueAt,
    responded: false,
    breached: now > dueAt,
    remainingMs: Math.max(0, dueAt - now),
  };
}

/* ------------------------------------------------------------------ */
/* Gizli bilgi maskeleme                                               */
/* ------------------------------------------------------------------ */

/**
 * Transcript'lerde sızabilecek sırları maskeler:
 *  - token/secret/şifre/password/parola/api key = değer kalıpları
 *  - ≥32 karakterlik hex blob'lar
 *  - ≥40 karakterlik base64 benzeri blob'lar (uzun eşik: normal kelimeleri korur)
 */
export function maskSecrets(text) {
  if (!text) return text ?? '';
  return String(text)
    .replace(/(token|secret|şifre|sifre|password|parola|api[-_]?key)([=:]\s*)\S+/gi, '$1$2***GİZLİ***')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***GİZLİ***')
    .replace(/\b[A-Za-z0-9+/_.-]{40,}={0,2}\b/g, '***GİZLİ***');
}

/* ------------------------------------------------------------------ */
/* Transcript üretimi                                                  */
/* ------------------------------------------------------------------ */

const defaultFormatTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * ticket_messages satırlarından UTF-8 düz metin transcript üretir.
 * @param {object} ticket tickets_v2 satırı
 * @param {Array} rows { author_tag, content, embeds_summary, attachments, created_at }
 * @param {object} [opts] { formatTime } — ör. Türkiye saati biçimleyici
 */
export function renderTranscript(ticket, rows, opts = {}) {
  const formatTime = opts.formatTime ?? defaultFormatTime;
  const head = [
    `NautilusUHC destek transcript — Talep #${ticket.id}`,
    `Tür: ${ticketTypeLabel(ticket.type)}`,
    `Konu: ${ticket.subject ?? '-'}`,
    `Açan: ${ticket.user_id}`,
    `Durum: ${STATUS_LABELS[ticket.status] ?? ticket.status} • Öncelik: ${PRIORITY_LABELS[ticket.priority] ?? ticket.priority}`,
    `Açılış: ${formatTime(ticket.created_at)}`,
    ticket.closed_at ? `Kapanış: ${formatTime(ticket.closed_at)}${ticket.close_reason ? ` — ${ticket.close_reason}` : ''}` : null,
    `Mesaj sayısı: ${rows.length}`,
  ].filter(Boolean);

  const lines = rows.map((m) => {
    let attachments = [];
    try {
      const parsed = typeof m.attachments === 'string' ? JSON.parse(m.attachments || '[]') : (m.attachments ?? []);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch { /* bozuk JSON — eksiz devam */ }
    const parts = [`[${formatTime(m.created_at)}] ${m.author_tag}: ${m.content ?? ''}`];
    if (m.embeds_summary) parts.push(`  [embed] ${m.embeds_summary}`);
    for (const a of attachments) {
      parts.push(`  [dosya] ${typeof a === 'string' ? a : `${a.name ?? 'dosya'} — ${a.url ?? ''}`}`);
    }
    return parts.join('\n');
  });

  return maskSecrets(`${head.join('\n')}\n${'─'.repeat(60)}\n${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ */
/* Açma limiti / bekleme süresi                                        */
/* ------------------------------------------------------------------ */

export const DEFAULT_MAX_OPEN = 1;
export const DEFAULT_COOLDOWN_MINUTES = 10;

/**
 * Yeni talep açılabilir mi?
 * @param {object} p { blacklisted, openCount, maxOpen, lastOpenAt, cooldownMinutes, now }
 * @returns {{ ok: true } | { ok: false, reason, message, retryInMs? }}
 */
export function checkOpenAllowed({
  blacklisted = false,
  openCount = 0,
  maxOpen = DEFAULT_MAX_OPEN,
  lastOpenAt = null,
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
  now = Date.now(),
} = {}) {
  if (blacklisted) {
    return {
      ok: false,
      reason: 'blacklist',
      message: 'Destek sistemine erişimin kapatılmış durumda.\n'
        + 'Bunun bir yanlışlık olduğunu düşünüyorsan sunucudaki bir yetkiliye ulaş.',
    };
  }
  const effectiveMax = Number.isFinite(maxOpen) && maxOpen > 0 ? maxOpen : DEFAULT_MAX_OPEN;
  if (openCount >= effectiveMax) {
    return {
      ok: false,
      reason: 'limit',
      message: effectiveMax === 1
        ? 'Zaten açık bir destek talebin var. Yeni bir tane açmadan önce onu kapatman gerekiyor.'
        : `Aynı anda en fazla **${effectiveMax}** açık destek talebin olabilir.`,
    };
  }
  const cooldown = Number.isFinite(cooldownMinutes) && cooldownMinutes >= 0
    ? cooldownMinutes : DEFAULT_COOLDOWN_MINUTES;
  if (lastOpenAt != null && cooldown > 0) {
    const readyAt = lastOpenAt + cooldown * 60_000;
    if (now < readyAt) {
      const retryInMs = readyAt - now;
      const mins = Math.ceil(retryInMs / 60_000);
      return {
        ok: false,
        reason: 'cooldown',
        retryInMs,
        message: `Yeni bir talep açmak için **${mins} dakika** beklemen gerekiyor.`,
      };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Reconciliation (kanalı silinmiş talepler)                           */
/* ------------------------------------------------------------------ */

/**
 * Açık/beklemede olup kanalı artık var olmayan taleplerin id listesini döner.
 * @param {Array} activeTickets açık/beklemedeki tickets_v2 satırları
 * @param {Iterable<string>} existingChannelIds sunucuda hâlâ var olan kanal id'leri
 */
export function findOrphanTickets(activeTickets, existingChannelIds) {
  const existing = new Set(existingChannelIds);
  return activeTickets
    .filter((t) => t.channel_id && !existing.has(t.channel_id))
    .map((t) => t.id);
}
