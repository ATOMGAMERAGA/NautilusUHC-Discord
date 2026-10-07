import { ChannelType, Events, PermissionFlagsBits as P } from 'discord.js';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { mcapi } from './mcapi.js';
import { destination, channelSpecs } from './voicecore.js';

export const VOICE_CATEGORY = '1522215362857406654';
const REGISTRY_KEY = 'uhc_voice_registry_v1';
export function createVoiceManager({client, api=mcapi, read=()=>getSetting(REGISTRY_KEY,''),
  write=value=>setSetting(REGISTRY_KEY,value), guildId=config.guildId, logger=console}={}) {
  let registry;
  try {registry=JSON.parse(read() || '{}');} catch {registry={};}
  registry.channels ??= {};
  registry.linked ??= [];
  registry.permissions = {}; // Reapply the owned permission policy after every bot restart.
  let snapshot=null, busy=null, timer=null;
  const save=()=>write(JSON.stringify(registry));
  const ownedIds=()=>new Set(Object.values(registry.channels));
  const guild=()=>client.guilds.cache.get(guildId);

  async function move(member, id) {
    if (!member?.voice?.channelId || member.voice.channelId === id) return;
    await member.voice.setChannel(id, 'UHC oyun durumuna göre ses yönlendirmesi');
  }
  async function route(member) {
    if (!snapshot || !member?.voice?.channelId) return;
    const link=snapshot.links.find(l=>l.discordId===member.id);
    if (!link) {
      if (ownedIds().has(member.voice.channelId)) await move(member,null);
      return;
    }
    const key=destination(snapshot,link);
    const id=registry.channels[key ?? 'entry'];
    if (id && ownedIds().has(member.voice.channelId)) await move(member,id);
  }
  async function cleanup(g) {
    // A failed deletion remains registered for retry; unrelated channels are never touched.
    for (const [key,id] of Object.entries(registry.channels)) {
      const c=g.channels.cache.get(id);
      if(c) {
        for(const member of c.members?.values?.() ?? []) await move(member,null);
        await c.delete('UHC: aktif veya planlanmış maç kalmadı');
      }
      delete registry.channels[key]; save();
    }
    snapshot=null; registry.matchKey=null; save();
  }
  async function reconcile(state) {
    const g=guild(); if(!g) return;
    await g.channels.fetch();
    if (!state.enabled) { await cleanup(g); return; }
    const category=g.channels.cache.get(VOICE_CATEGORY);
    if (!category || category.type!==ChannelType.GuildCategory) throw new Error('UHC ses kategorisi bulunamadı');
    const specs=channelSpecs(state);
    const unmanaged=[...g.channels.cache.values()].filter(c=>c.parentId===VOICE_CATEGORY&&!ownedIds().has(c.id)).length;
    if(unmanaged+specs.length>50) throw new Error('UHC ses kategorisinin 50 kanal sınırı aşılıyor');
    let role=g.roles.cache.get(registry.roleId);
    if(!role) {
      role=await g.roles.create({name:'UHC • Hesabı Bağlı',permissions:[],reason:'UHC ses giriş yetkisi'});
      registry.roleId=role.id; save();
    }
    const linked=new Set(state.links.map(l=>l.discordId));
    const known=new Set([...registry.linked,...linked]);
    // Fetch only known linked users, not the entire guild on every five-second poll.
    for(const id of known) {
      let m=g.members.cache.get(id);
      if(!m) m=await g.members.fetch(id).catch(e=>{if(e.code===10007)return null;throw e;});
      if(!m) continue;
      if(linked.has(id)&&!m.roles.cache.has(role.id)) await m.roles.add(role,'Minecraft hesabı bağlı');
      if(!linked.has(id)&&m.roles.cache.has(role.id)) await m.roles.remove(role,'Minecraft hesabı bağlantısı kaldırıldı');
    }
    registry.linked=[...linked]; save();
    for(const [position,spec] of specs.entries()) {
      const overwrites=[{id:g.id,allow:[P.ViewChannel],deny:[P.Connect]},
        {id:role.id,deny:[P.Connect]},
        {id:client.user.id,allow:[P.ViewChannel,P.Connect,P.MoveMembers,P.ManageChannels]}];
      const ri=overwrites.findIndex(o=>o.id===role.id);
      overwrites[ri]= spec.key==='entry'
        ? {id:role.id,allow:[P.ViewChannel,P.Connect]}
        : {id:role.id,allow:[P.ViewChannel],deny:[P.Connect]};
      let c=g.channels.cache.get(registry.channels[spec.key]);
      if(!c) {
        c=await g.channels.create({name:spec.name,type:ChannelType.GuildVoice,parent:VOICE_CATEGORY,
          permissionOverwrites:overwrites,reason:'UHC maç ses kanalı'});
        registry.channels[spec.key]=c.id; save();
      }
      if(c.parentId!==VOICE_CATEGORY) await c.setParent(VOICE_CATEGORY,{lockPermissions:false});
      if(c.name!==spec.name) await c.setName(spec.name);
      // Avoid writing unchanged permissions on every poll.
      const signature=JSON.stringify(overwrites,(_,v)=>typeof v==='bigint'?v.toString():v);
      registry.permissions ??= {};
      if(registry.permissions[c.id]!==signature) {
        await c.permissionOverwrites.set(overwrites);
        registry.permissions[c.id]=signature;
      }
    }
    const order=specs.map((s,index)=>({channel:registry.channels[s.key],position:index}));
    const orderKey=JSON.stringify(order);
    if(registry.order!==orderKey) {await g.channels.setPositions(order);registry.order=orderKey;}
    const starting=state.active && registry.matchKey!==state.matchKey;
    snapshot=state;
    // Only take players from arbitrary voice channels once at match start.
    for(const link of state.links) {
      const m=g.members.cache.get(link.discordId);
      if(!m?.voice?.channelId) continue;
      const target=destination(state,link);
      if(starting&&target) await move(m,registry.channels[target]);
      else await route(m);
    }
    for(const vs of g.voiceStates.cache.values()) {
      if(ownedIds().has(vs.channelId)&&!linked.has(vs.id)) await move(vs.member,null);
    }
    registry.matchKey=state.active?state.matchKey:null;save();
    // Retired team voices are removed after occupants have been rerouted.
    const keep=new Set(specs.map(s=>s.key));
    for(const [key,id] of Object.entries(registry.channels)) {
      if(keep.has(key)) continue;
      const c=g.channels.cache.get(id);
      if(c) {for(const m of c.members?.values?.()??[]) await route(m);await c.delete('UHC takım kadrosu değişti');}
      delete registry.channels[key];delete registry.permissions[id];save();
    }
  }
  async function tick() {
    if(busy) return busy;
    busy=(async()=>{
      const res=await api.voiceSnapshot();
      if(!res.ok) {snapshot=null;return;} // Outages must not delete channels or route using stale state.
      if(!Array.isArray(res.links)||!Array.isArray(res.teams)||typeof res.enabled!=='boolean'||typeof res.active!=='boolean'||(res.active&&typeof res.matchKey!=='string')) {
        snapshot=null;throw new Error('UHC ses köprüsü geçersiz yanıt verdi');
      }
      await reconcile(res);
    })().catch(err=>{snapshot=null;logger.error('[ses]',err.message);}).finally(()=>{busy=null;});
    return busy;
  }
  async function voiceChanged(oldState,newState) {
    if(newState.guild.id!==guildId||oldState.channelId===newState.channelId||!ownedIds().has(newState.channelId))return;
    await tick(); await route(newState.member);
  }
  function start() {
    client.on(Events.VoiceStateUpdate,(a,b)=>voiceChanged(a,b).catch(e=>logger.error('[ses]',e.message)));
    client.on(Events.GuildMemberAdd,()=>tick());
    tick(); timer=setInterval(tick,5000);timer.unref();
  }
  return {tick,start,stop:()=>clearInterval(timer),voiceChanged};
}
