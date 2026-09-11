import {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import {
  okEmbed, errEmbed, warnEmbed, neutralEmbed, Colors,
} from './embeds.js';
import { mcapi } from './mcapi.js';
import { verifyLinkCode } from './linkflow.js';
import { addCase, giveaways, polls, dmSubscriptions } from './db.js';
import { confirmDecision } from './matchdm.js';
import { clean, codeText } from './util.js';
import { sendLog } from './modlog.js';
import { ticketComponents } from './tickets.js';
import { buildLivePayload } from './commands/mac.js';
import { syncMemberTierRole, roleMap } from './rolesync.js';

/**
 * Component (button / modal) handlers, keyed by customId prefix.
 *
 * customId'ler köprü/panel sözleşmesinin parçasıdır ve DEĞİŞTİRİLMEZ; yalnız
 * kullanıcıya görünen metin, renk ve akış geri bildirimi tasarlanır.
 * Hesap bağlama akışı: panel butonu → kod modalı → plugin doğrular → bağlantı.
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
            .setLabel('Bağlantı Kodu')
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
    const code = interaction.fields.getTextInputValue('code');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Karar linkflow.js'te verilir (Discord'dan bağımsız, test edilebilir):
    // "kod geçersiz/süresi dolmuş" YALNIZCA plugin invalid_code/expired_code
    // dediğinde gösterilir; köprü/yapılandırma hataları kendi adıyla anılır.
    const decision = await verifyLinkCode({
      code, discordId: interaction.user.id, discordTag: interaction.user.tag,
    });

    if (decision.outcome === 'already_linked_self') {
      return interaction.editReply({
        embeds: [warnEmbed(
          `Discord hesabın zaten **${clean(decision.mc, 30)}** ile eşleşmiş durumda.\n`
          + 'Bağlantıyı değiştirmen gerekiyorsa `/destek aç` ile talep oluştur.',
          'Hesabın Zaten Bağlı',
        )],
      });
    }
    if (decision.outcome === 'failed') {
      const { kind, title, description } = decision.failure;
      return interaction.editReply({
        embeds: [kind === 'already_linked_other'
          ? warnEmbed(description, title)
          : errEmbed(description, title)],
      });
    }

    const { mc } = decision;
    addCase('link_create', interaction.user.id, interaction.user.id, null, mc);
    await sendLog(interaction.client, {
      title: 'Hesap Bağlandı',
      color: Colors.success,
      fields: [
        { name: 'Kullanıcı', value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: true },
        { name: 'Minecraft', value: `\`${codeText(mc, 30)}\``, inline: true },
      ],
    });
    // ELO tier rolünü hemen ver (best-effort; rol eşlemesi kuruluysa).
    if (interaction.guild && Object.keys(roleMap()).length) {
      try {
        const profile = await mcapi.statsPlayer(`name=${encodeURIComponent(mc)}`);
        if (profile.ok && profile.found && profile.tier) {
          await syncMemberTierRole(interaction.guild, interaction.user.id, profile.tier);
        }
      } catch { /* rol senkronu link akışını asla bozmaz */ }
    }
    return interaction.editReply({
      embeds: [okEmbed(
        `Minecraft hesabın **${clean(mc, 30)}** ile eşleştirildi.\n`
        + 'Artık Nautilus maçlarına katılabilir, profilini `/profil` ile görebilirsin.',
        '🔗 Hesap Bağlandı',
      )],
    });
  },

  /* ---------------- /maç canlı yenile butonu ---------------- */

  'mac:yenile': async (interaction) => {
    // Önce deferUpdate: buildLivePayload iki köprü isteği yapabilir (sunucu
    // yavaş/kapalıysa 8sn'e kadar) — 3sn'lik interaction token'ı dolmadan
    // mesajı sahiplen, sonra editReply ile tazele (tek acknowledge).
    await interaction.deferUpdate();
    return interaction.editReply(await buildLivePayload());
  },

  /* ---------------- /sicil sayfa gezinme ---------------- */

  'sicil': async (interaction) => {
    const [, userId, rawPage] = interaction.customId.split(':');
    const page = Number.parseInt(rawPage, 10) || 0;
    const { sicilPayload } = await import('./commands/stats.js');
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    return interaction.update(sicilPayload(userId, user?.tag ?? userId, page));
  },

  /* ---------------- /maç-bildirim onay akışı ---------------- */

  'bildirim:ac': (interaction) => handleBildirimToggle(interaction, true),
  'bildirim:kapat': (interaction) => handleBildirimToggle(interaction, false),
  'bildirim:vazgec': async (interaction) => {
    const d = confirmDecision(interaction.customId, interaction.user.id);
    if (d === 'not_owner') {
      return interaction.reply({ embeds: [notYours()], flags: MessageFlags.Ephemeral });
    }
    return interaction.update({
      embeds: [neutralEmbed('Bildirim ayarın olduğu gibi kaldı.', 'Değişiklik Yapılmadı')],
      components: [],
    });
  },

  /* ---------------- Destek talepleri (Faz 5: tickets.js) ---------------- */

  ...ticketComponents,

  /* ---------------- Çekiliş katılımı ---------------- */

  'gw:join': async (interaction) => {
    const id = Number.parseInt(interaction.customId.split(':')[2], 10);
    const gw = giveaways.get(id);
    if (!gw || gw.ended) {
      return interaction.reply({
        embeds: [neutralEmbed('Bu çekiliş sona erdi. Sonuçlar çekiliş mesajında görünüyor.', 'Çekiliş Kapandı')],
        flags: MessageFlags.Ephemeral,
      });
    }
    const joined = giveaways.enter(id, interaction.user.id);
    const count = giveaways.entries(id).length;
    return interaction.reply({
      embeds: [joined
        ? okEmbed(`Çekilişe katıldın. Şu anki katılımcı sayısı: **${count}**.`, '🎉 Katılım Alındı')
        : neutralEmbed(`Bu çekilişe zaten katıldın. Katılımcı sayısı: **${count}**.`, 'Zaten Katıldın')],
      flags: MessageFlags.Ephemeral,
    });
  },

  /* ---------------- Anket oylama ---------------- */

  'poll:vote': async (interaction) => {
    const [, , rawId, rawChoice] = interaction.customId.split(':');
    const id = Number.parseInt(rawId, 10);
    const choice = Number.parseInt(rawChoice, 10);
    const poll = polls.get(id);
    if (!poll || poll.ended || !poll.options[choice]) {
      return interaction.reply({
        embeds: [neutralEmbed('Bu anket sona erdi. Sonuçlar anket mesajında görünüyor.', 'Anket Kapandı')],
        flags: MessageFlags.Ephemeral,
      });
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
      embeds: [okEmbed(`Oyun **${clean(poll.options[choice], 60)}** seçeneğine kaydedildi.\n`
        + 'Fikrini değiştirirsen başka bir seçeneğe tıklaman yeterli.', '🗳️ Oyun Alındı')],
      flags: MessageFlags.Ephemeral,
    });
  },

  /* ---------------- Buton-rol paneli ---------------- */

  'role': async (interaction) => {
    const roleId = interaction.customId.split(':')[1];
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      return interaction.reply({
        embeds: [errEmbed('Bu rol artık sunucuda mevcut değil. Panelin güncellenmesi için bir yetkiliye haber ver.',
          'Rol Bulunamadı')],
        flags: MessageFlags.Ephemeral,
      });
    }
    const me = interaction.guild.members.me;
    const dangerous = role.permissions.any([
      PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ModerateMembers,
    ]);
    if (role.managed || dangerous || role.position >= me.roles.highest.position) {
      return interaction.reply({
        embeds: [errEmbed('Bu rol panel üzerinden dağıtılamıyor.', 'Rol Alınamaz')],
        flags: MessageFlags.Ephemeral,
      });
    }
    const member = interaction.member;
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(role, 'Rol paneli');
      return interaction.reply({
        embeds: [okEmbed(`${role} rolü üzerinden kaldırıldı. Butona tekrar tıklayarak geri alabilirsin.`, 'Rol Kaldırıldı')],
        flags: MessageFlags.Ephemeral,
      });
    }
    await member.roles.add(role, 'Rol paneli');
    return interaction.reply({
      embeds: [okEmbed(`${role} rolü hesabına eklendi. Butona tekrar tıklayarak bırakabilirsin.`, 'Rol Verildi')],
      flags: MessageFlags.Ephemeral,
    });
  },
};

/** Başkasının butonuna tıklandığında verilen tek tip yanıt. */
function notYours() {
  return errEmbed('Bu buton başka bir kullanıcı için oluşturuldu. Komutu kendin çalıştırabilirsin.',
    'Bu Buton Sana Ait Değil');
}

/**
 * /maç-bildirim onay butonu: yalnız komut sahibi, TTL içinde. Değişiklik
 * ancak bu açık onayla uygulanır; sonuç ephemeral güncellenir.
 */
async function handleBildirimToggle(interaction, enable) {
  const d = confirmDecision(interaction.customId, interaction.user.id);
  if (d === 'not_owner') {
    return interaction.reply({ embeds: [notYours()], flags: MessageFlags.Ephemeral });
  }
  if (d === 'expired') {
    return interaction.update({
      embeds: [warnEmbed('Onay penceresi kapandı, ayarın değişmedi.\n'
        + 'Değişiklik için `/maç-bildirim` komutunu tekrar çalıştır.', 'Onay Süresi Doldu')],
      components: [],
    });
  }
  dmSubscriptions.set(d.ownerId, enable);
  return interaction.update({
    embeds: [enable
      ? okEmbed('Bir sonraki normal maç başladığında duyurunun kopyası DM olarak sana gelecek.\n'
        + 'Test maçları bu bildirime dahil değildir.', '🔔 Bildirimler Açık')
      : neutralEmbed('Maç başlangıcında artık DM almayacaksın.\n'
        + 'İstediğin zaman `/maç-bildirim` ile geri açabilirsin.', '🔕 Bildirimler Kapalı')],
    components: [],
  });
}

/** Finds the handler whose key matches the interaction's customId prefix. */
export function resolveComponent(customId) {
  for (const [prefix, handler] of Object.entries(componentHandlers)) {
    if (customId === prefix || customId.startsWith(`${prefix}:`)) return handler;
  }
  return null;
}
