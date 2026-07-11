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

const allCommands = [
  ...moderation, ...mc, ...mac, ...link, ...admin, ...utility, ...stats, ...fun, ...destek,
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
  // Presence bazen düşer; periyodik tazele.
  setInterval(() => {
    client.user.setPresence({
      activities: [{ name: 'nautilusuhc.com', type: ActivityType.Playing }],
      status: 'online',
    });
  }, 30 * 60_000).unref();

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

  startHttpServer(client);
  startScheduler(client);
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

    if (interaction.isButton() || interaction.isModalSubmit()) {
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
registerWelcome(client);

process.on('unhandledRejection', (err) => console.error('[bot] unhandledRejection:', err));

client.login(config.token);
