import {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionFlagsBits,
} from 'discord.js';
import { okEmbed, errEmbed } from './embeds.js';
import { mcapi } from './mcapi.js';
import { addCase, giveaways, polls } from './db.js';
import { clean } from './util.js';
import { sendLog } from './modlog.js';
import { Colors } from './embeds.js';
import { openTicket, closeTicket } from './tickets.js';

/**
 * Component (button / modal) handlers, keyed by customId prefix. The link flow:
 * panel button → code modal → plugin verifies the code and creates the link.
 */
export const componentHandlers = {
  'link:open': async (interaction) => {
    const modal = new ModalBuilder()
      .setCustomId('link:modal')
      .setTitle('Minecraft Hesabını Bağla')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('code')
            .setLabel('Oyun içi /link kodunu gir')
            .setPlaceholder('Örn: A1B2C3')
            .setStyle(TextInputStyle.Short)
            .setMinLength(4)
            .setMaxLength(10)
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
  },

  'link:modal': async (interaction) => {
    const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
    await interaction.deferReply({ ephemeral: true });

    const status = await mcapi.linkStatus(`discord=${interaction.user.id}`);
    if (status.ok && status.linked) {
      return interaction.editReply({
        embeds: [errEmbed(`Hesabın zaten **${clean(status.mc, 30)}** ile bağlı. `
          + 'Bir yanlışlık olduğunu düşünüyorsan destek talebi aç.')],
      });
    }

    const res = await mcapi.linkVerify(code, interaction.user.id, interaction.user.tag);
    if (!res.ok) {
      const msg = res.status === 404 || /invalid|geçersiz/i.test(res.error ?? '')
        ? 'Kod geçersiz veya süresi dolmuş. Oyun içinde tekrar `/link` yazıp yeni kod al.'
        : res.error;
      return interaction.editReply({ embeds: [errEmbed(`❌ ${msg}`)] });
    }

    addCase('link_create', interaction.user.id, interaction.user.id, null, res.mc);
    await sendLog(interaction.client, {
      title: '🔗 Hesap Bağlandı',
      color: Colors.success,
      description: `${interaction.user} ↔ \`${clean(res.mc, 30)}\``,
    });
    return interaction.editReply({
      embeds: [okEmbed(`✅ Hesabın **${clean(res.mc, 30)}** Minecraft hesabına bağlandı!\n`
        + 'Artık maçlara katılabilirsin. İyi oyunlar! 🌊')],
    });
  },

  /* ---------------- Destek talepleri ---------------- */

  'ticket:open': (interaction) => openTicket(interaction),
  'ticket:close': (interaction) => closeTicket(interaction),

  /* ---------------- Çekiliş katılımı ---------------- */

  'gw:join': async (interaction) => {
    const id = Number.parseInt(interaction.customId.split(':')[2], 10);
    const gw = giveaways.get(id);
    if (!gw || gw.ended) {
      return interaction.reply({ embeds: [errEmbed('Bu çekiliş sona ermiş.')], ephemeral: true });
    }
    const joined = giveaways.enter(id, interaction.user.id);
    const count = giveaways.entries(id).length;
    return interaction.reply({
      embeds: [joined
        ? okEmbed(`🎉 Çekilişe katıldın! Şu anki katılımcı: **${count}**`)
        : errEmbed(`Bu çekilişe zaten katılmışsın. (Katılımcı: ${count})`)],
      ephemeral: true,
    });
  },

  /* ---------------- Anket oylama ---------------- */

  'poll:vote': async (interaction) => {
    const [, , rawId, rawChoice] = interaction.customId.split(':');
    const id = Number.parseInt(rawId, 10);
    const choice = Number.parseInt(rawChoice, 10);
    const poll = polls.get(id);
    if (!poll || poll.ended || !poll.options[choice]) {
      return interaction.reply({ embeds: [errEmbed('Bu anket sona ermiş.')], ephemeral: true });
    }
    polls.vote(id, interaction.user.id, choice);
    // Canlı sonuçları ankete işle (best-effort).
    try {
      const { pollResultEmbed } = await import('./scheduler.js');
      const embed = pollResultEmbed(poll);
      if (poll.ends_at) {
        embed.setDescription(`${embed.data.description}\n\nBitiş: <t:${Math.floor(poll.ends_at / 1000)}:R>`);
      }
      await interaction.message.edit({ embeds: [embed] });
    } catch {
      /* mesaj düzenlenemedi — oy yine de kayıtlı */
    }
    return interaction.reply({
      embeds: [okEmbed(`🗳️ Oyun kaydedildi: **${clean(poll.options[choice], 60)}**`)],
      ephemeral: true,
    });
  },

  /* ---------------- Buton-rol paneli ---------------- */

  'role': async (interaction) => {
    const roleId = interaction.customId.split(':')[1];
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      return interaction.reply({ embeds: [errEmbed('Bu rol artık mevcut değil.')], ephemeral: true });
    }
    const me = interaction.guild.members.me;
    const dangerous = role.permissions.any([
      PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ModerateMembers,
    ]);
    if (role.managed || dangerous || role.position >= me.roles.highest.position) {
      return interaction.reply({ embeds: [errEmbed('Bu rol panelden alınamaz.')], ephemeral: true });
    }
    const member = interaction.member;
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(role, 'Rol paneli');
      return interaction.reply({ embeds: [okEmbed(`➖ ${role} rolü kaldırıldı.`)], ephemeral: true });
    }
    await member.roles.add(role, 'Rol paneli');
    return interaction.reply({ embeds: [okEmbed(`➕ ${role} rolü verildi.`)], ephemeral: true });
  },
};

/** Finds the handler whose key matches the interaction's customId prefix. */
export function resolveComponent(customId) {
  for (const [prefix, handler] of Object.entries(componentHandlers)) {
    if (customId === prefix || customId.startsWith(`${prefix}:`)) return handler;
  }
  return null;
}
