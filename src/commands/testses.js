import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Tier } from '../permissions.js';

export default [{
  tier: Tier.ADMIN,
  data: new SlashCommandBuilder().setName('testses')
    .setDescription('Takım Geçiş → Takım 1 → Solo → İzleyici ses yönlendirmesini test eder')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const manager=interaction.client.uhcVoiceManager;
    if(!manager)return interaction.editReply({content:'Ses sistemi henüz hazır değil. Biraz sonra tekrar dene.'});
    const member=await interaction.guild.members.fetch(interaction.user.id);
    const result=await manager.runTest(member,{onReady:entry=>interaction.editReply({
      content:`Ses testi hazır. <#${entry}> kanalına gir; seste bulunuyorsan seni bot taşıyacak.\nİki saniye arayla **Takım 1 → Solo → İzleyici**. Test sonunda geçici kanallar temizlenir.`,
      allowedMentions:{parse:[]},
    })});
    await interaction.editReply({content:result.message,allowedMentions:{parse:[]}});
  },
}];
