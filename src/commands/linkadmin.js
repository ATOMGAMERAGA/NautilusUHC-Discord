import {
  linkAdmin, actorFromInteraction, parseTarget, instanceChoices, EPHEMERAL, VIEW_TIER, UNLINK_TIER,
} from '../linkadmin.js';
import { errEmbed } from '../embeds.js';

/**
 * Hesap bağlantısı yönetim komutları (ephemeral):
 *   /linkler [sayfa] [sunucu]
 *   /linkbilgi oyuncu|kullanıcı|discord-id|uuid [sunucu]
 *   /unlink    oyuncu|kullanıcı|discord-id|uuid [neden] [sunucu]
 *   /linkgecmisi [oyuncu|kullanıcı|discord-id|uuid] [sunucu]
 *
 * Komut verisi ham Discord API JSON'udur (discord.js gerektirmez, testte yüklenir).
 * Yetki index.js'te komut girişinde, ayrıca linkadmin servisinde yeniden denetlenir.
 */

const MODERATE_MEMBERS = String(1n << 40n);
const ADMINISTRATOR = String(1n << 3n);

function slash(json) {
  return { name: json.name, toJSON: () => json };
}

const serverOption = {
  type: 3,
  name: 'sunucu',
  description: 'Birden fazla Minecraft sunucusu bağlıysa hedef sunucu (instance)',
  required: false,
  autocomplete: true,
  max_length: 64,
};

const targetOptions = [
  {
    type: 3, name: 'oyuncu', description: 'Minecraft oyuncu adı (birebir, çevrimdışı dahil)', required: false, max_length: 32,
  },
  {
    type: 6, name: 'kullanıcı', description: 'Discord kullanıcısı', required: false,
  },
  {
    type: 3, name: 'discord-id', description: 'Discord kullanıcı ID\'si (sunucudan ayrılmış olsa da)', required: false, max_length: 20,
  },
  {
    type: 3, name: 'uuid', description: 'Minecraft UUID', required: false, min_length: 32, max_length: 36,
  },
];

function targetFrom(interaction, required) {
  return parseTarget({
    name: interaction.options.getString('oyuncu'),
    discordUserId: interaction.options.getUser('kullanıcı')?.id ?? null,
    discordId: interaction.options.getString('discord-id'),
    uuid: interaction.options.getString('uuid'),
  }, { required });
}

async function autocomplete(interaction) {
  const focused = String(interaction.options.getFocused?.() ?? '').toLowerCase();
  const choices = instanceChoices().filter((choice) => choice.value.toLowerCase().includes(focused)).slice(0, 25);
  return interaction.respond(choices);
}

export default [
  {
    tier: VIEW_TIER,
    data: slash({
      name: 'linkler',
      description: 'Aktif Minecraft–Discord hesap bağlantılarını listeler (en son eşleşen önce)',
      default_member_permissions: MODERATE_MEMBERS,
      dm_permission: false,
      options: [
        {
          type: 4, name: 'sayfa', description: 'Sayfa numarası', required: false, min_value: 1,
        },
        serverOption,
      ],
    }),
    autocomplete,
    async execute(interaction) {
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await linkAdmin.listPayload({
        actor: actorFromInteraction(interaction),
        page: interaction.options.getInteger('sayfa') ?? 1,
        instance: interaction.options.getString('sunucu'),
      }));
    },
  },
  {
    tier: VIEW_TIER,
    data: slash({
      name: 'linkbilgi',
      description: 'Bir oyuncunun ya da Discord hesabının bağlantısını gösterir',
      default_member_permissions: MODERATE_MEMBERS,
      dm_permission: false,
      options: [...targetOptions, serverOption],
    }),
    autocomplete,
    async execute(interaction) {
      const target = targetFrom(interaction, true);
      if (!target.ok) {
        return interaction.reply({ embeds: [errEmbed(target.message, 'Hedef Gerekli')], flags: EPHEMERAL });
      }
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await linkAdmin.infoPayload({
        actor: actorFromInteraction(interaction),
        selector: target.selector,
        value: target.value,
        instance: interaction.options.getString('sunucu'),
      }));
    },
  },
  {
    tier: UNLINK_TIER,
    data: slash({
      name: 'unlink',
      description: 'Bir Minecraft–Discord bağlantısını onayla iki taraftan kaldırır',
      default_member_permissions: ADMINISTRATOR,
      dm_permission: false,
      options: [
        ...targetOptions,
        {
          type: 3, name: 'neden', description: 'İsteğe bağlı neden (denetim geçmişine yazılır)', required: false, max_length: 500,
        },
        serverOption,
      ],
    }),
    autocomplete,
    async execute(interaction) {
      const target = targetFrom(interaction, true);
      if (!target.ok) {
        return interaction.reply({ embeds: [errEmbed(target.message, 'Hedef Gerekli')], flags: EPHEMERAL });
      }
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await linkAdmin.prepareUnlink({
        actor: actorFromInteraction(interaction),
        selector: target.selector,
        value: target.value,
        reason: interaction.options.getString('neden'),
        instance: interaction.options.getString('sunucu'),
      }));
    },
  },
  {
    tier: VIEW_TIER,
    data: slash({
      name: 'linkgecmisi',
      description: 'Son link/unlink işlemlerini gösterir; oyuncu ya da Discord hesabına göre filtrelenebilir',
      default_member_permissions: MODERATE_MEMBERS,
      dm_permission: false,
      options: [...targetOptions, serverOption],
    }),
    autocomplete,
    async execute(interaction) {
      const target = targetFrom(interaction, false);
      if (!target.ok) {
        return interaction.reply({ embeds: [errEmbed(target.message, 'Hedef Geçersiz')], flags: EPHEMERAL });
      }
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await linkAdmin.historyPayload({
        actor: actorFromInteraction(interaction),
        selector: target.selector,
        value: target.value,
        instance: interaction.options.getString('sunucu'),
      }));
    },
  },
];
