import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Tier } from '../permissions.js';
import { openTeamPanel } from '../teamadmin.js';
export default [{tier:Tier.ADMIN,data:new SlashCommandBuilder().setName('teamadmin')
 .setDescription('Takımları ve oyuncu atamalarını yönetir').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),execute:openTeamPanel}];
