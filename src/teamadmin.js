import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { mcapi } from './mcapi.js';
import { Tier, hasTier } from './permissions.js';
import { baseEmbed, errEmbed, Colors, bridgeErrorEmbed } from './embeds.js';
import { clean } from './util.js';

const sessions=new Map();
const TTL=15*60*1000;
const labels={create:'Takım oluştur',move:'Oyuncu taşı',remove:'Solo yap',disband:'Takımı dağıt',size:'Takım boyutu',randomize:'Rastgele dağıt',clear:'Tümünü temizle',refresh:'Yenile'};
export function teamPanel(state,token,page=0) {
 const last=Math.max(0,Math.ceil(state.teams.length/10)-1);page=Math.max(0,Math.min(page,last));
 const teams=state.teams.slice(page*10,page*10+10);
 const e=baseEmbed(Colors.brand).setTitle('Takım Yönetimi')
  .setDescription(`**${state.teams.length} takım** • ${state.teamSize>1?`To${state.teamSize}`:'Solo'} • ${state.active?'Maç sürüyor':'Maç öncesi'}\n`
   +`Sayfa ${page+1}/${last+1}\n\n`
   +teams.map(t=>`**Takım ${t.number}** (${t.members.length}/${state.teamSize})\n${t.members.slice(0,8).map(m=>`${m.alive?'🟢':'•'} ${clean(m.name,20)}${m.online?'':' (çevrimdışı)'}`).join(', ')}${t.members.length>8?` • +${t.members.length-8} oyuncu`:''}`).join('\n\n'));
 const solo=state.players.filter(p=>!p.team);
 if(solo.length)e.addFields({name:'Takımı olmayan oyuncular',value:clean(solo.slice(0,25).map(p=>p.name).join(', '),950)});
 const rows=[];
 for(const actions of [['create','move','remove','disband'],['size','randomize','clear','refresh']])rows.push(new ActionRowBuilder().addComponents(actions.map(action=>new ButtonBuilder()
  .setCustomId(`teamadmin:action:${token}:${action}`).setLabel(labels[action])
  .setStyle(['clear','disband'].includes(action)?ButtonStyle.Danger:ButtonStyle.Secondary))));
 if(last>0)rows.push(new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`teamadmin:page:${token}:${page-1}`).setLabel('Önceki').setDisabled(page===0).setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`teamadmin:page:${token}:${page+1}`).setLabel('Sonraki').setDisabled(page===last).setStyle(ButtonStyle.Secondary)));
 return {embeds:[e],components:rows,allowedMentions:{parse:[]}};
}
function newSession(interaction,state) {
 for(const [id,s] of sessions)if(s.expires<Date.now())sessions.delete(id);
 const token=randomUUID().slice(0,12);
 sessions.set(token,{owner:interaction.user.id,guild:interaction.guildId,state,expires:Date.now()+TTL,busy:false,page:0});return token;
}
export async function openTeamPanel(interaction) {
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 const state=await mcapi.teamAdmin();
 if(!state.ok)return interaction.editReply({embeds:[bridgeErrorEmbed(state,{context:'takım yönetimi'})]});
 return interaction.editReply(teamPanel(state,newSession(interaction,state)));
}
function authorized(interaction,session) {
 return session&&session.owner===interaction.user.id&&session.guild===interaction.guildId&&session.expires>Date.now()&&hasTier(interaction.member,Tier.ADMIN);
}
function modal(token,action) {
 const m=new ModalBuilder().setCustomId(`teamadmin:submit:${token}:${action}`).setTitle(labels[action]);
 const inputs=[];
 if(['create','move','remove'].includes(action))inputs.push(['player','Minecraft oyuncu adı veya UUID']);
 if(['move','disband'].includes(action))inputs.push(['team','Takım numarası']);
 if(action==='size')inputs.push(['size','Takım boyutu (1–100)']);
 for(const [id,label] of inputs)m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)));
 return m;
}
async function apply(interaction,session,body,token) {
 if(session.busy)return interaction.reply({content:'Önceki işlem sürüyor.',flags:MessageFlags.Ephemeral});
 session.busy=true;
 try {
  if(interaction.isModalSubmit())await interaction.deferReply({flags:MessageFlags.Ephemeral});else await interaction.deferUpdate();
  const result=await mcapi.teamAction({...body,revision:body.revision??session.state.revision,actor:`discord:${interaction.user.id}`});
  session.pending=null;
  if(!result.ok)return interaction.editReply({embeds:[result.message?errEmbed(clean(result.message,500),'İşlem Uygulanamadı'):bridgeErrorEmbed(result)],components:[]});
  session.state=result;session.expires=Date.now()+TTL;
  return interaction.editReply(teamPanel(result,token,session.page));
 }finally{session.busy=false;}
}
export async function handleTeamAdmin(interaction) {
 const [,kind,token,arg]=interaction.customId.split(':');const session=sessions.get(token);
 if(!authorized(interaction,session))return interaction.reply({content:'Panelin süresi doldu veya bu panel sana ait değil. `/teamadmin` ile yeniden aç.',flags:MessageFlags.Ephemeral});
 if(kind==='confirm') {
  if(!session.pending)return interaction.reply({content:'Bu işlem zaten tamamlandı veya iptal edildi.',flags:MessageFlags.Ephemeral});
  return apply(interaction,session,session.pending,token);
 }
 if(kind==='cancel'){session.pending=null;return interaction.update(teamPanel(session.state,token,session.page));}
 if(kind==='page'){session.page=Number(arg)||0;return interaction.update(teamPanel(session.state,token,session.page));}
 if(kind==='action') {
  if(!Object.hasOwn(labels,arg))return;
  if(arg==='refresh') {
   await interaction.deferUpdate();const state=await mcapi.teamAdmin();
   if(!state.ok)return interaction.editReply({embeds:[bridgeErrorEmbed(state)],components:[]});session.state=state;session.expires=Date.now()+TTL;
   return interaction.editReply(teamPanel(state,token,session.page));
  }
  if(['randomize','clear'].includes(arg)){session.pending={action:arg,revision:session.state.revision};return confirm(interaction,token,arg);}
  return interaction.showModal(modal(newSession(interaction,session.state),arg));
 }
 if(kind==='submit') {
  const body={action:arg,revision:session.state.revision};
  if(['create','move','remove'].includes(arg)) {
   const input=interaction.fields.getTextInputValue('player').trim();
   const matches=session.state.players.filter(p=>p.uuid===input||p.name.toLowerCase()===input.toLowerCase());
   if(matches.length!==1)return interaction.reply({embeds:[errEmbed('Oyuncu bulunamadı. Paneli yenile veya listedeki UUID/adı kullan.')],flags:MessageFlags.Ephemeral});body.player=matches[0].uuid;
  }
  for(const key of arg==='size'?['size']:['move','disband'].includes(arg)?['team']:[]) {
   const input=interaction.fields.getTextInputValue(key).trim();if(!/^\d{1,3}$/.test(input))return interaction.reply({content:'Pozitif bir sayı gir.',flags:MessageFlags.Ephemeral});body[key]=Number(input);
  }
  if(arg==='disband'){session.pending=body;return confirm(interaction,token,arg);}
  return apply(interaction,session,body,token);
 }
}
function confirm(interaction,token,action) {
 const payload={embeds:[baseEmbed(Colors.warn).setTitle(labels[action]).setDescription('Bu işlem takım atamalarını değiştirecek. Onaylıyor musun?')],
  components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`teamadmin:confirm:${token}`).setLabel('Onayla').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`teamadmin:cancel:${token}`).setLabel('Vazgeç').setStyle(ButtonStyle.Secondary))],allowedMentions:{parse:[]}};
 if(interaction.isModalSubmit())return interaction.reply({...payload,flags:MessageFlags.Ephemeral});return interaction.update(payload);
}
