import {
  Client, GatewayIntentBits, Partials, ActivityType, Events, MessageFlags,
} from 'discord.js';
import { config } from './config.js';
import { hasTier, tierName } from './permissions.js';
import { errEmbed } from './embeds.js';
import { resolveComponent } from './components.js';
import { registerGuard } from './security/guard.js';
import { registerAutomod } from './security/automod.js';
import { registerMessageLog } from './security/msglog.js';
import { registerRaidProtection } from './security/raid.js';
import { registerWelcome } from './welcome.js';
import { startHttpServer } from './httpserver.js';
import { startScheduler } from './scheduler.js';

import moderation from './commands/moderation.js';
import mc from './commands/mc.js';
import mac from './commands/mac.js';
import link from './commands/link.js';
import admin from './commands/admin.js';
import utility from './commands/utility.js';
import stats from './commands/stats.js';
import fun from './commands/fun.js';
import destek from './commands/destek.js';
import bildirim from './commands/bildirim.js';
import saglik from './commands/saglik.js';
import { dispatchMatchDms } from './matchdm.js';
import { handleTierChangeEvent } from './rolesync.js';
import { startStatusBoard } from './statusboard.js';
import { registerTicketMessages, startTicketWatcher } from './tickets.js';

const allCommands = [
  ...moderation, ...mc, ...mac, ...link, ...admin, ...utility, ...stats, ...fun, ...destek,
  ...bildirim, ...saglik,
];
const commandMap = new Map(allCommands.map((c) => [c.data.name, c]));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

/* ------------------------------------------------------------------ */
/* Guild lock: this bot serves exactly one server.                     */
/* ------------------------------------------------------------------ */

async function enforceGuildLock() {
  for (const guild of client.guilds.cache.values()) {
    if (guild.id !== config.guildId) {
      console.warn(`[kilit] İzinsiz sunucudan çıkılıyor: ${guild.name} (${guild.id})`);
      await guild.leave().catch(() => null);
    }
  }
}

client.on(Events.GuildCreate, async (guild) => {
  if (guild.id !== config.guildId) {
    console.warn(`[kilit] İzinsiz sunucuya eklenme engellendi: ${guild.name} (${guild.id})`);
    await guild.leave().catch(() => null);
    return;
  }
  // Bot hedef sunucuya SONRADAN eklendi (süreç zaten ayaktaydı): slash
  // komutlarını restart beklemeden hemen kaydet. (Açılışta sunucuda değilse
  // ClientReady kaydı atlanıyordu; bu handler o boşluğu kapatır.)
  try {
    await guild.commands.set(allCommands.map((c) => c.data.toJSON()));
    console.log(`[bot] ${allCommands.length} slash komutu kaydedildi (sonradan eklenme).`);
  } catch (err) {
    console.error('[bot] Komut kaydı başarısız:', err);
  }
});

/* ------------------------------------------------------------------ */
/* Ready: presence, command registration, guild lock                   */
/* ------------------------------------------------------------------ */

client.once(Events.ClientReady, async () => {
  console.log(`[bot] Giriş yapıldı: ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'nautilusuhc.com', type: ActivityType.Playing }],
    status: 'online',
  });
  // Canlı presence + durum panosu artık statusboard.js'in 60 sn tick'inde:
  // maç varsa "⚔️ alive/participants — faz", yoksa oyuncu sayısı; 30 dk'da
  // bir zorla tazelenir (presence düşmesine karşı).

  await enforceGuildLock();

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    console.error(`[bot] Bot hedef sunucuda değil (${config.guildId}). Davet linkiyle ekleyin.`);
    return;
  }
  try {
    await guild.commands.set(allCommands.map((c) => c.data.toJSON()));
    console.log(`[bot] ${allCommands.length} slash komutu kaydedildi.`);
  } catch (err) {
    console.error('[bot] Komut kaydı başarısız:', err);
  }

  // Event hook'ları: DM dağıtımı (match_start) + ELO tier rol senkronu
  // (tier_change). Hook'lar kanal yönlendirmesinden bağımsız her event'te
  // koşar; biri hata verse diğeri etkilenmez.
  startHttpServer(client, {
    onEvent: async (envelope) => {
      try { await dispatchMatchDms(client, envelope); } catch (err) {
        console.error('[bot] DM dağıtım hatası:', err.message);
      }
      try { await handleTierChangeEvent(client, envelope); } catch (err) {
        console.error('[bot] rol senkron hatası:', err.message);
      }
    },
  });
  startScheduler(client);
  // Durum panosu + canlı presence (60 sn tick).
  startStatusBoard(client);
  // Destek sistemi: kanalı silinmiş talepleri kapat + SLA/hareketsizlik gözcüsü.
  startTicketWatcher(client);
});

/* ------------------------------------------------------------------ */
/* Interactions                                                        */
/* ------------------------------------------------------------------ */

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.guild && interaction.guild.id !== config.guildId) return;

    if (interaction.isChatInputCommand()) {
      const command = commandMap.get(interaction.commandName);
      if (!command) return;
      if (!interaction.inGuild()) {
        return interaction.reply({ content: 'Komutlar yalnızca sunucu içinde kullanılabilir.', flags: MessageFlags.Ephemeral });
      }
      if (!hasTier(interaction.member, command.tier)) {
        return interaction.reply({
          embeds: [errEmbed(`Bu komut için en az **${tierName(command.tier)}** yetkisi gerekir.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isAnySelectMenu()) {
      const handler = resolveComponent(interaction.customId);
      if (handler) await handler(interaction);
    }
  } catch (err) {
    console.error(`[bot] Etkileşim hatası (${interaction.commandName ?? interaction.customId}):`, err);
    const payload = { embeds: [errEmbed('Bir hata oluştu. Lütfen tekrar dene.')], flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => null);
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Security modules                                                    */
/* ------------------------------------------------------------------ */

registerGuard(client);
registerAutomod(client);
registerMessageLog(client);
registerRaidProtection(client);
registerWelcome(client);
registerTicketMessages(client); // destek kanallarındaki her mesaj tam transcript'e yazılır

process.on('unhandledRejection', (err) => console.error('[bot] unhandledRejection:', err));

client.login(config.token);
