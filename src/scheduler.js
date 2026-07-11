import { config } from './config.js';
import { dueTasks, finishTask, giveaways, polls, addCase } from './db.js';
import { baseEmbed, Colors } from './embeds.js';
import { sendLog } from './modlog.js';
import { clean } from './util.js';

/**
 * Persistent scheduler: tasks live in SQLite, so timed actions (tempban unbans,
 * reminders, giveaway/poll endings) survive restarts. Ticks every 20 seconds.
 */

const TICK_MS = 20_000;

/* ------------------------------------------------------------------ */
/* Giveaways                                                           */
/* ------------------------------------------------------------------ */

function pickWinners(entries, count) {
  const pool = [...entries];
  const winners = [];
  while (pool.length && winners.length < count) {
    winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return winners;
}

/** Ends a giveaway, edits its message and announces winners. */
export async function endGiveaway(client, id, { reroll = false } = {}) {
  const gw = giveaways.get(id);
  if (!gw || (gw.ended && !reroll)) return null;
  giveaways.end(id);

  const entries = giveaways.entries(id);
  const winners = pickWinners(entries, gw.winner_count);
  const channel = await client.channels.fetch(gw.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return winners;

  const mention = winners.length ? winners.map((w) => `<@${w}>`).join(', ') : null;
  const resultEmbed = baseEmbed(winners.length ? Colors.success : Colors.dark)
    .setTitle(`🎉 Çekiliş Bitti — ${clean(gw.prize, 100)}`)
    .setDescription(winners.length
      ? `Kazanan${winners.length > 1 ? 'lar' : ''}: ${mention}\nKatılım: **${entries.length}** kişi`
      : `Kimse katılmadı, kazanan yok. (Katılım: ${entries.length})`);

  if (gw.message_id) {
    const msg = await channel.messages.fetch(gw.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [resultEmbed], components: [] }).catch(() => null);
  }
  await channel.send({
    content: mention ? `🎉 Tebrikler ${mention}! **${clean(gw.prize, 100)}** kazandınız!` : undefined,
    embeds: mention ? [] : [resultEmbed],
  }).catch(() => null);
  return winners;
}

/* ------------------------------------------------------------------ */
/* Polls                                                               */
/* ------------------------------------------------------------------ */

export function pollResultEmbed(poll) {
  const counts = polls.counts(poll.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = poll.options.map((opt, i) => {
    const n = counts[i] ?? 0;
    const pct = total === 0 ? 0 : Math.round((n / total) * 100);
    const bar = '█'.repeat(Math.round(pct / 10)).padEnd(10, '░');
    return `**${i + 1}.** ${clean(opt, 80)}\n\`${bar}\` ${n} oy (%${pct})`;
  });
  return baseEmbed(Colors.info)
    .setTitle(`📊 ${clean(poll.question, 200)}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Toplam ${total} oy • Nautilus PvP` });
}

/** Ends a poll and replaces its message with final results. */
export async function endPoll(client, id) {
  const poll = polls.get(id);
  if (!poll || poll.ended) return;
  polls.end(id);
  const channel = await client.channels.fetch(poll.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !poll.message_id) return;
  const msg = await channel.messages.fetch(poll.message_id).catch(() => null);
  const embed = pollResultEmbed(poll).setTitle(`📊 [BİTTİ] ${clean(poll.question, 190)}`);
  if (msg) await msg.edit({ embeds: [embed], components: [] }).catch(() => null);
  else await channel.send({ embeds: [embed] }).catch(() => null);
}

/* ------------------------------------------------------------------ */
/* Task dispatch                                                       */
/* ------------------------------------------------------------------ */

async function runTask(client, task) {
  const { type, data } = task;

  if (type === 'unban') {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;
    await guild.members.unban(data.userId, 'Süreli ban doldu (otomatik)').catch(() => null);
    addCase('unban', data.userId, client.user.id, 'Süreli ban otomatik doldu');
    await sendLog(client, {
      title: '🔓 Otomatik Unban',
      color: Colors.success,
      description: `<@${data.userId}> (\`${data.userId}\`) — süreli ban süresi doldu.`,
    });
    return;
  }

  if (type === 'reminder') {
    const channel = await client.channels.fetch(data.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send({
        content: `⏰ <@${data.userId}>`,
        embeds: [baseEmbed(Colors.info).setTitle('⏰ Hatırlatıcı').setDescription(clean(data.message, 1000))],
      }).catch(() => null);
    }
    return;
  }

  if (type === 'giveaway_end') {
    await endGiveaway(client, data.giveawayId);
    return;
  }

  if (type === 'poll_end') {
    await endPoll(client, data.pollId);
  }
}

export function startScheduler(client) {
  setInterval(async () => {
    for (const task of dueTasks()) {
      finishTask(task.id); // mark first: a crashing task must not loop forever
      try {
        await runTask(client, task);
      } catch (err) {
        console.error(`[scheduler] görev ${task.id} (${task.type}) hatası:`, err.message);
      }
    }
  }, TICK_MS).unref();
  console.log('[scheduler] kalıcı görev zamanlayıcısı aktif (20sn).');
}
