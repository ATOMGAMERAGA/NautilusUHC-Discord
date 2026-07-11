import { EmbedBuilder } from 'discord.js';

/** Nautilus PvP palette. */
export const Colors = {
  main: 0x00b3b3,
  success: 0x2ecc71,
  warn: 0xf1c40f,
  danger: 0xe74c3c,
  info: 0x3498db,
  dark: 0x2c3e50,
};

export function baseEmbed(color = Colors.main) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: 'Nautilus PvP • nautilusuhc.com' })
    .setTimestamp();
}

export function okEmbed(description) {
  return baseEmbed(Colors.success).setDescription(description);
}

export function errEmbed(description) {
  return baseEmbed(Colors.danger).setDescription(description);
}
