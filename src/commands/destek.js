import { SlashCommandBuilder } from 'discord.js';
import { Tier } from '../permissions.js';
import { openTicket, closeTicket } from '../tickets.js';

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('destek')
      .setDescription('Destek talebi işlemleri')
      .addSubcommand((s) => s.setName('aç').setDescription('Yeni bir destek talebi açar'))
      .addSubcommand((s) => s.setName('kapat').setDescription('Bulunduğun destek talebini kapatır')),
    async execute(interaction) {
      if (interaction.options.getSubcommand() === 'aç') {
        return openTicket(interaction);
      }
      return closeTicket(interaction);
    },
  },
];
