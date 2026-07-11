/**
 * Central configuration. Everything comes from environment variables so the bot
 * can be deployed on Coolify without touching code; the Nautilus PvP guild and
 * channel/role ids ship as defaults.
 */

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name) {
  const v = env(name);
  if (!v) {
    console.error(`[config] Eksik ortam değişkeni: ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  token: required('DISCORD_TOKEN'),

  /** The ONLY guild this bot will ever serve. It leaves everything else. */
  guildId: env('GUILD_ID', '1521979737201836233'),

  /** Match announcements (schedule / start / result / test) land here. */
  matchChannelId: env('MATCH_CHANNEL_ID', '1522216307809063154'),

  /** The account-link panel (button + modal) is posted here. */
  linkChannelId: env('LINK_CHANNEL_ID', '1522335045593858228'),

  /** Moderation & security log channel (can be overridden with /admin logkanal). */
  logChannelId: env('LOG_CHANNEL_ID', ''),

  roles: {
    kurucu: env('ROLE_KURUCU', '1522149038298894450'),
    admin: env('ROLE_ADMIN', '1522149134830800946'),
    bmod: env('ROLE_BMOD', '1522149269568622733'),
    mod: env('ROLE_MOD', '1522149408555139072'),
    rehber: env('ROLE_REHBER', '1522149952527138889'),
  },

  /** Base URL of the NautilusUHC plugin bridge API (Pelican Panel host), e.g. http://1.2.3.4:8571 */
  mcApiUrl: env('MC_API_URL', '').replace(/\/+$/, ''),

  /** Shared secret between the bot and the plugin (both directions). */
  bridgeSecret: env('BRIDGE_SECRET', ''),

  /** HTTP port the bot listens on for plugin events (Coolify exposes it). */
  port: Number.parseInt(env('PORT', '8080'), 10),

  dbPath: env('DB_PATH', 'data/bot.db'),

  timezone: 'Europe/Istanbul',
};
