import { setTimeout as sleepFor } from 'node:timers/promises';
import { ChannelType, Events, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { mcapi } from './mcapi.js';
import { destination, channelSpecs, selectVoiceLink, isValidVoiceSnapshot } from './voicecore.js';

import { createEntryGuard } from './voiceentry.js';
import { createEntryPermissionManager } from './voiceentrypermissions.js';

export const GLOBAL_VOICE='1522216892658614272';
export const VOICE_CATEGORY = '1522215362857406654';
const REGISTRY_KEY = 'uhc_voice_registry_v1';
export function createVoiceManager({client, api=mcapi, read=()=>getSetting(REGISTRY_KEY,''),
  write=value=>setSetting(REGISTRY_KEY,value), guildId=config.guildId, logger=console, sleep=sleepFor, now=Date.now,
  readGuard=()=>getSetting('uhc_voice_entry_guard_v1',''),writeGuard=v=>setSetting('uhc_voice_entry_guard_v1',v)}={}) {
  let registry;
  try {registry=JSON.parse(read() || '{}');} catch {registry={};}
  registry.channels ??= {};
  registry.linked ??= [];
  registry.permissions = {}; // Reapply the owned permission policy after every bot restart.
  let snapshot=null, busy=null, timer=null, expiryTimer=null, testSession=null;
  const guard=createEntryGuard({now,read:readGuard,write:writeGuard});
  const entryPermissions=createEntryPermissionManager(guard,{now,restoreConnect:(id,connect)=>(registry.revoked??[]).includes(id)?-1:connect,onError:(err,block)=>report('entry-permission',err,{memberId:block.id,channelId:block.permission?.channelId})});
  let discovered=false;
  const retries=new Map(),moveQueues=new Map(),missingMembers=new Map();
  const localError=code=>Object.assign(new Error(code),{code});
  function report(operation,err,context={}) {
    logger.error('[ses]',{operation,guildId,matchKey:snapshot?.matchKey??registry.matchKey??null,...context,
      code:Number.isSafeInteger(Number(err?.code))?Number(err.code):(typeof err?.code==='string'&&/^voice_[a-z_]+$/.test(err.code)?err.code:null),...err?.voiceContext,status:Number.isSafeInteger(err?.status)?err.status:null});
  }
  async function attempt(key,operation,context,fn) {
    const prior=retries.get(key);if(prior?.until>now())return false;
    try {const result=await fn();if(result===false)return false;retries.delete(key);return true;}
    catch(err) {
      const failures=(prior?.failures??0)+1;
      const retryAfter=Number(err?.rawError?.retry_after??err?.retry_after??0)*1000;
      const delay=Math.max(err?.status===403?30000:5000,Number.isFinite(retryAfter)?retryAfter:0,Math.min(60000,5000*2**Math.min(failures-1,4)));
      retries.set(key,{failures,until:now()+delay});report(operation,err,context);return false;
    }
  }
  async function critical(operation,context,fn) {
    try{return await fn();}catch(err){const failure=err instanceof Error?err:localError('voice_discord_operation_failed');failure.voiceContext={operation,...context};throw failure;}
  }
  async function channel(g,id) {
    if(!id)return null;const cached=g.channels.cache.get(id);if(cached)return cached;
    try {return await g.channels.fetch(id);}catch(err){if(err.code===10003)return null;throw err;}
  }
  function permissionKey(rows) {
    return JSON.stringify([...rows].map(o=>({id:o.id,type:o.type??(o.id===guild()?.id||o.id===registry.roleId?0:1),
      allow:PermissionsBitField.resolve(o.allow??[]).toString(),deny:PermissionsBitField.resolve(o.deny??[]).toString()})).sort((a,b)=>a.id.localeCompare(b.id)));
  }
  const botMoves=new Map();
  const save=()=>write(JSON.stringify(registry));
  const ownedIds=()=>new Set(Object.values(registry.channels));
  const guild=()=>client.guilds.cache.get(guildId);
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const deadlines=guard.blocks().map(b=>Math.max(b.until,entryPermissions.retryAt(b.id)));if(!deadlines.length)return;
    expiryTimer=setTimeout(()=>tick(),Math.max(100,Math.min(...deadlines)-now()));expiryTimer.unref();
  }

  async function move(member,id,valid=()=>true) {
    if(!member)return false;
    const previous=moveQueues.get(member.id)??Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      if(!valid())return false;
      if(member.voice?.channelId===id)return true;
      if(!member.voice?.channelId)return false;
      return attempt(`move:${member.id}:${id}`,'move',{memberId:member.id,channelId:id},async()=>{
        if(!valid())return false;
        const movement={from:member.voice.channelId,to:id,until:now()+30000};
        const moves=(botMoves.get(member.id)??[]).filter(m=>m.until>now());moves.push(movement);botMoves.set(member.id,moves);
        try {
          await member.voice.setChannel(id,'UHC oyun durumuna göre ses yönlendirmesi');
          for(let tries=0;member.voice?.channelId!==id&&tries<10;tries++)await sleep(100);
          if(member.voice?.channelId!==id)throw localError('voice_move_unconfirmed');
          return true;
        } catch(err) {botMoves.set(member.id,moves.filter(m=>m!==movement));throw err;}
      });
    });
    moveQueues.set(member.id,work);
    try{return await work;}finally{if(moveQueues.get(member.id)===work)moveQueues.delete(member.id);}
  }
  function consumeBotMove(id,from,to) {
    const moves=(botMoves.get(id)??[]).filter(m=>m.until>now());
    const i=moves.findIndex(m=>m.from===from&&m.to===to);if(i>=0)moves.splice(i,1);
    if(moves.length)botMoves.set(id,moves);else botMoves.delete(id);return i>=0;
  }
  const globalId=()=>guild()?.channels.cache.get(GLOBAL_VOICE)?.type===ChannelType.GuildVoice?GLOBAL_VOICE:null;
  async function route(member) {
    if(member?.voice?.channelId&&ownedIds().has(member.voice.channelId)&&guard.blocked(member.id)){await move(member,globalId());return;}
    if (!snapshot || !member?.voice?.channelId || (testSession?.id===member.id&&!testSession.cancel)) return;
    const link=selectVoiceLink(snapshot.links,member.id);
    if (!link) {
      if (ownedIds().has(member.voice.channelId)) await move(member,null);
      return;
    }
    const key=destination(snapshot,link);
    const id=key==='global'?globalId():registry.channels[key ?? 'entry'];
    if (id && ownedIds().has(member.voice.channelId)) await move(member,id);
  }
  async function retire(g,key,id,reason) {
    return attempt(`retire:${id}`,'channel-retire',{channelId:id},async()=>{
      const c=await channel(g,id);
      if(c) {
        let evacuated=true;
        for(const member of [...(c.members?.values?.()??[])]) {
          const target=(testSession?.id===member.id&&!testSession.cancel)?null:globalId();
          if(!await move(member,target))evacuated=false;
        }
        if(!evacuated)return false;
        await c.delete(reason);
      }
      delete registry.channels[key];delete registry.permissions[id];save();return true;
    });
  }
  async function cleanup(g) {
    for(const [key,id] of Object.entries(registry.channels))
      await retire(g,key,id,'UHC: aktif veya planlanmış maç kalmadı');
    snapshot=null;registry.matchKey=null;registry.pendingRoutes=[];save();
  }
  async function reconcile(state) {
    const g=guild(); if(!g)throw localError('voice_guild_missing');
    if(!discovered){await critical('channel-discovery',{},()=>g.channels.fetch());discovered=true;}
    if (!state.enabled) { await cleanup(g); return; }
    const category=await channel(g,VOICE_CATEGORY);
    if (!category || category.type!==ChannelType.GuildCategory) throw localError('voice_category_missing_or_wrong_type');
    if((await channel(g,GLOBAL_VOICE))?.type!==ChannelType.GuildVoice)throw localError('voice_global_missing_or_wrong_type');
    const specs=channelSpecs(state);
    const keep=new Set(specs.map(s=>s.key));
    // Recover cache misses before deciding capacity or replacing an owned ID.
    for(const id of ownedIds())await channel(g,id);
    const missing=specs.filter(spec=>{const c=g.channels.cache.get(registry.channels[spec.key]);return !c||c.parentId!==VOICE_CATEGORY;}).length;
    let occupied=[...g.channels.cache.values()].filter(c=>c.parentId===VOICE_CATEGORY).length;
    if(occupied+missing>50) {
      for(const [key,id] of Object.entries(registry.channels)) {
        if(keep.has(key)||occupied+missing<=50)continue;
        const old=await channel(g,id);
        registry.pendingRoutes=[...new Set([...(registry.pendingRoutes??[]),...[...(old?.members?.keys?.()??[])]])];save();
        if(await retire(g,key,id,'UHC: yeni takım sesleri için yer açılıyor')&&old?.parentId===VOICE_CATEGORY)occupied--;
      }
      if(occupied+missing>50)throw localError('voice_category_transition_full');
    }
    const unmanaged=[...g.channels.cache.values()].filter(c=>c.parentId===VOICE_CATEGORY&&!ownedIds().has(c.id)).length;
    if(unmanaged+specs.length>50) throw localError('voice_category_capacity_exceeded');
    let role=g.roles.cache.get(registry.roleId);
    if(!role) {
      role=await g.roles.create({name:'UHC • Hesabı Bağlı',permissions:[],reason:'UHC ses giriş yetkisi'});
      registry.roleId=role.id; save();
    }
    const linked=new Set(state.links.map(l=>l.discordId));
    const known=new Set([...registry.linked,...linked]);
    for(const block of guard.blocks())if(!linked.has(block.id)&&block.permission?.connect===1)
      guard.rememberPermission(block.id,{...block.permission,connect:0});
    // Fetch only known linked users, not the entire guild on every five-second poll.
    const revoked=new Set();
    for(const id of known) {
      let m=g.members.cache.get(id);
      if(!m&&(missingMembers.get(id)??0)<=now()) {
        const fetched=await attempt(`member:${id}`,'member-fetch',{memberId:id},async()=>{
          try{m=await g.members.fetch(id);if(!m)missingMembers.set(id,now()+60000);else missingMembers.delete(id);}catch(err){if(err.code!==10007)throw err;missingMembers.set(id,now()+60000);}
        });
        if(!fetched&&!linked.has(id))revoked.add(id);
      }
      if(!m)continue;
      if(linked.has(id)&&!m.roles.cache.has(role.id))
        await attempt(`role-add:${id}:${role.id}`,'role-add',{memberId:id},()=>m.roles.add(role,'Minecraft hesabı bağlı'));
      if(!linked.has(id)&&m.roles.cache.has(role.id)) {
        if(!await attempt(`role-remove:${id}:${role.id}`,'role-remove',{memberId:id},()=>m.roles.remove(role,'Minecraft hesabı bağlantısı kaldırıldı')))revoked.add(id);
      }
    }
    registry.linked=[...new Set([...linked,...revoked])];save();
    for(const [position,spec] of specs.entries()) {
      const overwrites=[{id:g.id,allow:[P.ViewChannel],deny:[P.Connect]},
        {id:role.id,deny:[P.Connect]},
        {id:client.user.id,allow:[P.ViewChannel,P.Connect,P.MoveMembers,P.ManageChannels]}];
      const ri=overwrites.findIndex(o=>o.id===role.id);
      overwrites[ri]= spec.key==='entry'
        ? {id:role.id,allow:[P.ViewChannel,P.Connect]}
        : {id:role.id,allow:[P.ViewChannel],deny:[P.Connect]};
      let c=await channel(g,registry.channels[spec.key]);
      if(!c) {
        c=await critical('channel-create',{channelId:VOICE_CATEGORY,channelKey:spec.key},()=>g.channels.create({name:spec.name,type:ChannelType.GuildVoice,parent:VOICE_CATEGORY,
          permissionOverwrites:overwrites,reason:'UHC maç ses kanalı'}));
        registry.channels[spec.key]=c.id; save();
      }
      if(c.type!==ChannelType.GuildVoice)throw localError('voice_owned_channel_wrong_type');
      if(c.parentId!==VOICE_CATEGORY)await critical('channel-parent',{channelId:c.id},()=>c.setParent(VOICE_CATEGORY,{lockPermissions:false}));
      if(c.name!==spec.name)await critical('channel-name',{channelId:c.id},()=>c.setName(spec.name));
      // Compare gateway-authoritative actual overwrites, not a remembered desired signature.
      const extras=[];
      if(spec.key==='entry') {
        for(const o of c.permissionOverwrites.cache?.values()??[]) {
          if(o.type!==1||o.id===client.user.id)continue;
          const preserveConnect=guard.blocked(o.id)||(linked.has(o.id)&&!(registry.revoked??[]).includes(o.id));
          const allow=o.allow.bitfield&(preserveConnect?~0n:~P.Connect);
          const deny=o.deny.bitfield&(preserveConnect?~0n:~P.Connect);
          if(allow||deny)extras.push({id:o.id,type:1,allow,deny});
        }
        for(const id of revoked) {
          const i=extras.findIndex(o=>o.id===id);const row=extras[i]??{id,type:1,allow:0n,deny:0n};
          row.allow&=~P.Connect;row.deny|=P.Connect;if(i<0)extras.push(row);
        }
      }
      const expected=[...overwrites,...extras];
      if(permissionKey(c.permissionOverwrites.cache?.values()??[])!==permissionKey(expected))
        await critical('channel-permissions',{channelId:c.id},()=>c.permissionOverwrites.set(expected));
    }
    registry.revoked=[...revoked];save();
    await entryPermissions.sync(g,registry.channels.entry);
    const order=specs.map((s,index)=>({channel:registry.channels[s.key],position:index}));
    const orderKey=JSON.stringify(order);
    if(registry.order!==orderKey) {await g.channels.setPositions(order);registry.order=orderKey;}
    const starting=state.active&&registry.matchKey!==state.matchKey;
    const pending=new Set(registry.pendingRoutes??[]);
    if(starting)for(const id of linked)pending.add(id);
    if(!state.active)pending.clear();
    registry.matchKey=state.active?state.matchKey:null;registry.pendingRoutes=[...pending];save();
    snapshot=state;
    for(const id of linked) {
      const link=selectVoiceLink(state.links,id),m=g.members.cache.get(id);
      if(!m)continue;
      if(!m.voice?.channelId){pending.delete(id);continue;}
      if(testSession?.id===m.id&&!testSession.cancel)continue;
      const target=destination(state,link);
      if(pending.has(id)&&target&&target!=='global'&&!guard.blocked(m.id)) {
        if(await move(m,registry.channels[target]))pending.delete(id);
      } else {pending.delete(id);await route(m);}
    }
    for(const vs of g.voiceStates.cache.values())
      if(ownedIds().has(vs.channelId)&&!linked.has(vs.id))await move(vs.member,null);
    registry.pendingRoutes=[...pending];save();
    // Evacuate each retired channel separately; a failed move must not delete it.
    for(const [key,id] of Object.entries(registry.channels)) {
      if(keep.has(key))continue;
      const c=await channel(g,id);
      let evacuated=true;
      for(const m of [...(c?.members?.values?.()??[])]){await route(m);if(m.voice?.channelId===id)evacuated=false;}
      if(evacuated)await retire(g,key,id,'UHC takım kadrosu değişti');
    }
  }

  async function tick() {
    if(busy) return busy;
    busy=(async()=>{
      await entryPermissions.sync(guild(),registry.channels.entry);
      for(const [key,retry] of retries)if(now()-retry.until>300000)retries.delete(key);
      for(const [id,moves] of botMoves){const pending=moves.filter(m=>m.until>now());if(pending.length)botMoves.set(id,pending);else botMoves.delete(id);}
      const res=await api.voiceSnapshot();
      if(!res.ok) {snapshot=null;if(testSession)testSession.cancel='Minecraft köprüsüne ulaşılamadı; test durduruldu.';return;} // Outages must not delete channels or route using stale state.
      if(!isValidVoiceSnapshot(res)) {
        snapshot=null;throw localError('voice_snapshot_invalid');
      }
      if(testSession&&res.enabled)testSession.matchTakenOver=true;
      if(testSession&&!testSession.cancel) {
        const session=testSession;
        if(res.enabled) session.cancel='Aktif veya planlanmış maç var; ses testi durduruldu.';
        else if(!res.links.some(l=>l.discordId===session.id)) session.cancel='Önce Minecraft hesabını Discord hesabına bağla.';
        if(session.cancel&&!session.ready) return;
        if(!session.cancel) {
          await reconcile({...res,enabled:true,active:false,teams:[{number:1}]});
          session.ready=true;return;
        }
      }
      await reconcile(res);
    })().catch(err=>{snapshot=null;if(testSession)testSession.cancel='Ses testi hazırlanırken bir hata oluştu. Botun kanal ve taşıma izinlerini kontrol et.';report('reconcile',err);}).finally(()=>{busy=null;scheduleExpiry();});
    return busy;
  }
  async function voiceChanged(oldState,newState) {
    if(newState.guild.id!==guildId||oldState.channelId===newState.channelId)return;
    const botMove=consumeBotMove(newState.id??newState.member?.id,oldState.channelId,newState.channelId);
    if(!ownedIds().has(newState.channelId))return;
    const member=newState.member;if(!member)return;
    if(newState.channelId===registry.channels.entry&&!botMove) {
      const admission=guard.attempt(member.id);
      if(admission.blocked) {
        if(testSession?.id===member.id)testSession.cancel='Çok fazla ses girişi: bir dakika beklemelisin.';
        await entryPermissions.sync(guild(),registry.channels.entry);scheduleExpiry();
        await move(member,globalId());return;
      }
    }
    if(guard.blocked(member.id)){await move(member,globalId());return;}
    await tick(); await route(member);
  }
  async function runTest(member,{onReady=async()=>{}}={}) {
    if(guard.blocked(member.id))return {ok:false,message:'Ses giriş engelin sürüyor. Bir dakika dolunca tekrar dene.'};
    if(testSession) return {ok:false,message:'Başka bir ses testi sürüyor. Bitmesini bekle.'};
    const session={id:member.id,ready:false,cancel:null};testSession=session;
    const origin=member.voice?.channelId;
    let result;
    try {
      if(busy)await busy;
      await tick();
      if(session.cancel||!session.ready)return {ok:false,message:session.cancel||'Ses testi hazırlanamadı.'};
      const entry=registry.channels.entry;
      await onReady(entry);
      if(session.cancel)return {ok:false,message:session.cancel};
      if(member.voice.channelId)await move(member,entry,()=>testSession===session&&!session.cancel&&!session.matchTakenOver);
      // Discord cannot connect a disconnected member: wait for them to enter.
      for(let seconds=0;!session.cancel&&member.voice.channelId!==entry&&seconds<60;seconds++)await sleep(1000);
      if(!session.cancel&&member.voice.channelId!==entry)session.cancel='Takım Geçiş kanalına 60 saniye içinde girilmedi; test bitti.';
      let expected=entry;
      for(const key of ['team:1','solo','spectator']) {
        if(session.cancel)break;
        await sleep(2000);
        if(session.cancel)break;
        if(member.voice.channelId!==expected){session.cancel='Ses kanalından ayrıldığın için test bitti.';break;}
        expected=registry.channels[key];if(!await move(member,expected,()=>testSession===session&&!session.cancel&&!session.matchTakenOver))session.cancel='Ses taşıması doğrulanamadı; test durduruldu.';
      }
      if(!session.cancel) {
        await sleep(2000);
        if(member.voice.channelId!==expected)session.cancel='Ses kanalından ayrıldığın için test bitti.';
      }
      result=session.cancel?{ok:false,message:session.cancel}:{ok:true,message:'Ses testi tamamlandı: Takım 1 → Solo → İzleyici.'};
    } catch(err) {
      report('voice-test',err,{memberId:member.id});
      result={ok:false,message:'Ses testi tamamlanamadı. Botun kanal ve taşıma izinlerini kontrol et.'};
    } finally {
      if(busy)await busy;
      // A real match takes ownership immediately; never move its players back.
      if(session.ready&&!session.matchTakenOver&&ownedIds().has(member.voice?.channelId)) {
        await move(member,guild()?.channels.cache.has(origin)?origin:null,()=>!session.matchTakenOver)
          .catch(e=>report('voice-test-restore',e,{memberId:member.id}));
      }
      if(busy)await busy;
      testSession=null;
      if(session.ready)await tick();
    }
    return result;
  }
  function start() {
    client.on(Events.VoiceStateUpdate,(a,b)=>voiceChanged(a,b).catch(e=>report('voice-event',e)));
    client.on(Events.GuildMemberAdd,member=>{missingMembers.delete(member.id);tick();});
    tick(); timer=setInterval(tick,5000);timer.unref();
  }
  return {tick,start,runTest,stop:()=>{clearInterval(timer);clearTimeout(expiryTimer);},voiceChanged};
}
