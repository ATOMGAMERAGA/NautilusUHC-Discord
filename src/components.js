import {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionFlagsBits,
} from 'discord.js';
import {
  okEmbed, errEmbed, warnEmbed, neutralEmbed, bridgeErrorEmbed, Colors,
} from './embeds.js';
import { mcapi } from './mcapi.js';
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
    const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
    await interaction.deferReply({ ephemeral: true });

    const status = await mcapi.linkStatus(`discord=${interaction.user.id}`);
    if (status.ok && status.linked) {
      return interaction.editReply({
        embeds: [warnEmbed(
          `Discord hesabın zaten **${clean(status.mc, 30)}** ile eşleşmiş durumda.\n`
          + 'Bağlantıyı değiştirmen gerekiyorsa `/destek aç` ile talep oluştur.',
          'Hesabın Zaten Bağlı',
        )],
      });
    }

    const res = await mcapi.linkVerify(code, interaction.user.id, interaction.user.tag);
    if (!res.ok) {
      // Kodun geçersiz olması normal bir kullanıcı hatasıdır: ne olduğunu ve
      // nasıl düzelteceğini söyleriz. Diğer her şey sınıflandırılmış köprü
      // hatasına düşer — ham backend metni kullanıcıya gösterilmez.
      const badCode = res.status === 404 || res.status === 400
        || /invalid|expired|geçersiz|süresi/i.test(res.error ?? '');
      return interaction.editReply({
        embeds: [badCode
          ? errEmbed('Girdiğin kod geçersiz veya süresi dolmuş.\n'
            + 'Minecraft sunucusunda `/link` yazarak yeni bir kod al ve tekrar dene.',
          'Kod Doğrulanamadı')
          : bridgeErrorEmbed(res, { context: 'hesap bağlama' })],
      });
    }

    addCase('link_create', interaction.user.id, interaction.user.id, null, res.mc);
    await sendLog(interaction.client, {
      title: 'Hesap Bağlandı',
      color: Colors.success,
      fields: [
        { name: 'Kullanıcı', value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: true },
        { name: 'Minecraft', value: `\`${codeText(res.mc, 30)}\``, inline: true },
      ],
    });
    // ELO tier rolünü hemen ver (best-effort; rol eşlemesi kuruluysa).
    if (interaction.guild && Object.keys(roleMap()).length) {
      try {
        const profile = await mcapi.statsPlayer(`name=${encodeURIComponent(res.mc)}`);
        if (profile.ok && profile.found && profile.tier) {
          await syncMemberTierRole(interaction.guild, interaction.user.id, profile.tier);
        }
      } catch { /* rol senkronu link akışını asla bozmaz */ }
    }
    return interaction.editReply({
      embeds: [okEmbed(
        `Minecraft hesabın **${clean(res.mc, 30)}** ile eşleştirildi.\n`
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
      return interaction.reply({ embeds: [notYours()], ephemeral: true });
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
        ephemeral: true,
      });
    }
    const joined = giveaways.enter(id, interaction.user.id);
    const count = giveaways.entries(id).length;
    return interaction.reply({
      embeds: [joined
        ? okEmbed(`Çekilişe katıldın. Şu anki katılımcı sayısı: **${count}**.`, '🎉 Katılım Alındı')
        : neutralEmbed(`Bu çekilişe zaten katıldın. Katılımcı sayısı: **${count}**.`, 'Zaten Katıldın')],
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
      return interaction.reply({
        embeds: [neutralEmbed('Bu anket sona erdi. Sonuçlar anket mesajında görünüyor.', 'Anket Kapandı')],
        ephemeral: true,
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
      ephemeral: true,
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
        ephemeral: true,
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
        ephemeral: true,
      });
    }
    const member = interaction.member;
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(role, 'Rol paneli');
      return interaction.reply({
        embeds: [okEmbed(`${role} rolü üzerinden kaldırıldı. Butona tekrar tıklayarak geri alabilirsin.`, 'Rol Kaldırıldı')],
        ephemeral: true,
      });
    }
    await member.roles.add(role, 'Rol paneli');
    return interaction.reply({
      embeds: [okEmbed(`${role} rolü hesabına eklendi. Butona tekrar tıklayarak bırakabilirsin.`, 'Rol Verildi')],
      ephemeral: true,
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
    return interaction.reply({ embeds: [notYours()], ephemeral: true });
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
