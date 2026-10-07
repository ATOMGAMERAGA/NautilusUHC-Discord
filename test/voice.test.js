import { test } from 'node:test';
import assert from 'node:assert/strict';
const core = await import('../src/voicecore.js').catch(() => ({}));
test('linked alive player routes to numbered team; death and revival follow game', () => {
 assert.equal(typeof core.destination, 'function');
 const state={active:true};
 assert.equal(core.destination(state,{participant:true,alive:true,team:2}), 'team:2');
 assert.equal(core.destination(state,{participant:true,alive:false,team:2}), 'spectator');
 assert.equal(core.destination(state,{participant:true,alive:true,team:null}), 'solo');
 assert.equal(core.destination(state,{participant:false,alive:false}), 'global');
 assert.equal(core.destination({active:false},{participant:true,alive:true,team:2}),null);
});
test('channel names sort by numeric team number',()=>{
 assert.equal(typeof core.channelSpecs,'function');
 assert.deepEqual(core.channelSpecs({teams:[{number:10},{number:2},{number:1}]}).map(x=>x.name),['Takım Geçiş','Takım 1','Takım 2','Takım 10','Solo','İzleyici']);
});

process.env.DISCORD_TOKEN='test';process.env.BRIDGE_SECRET='test';
process.env.DB_PATH=`/tmp/nautilus-voice-test-${process.pid}.db`;
const {createVoiceManager,VOICE_CATEGORY,GLOBAL_VOICE}=await import('../src/voice.js');
const {ChannelType,PermissionFlagsBits:P,PermissionsBitField}=await import('discord.js');
function environment() {
 const channels=new Map([[VOICE_CATEGORY,{id:VOICE_CATEGORY,type:ChannelType.GuildCategory}],[GLOBAL_VOICE,{id:GLOBAL_VOICE,type:ChannelType.GuildVoice,members:new Map()}]]);
 const roles=new Map();const members=new Map();const voices=new Map();const moves=[],deletions=[];let serial=0,stored='',guardStored='',voiceMoved=null;
 const guild={id:'guild',channels:{cache:channels,fetch:async()=>channels,setPositions:async()=>{},create:async opts=>{
  const c={...opts,id:`channel-${++serial}`,parentId:opts.parent,members:new Map(),permissionOverwrites:{cache:new Map(),set:async o=>{c.overwrites=o;c.permissionOverwrites.cache.clear();for(const row of o)c.permissionOverwrites.cache.set(row.id,{id:row.id,type:['guild','linked-role'].includes(row.id)?0:1,allow:new PermissionsBitField(row.allow??[]),deny:new PermissionsBitField(row.deny??[])});},
    edit:async(id,opts)=>{const old=c.permissionOverwrites.cache.get(id);const row={id,type:1,allow:new PermissionsBitField(old?.allow.bitfield??0n),deny:new PermissionsBitField(old?.deny.bitfield??0n)};row.allow.remove(P.Connect);row.deny.remove(P.Connect);if(opts.Connect===true)row.allow.add(P.Connect);if(opts.Connect===false)row.deny.add(P.Connect);c.permissionOverwrites.cache.set(id,row);},
    delete:async id=>c.permissionOverwrites.cache.delete(id)},
   setParent:async id=>{c.parentId=id;},setName:async name=>{c.name=name;},delete:async()=>{deletions.push(c.name);channels.delete(c.id);}};channels.set(c.id,c);return c;
 }},roles:{cache:roles,create:async opts=>{const r={id:'linked-role',...opts};roles.set(r.id,r);return r;}},members:{cache:members,fetch:async id=>members.get(id)},voiceStates:{cache:voices}};
 function addMember(id,channelId='external') {
  const rs=new Map();const m={id,roles:{cache:rs,add:async role=>rs.set(role,{}),remove:async role=>rs.delete(role)},voice:{channelId,setChannel:async to=>{
   const from=m.voice.channelId;channels.get(from)?.members.delete(id);m.voice.channelId=to;voices.get(id).channelId=to;channels.get(to)?.members.set(id,m);moves.push([id,to]);if(voiceMoved)queueMicrotask(()=>voiceMoved(m,from,to));
  }}};members.set(id,m);voices.set(id,{id,channelId,member:m});channels.get(channelId)?.members.set(id,m);return m;
 }
 let state={ok:true,enabled:true,active:false,matchKey:'',teams:[{number:1},{number:2}],links:[{discordId:'a',online:true,participant:false,alive:false,team:1}]};
 const client={user:{id:'bot'},guilds:{cache:new Map([['guild',guild]])}};
 const options={client,guildId:'guild',api:{voiceSnapshot:async()=>state},read:()=>stored,write:v=>{stored=v;},readGuard:()=>guardStored,writeGuard:v=>{guardStored=v;},logger:{error:()=>{}}};
 return {channels,guild,moves,deletions,addMember,onMove:fn=>{voiceMoved=fn;},manager:(extra={})=>createVoiceManager({...options,...extra}),state:v=>{state=v;},current:()=>state,registry:()=>JSON.parse(stored)};
}
test('planned match creates locked channels; start moves only connected participants',async()=>{
 const e=environment();const a=e.addMember('a');const m=e.manager();await m.tick();
 assert.equal(e.channels.size,7);assert.equal(e.moves.length,0);
 const reg=e.registry();const entry=e.channels.get(reg.channels.entry);
 assert.ok(entry.overwrites.find(o=>o.id==='linked-role').allow.includes(P.Connect));
 const team=e.channels.get(reg.channels['team:1']);assert.ok(team.overwrites.find(o=>o.id==='linked-role').deny.includes(P.Connect));
 e.state({...e.current(),active:true,matchKey:'match-1',links:[{discordId:'a',participant:true,alive:true,team:1}]});await m.tick();
 assert.equal(a.voice.channelId,reg.channels['team:1']);
 e.state({...e.current(),links:[{discordId:'a',participant:true,alive:false,team:1}]});await m.tick();assert.equal(a.voice.channelId,reg.channels.spectator);
 e.state({...e.current(),links:[{discordId:'a',participant:true,alive:true,team:2}]});await m.tick();assert.equal(a.voice.channelId,reg.channels['team:2']);
});
test('outage preserves owned channels; recovered unlink revokes access and disconnects',async()=>{
 const e=environment();const a=e.addMember('a');const m=e.manager();await m.tick();
 const reg=e.registry();a.voice.channelId=reg.channels.entry;e.guild.voiceStates.cache.get('a').channelId=a.voice.channelId;e.channels.get(a.voice.channelId).members.set('a',a);
 const old=e.current();e.state({ok:false});await m.tick();assert.equal(e.deletions.length,0);
 e.state({...old,links:[]});await m.tick();assert.equal(a.voice.channelId,null);assert.equal(a.roles.cache.has('linked-role'),false);
});
test('restart reuses IDs; cleanup deletes only owned channels',async()=>{
 const e=environment();await e.manager().tick();const reg=e.registry();await e.manager().tick();assert.deepEqual(e.registry().channels,reg.channels);
 e.channels.set('unrelated',{id:'unrelated',name:'Arkadaşlar',parentId:VOICE_CATEGORY});
 e.state({...e.current(),enabled:false});await e.manager().tick();assert.equal(e.channels.has('unrelated'),true);assert.equal(Object.keys(e.registry().channels).length,0);
});
test('returning through transition channel restores current team; unrelated voices stay untouched after start',async()=>{
 const e=environment();const a=e.addMember('a');const m=e.manager();e.state({...e.current(),active:true,matchKey:'1',links:[{discordId:'a',participant:true,alive:true,team:1}]});await m.tick();const reg=e.registry();
 a.voice.channelId=reg.channels.entry;e.guild.voiceStates.cache.get('a').channelId=a.voice.channelId;await m.voiceChanged({channelId:null},{guild:e.guild,channelId:a.voice.channelId,member:a});assert.equal(a.voice.channelId,reg.channels['team:1']);
 a.voice.channelId='external';e.guild.voiceStates.cache.get('a').channelId='external';e.state({...e.current(),links:[{discordId:'a',participant:true,alive:true,team:2}]});await m.tick();assert.equal(a.voice.channelId,'external');
});

// Catches wrong step timing, cleanup during a demo, and live routing overriding the demo.
test('voice demo creates channels without a match, visits each destination at two-second intervals and cleans up',async()=>{
 const e=environment();e.state({...e.current(),enabled:false});const a=e.addMember('a');
 const waits=[];const m=e.manager({sleep:async ms=>{waits.push(ms);await m.tick();}});
 assert.equal(typeof m.runTest,'function');
 const result=await m.runTest(a);
 assert.equal(result.ok,true);
 assert.deepEqual(e.moves.map(([,id])=>id),['channel-1','channel-2','channel-3','channel-4',null]);
 assert.deepEqual(waits,[2000,2000,2000,2000]);
 assert.equal(Object.keys(e.registry().channels).length,0);
});
test('voice demo refuses planned matches and unlinked accounts without creating channels',async()=>{
 const e=environment();const a=e.addMember('a');const m=e.manager();
 assert.equal(typeof m.runTest,'function');
 assert.equal((await m.runTest(a)).ok,false);assert.equal(e.channels.size,2);
 e.state({...e.current(),enabled:false,links:[]});
 assert.equal((await m.runTest(a)).ok,false);assert.equal(e.channels.size,2);
});
test('disconnected tester can enter transition channel; leaving during demo cancels and cleans up',async()=>{
 const e=environment();e.state({...e.current(),enabled:false});const a=e.addMember('a',null);
 const m=e.manager({sleep:async ms=>{
  if(ms===1000){a.voice.channelId=e.registry().channels.entry;e.guild.voiceStates.cache.get('a').channelId=a.voice.channelId;
   await m.voiceChanged({channelId:null},{guild:e.guild,channelId:a.voice.channelId,member:a});}
  else {a.voice.channelId=null;e.guild.voiceStates.cache.get('a').channelId=null;}
 }});
 assert.equal(typeof m.runTest,'function');
 const result=await m.runTest(a);assert.equal(result.ok,false);assert.equal(e.moves.length,0);
 assert.equal(Object.keys(e.registry().channels).length,0);
});
test('a newly scheduled match cancels demo and keeps real match channels',async()=>{
 const e=environment();e.state({...e.current(),enabled:false});const a=e.addMember('a');
 const m=e.manager({sleep:async()=>{e.state({...e.current(),enabled:true});await m.tick();}});
 assert.equal(typeof m.runTest,'function');
 assert.equal((await m.runTest(a)).ok,false);
 assert.ok(e.registry().channels['team:2']);assert.equal(e.deletions.length,0);
});

test('demo times out without connecting user and rejects concurrent tests',async()=>{
 const e=environment();e.state({...e.current(),enabled:false});const a=e.addMember('a',null);let seconds=0;
 const m=e.manager({sleep:async ms=>{assert.equal(ms,1000);seconds++;assert.equal((await m.runTest(a)).ok,false);}});
 const result=await m.runTest(a);assert.equal(result.ok,false);assert.equal(seconds,60);
 assert.equal(e.moves.length,0);assert.equal(Object.keys(e.registry().channels).length,0);
});
test('successful demo restores original voice and does not move other linked users',async()=>{
 const e=environment();e.state({...e.current(),enabled:false,links:[...e.current().links,{discordId:'b',participant:false}]});
 e.channels.set('external',{id:'external',members:new Map()});const a=e.addMember('a'),b=e.addMember('b');
 const m=e.manager({sleep:async()=>{}});assert.equal((await m.runTest(a)).ok,true);
 assert.equal(a.voice.channelId,'external');assert.equal(b.voice.channelId,'external');
 assert.equal(e.moves.filter(([id])=>id==='b').length,0);
});
test('match takeover while ready notification is sent never pulls player out of their live team',async()=>{
 const e=environment();e.state({...e.current(),enabled:false});const a=e.addMember('a');const m=e.manager({sleep:async()=>{}});
 const result=await m.runTest(a,{onReady:async()=>{
  e.state({...e.current(),enabled:true,active:true,matchKey:'new-match',links:[{discordId:'a',participant:true,alive:true,team:2}]});await m.tick();
 }});
 assert.equal(result.ok,false);assert.equal(a.voice.channelId,e.registry().channels['team:2']);
 assert.deepEqual(e.moves.map(([,to])=>to),[e.registry().channels['team:2']]);
});
test('demo completion waits for pending reconciliation then deletes temporary channels',async()=>{
 const e=environment();e.state({...e.current(),enabled:false});const a=e.addMember('a');let waits=0,release;
 const m=e.manager({sleep:async()=>{
  if(++waits!==4)return;
  const fetch=e.guild.channels.fetch;
  e.guild.channels.fetch=()=>{e.guild.channels.fetch=fetch;return new Promise(resolve=>{release=()=>resolve(e.channels);});};
  m.tick();await new Promise(setImmediate);
 }});
 const result=m.runTest(a);while(!release)await new Promise(setImmediate);
 await new Promise(setImmediate);release();assert.equal((await result).ok,true);
 assert.equal(Object.keys(e.registry().channels).length,0);
});

test('offline linked member goes to global voice, two-account routing follows online account',async()=>{
 const e=environment();const a=e.addMember('a');const m=e.manager();
 e.state({...e.current(),active:true,matchKey:'match',links:[
  {discordId:'a',uuid:'1',online:false,participant:true,alive:true,team:1},
  {discordId:'a',uuid:'2',online:true,participant:true,alive:true,team:2}]});
 await m.tick();const reg=e.registry();assert.equal(a.voice.channelId,reg.channels['team:2']);
 e.state({...e.current(),links:e.current().links.map(l=>({...l,online:false}))});await m.tick();
 assert.equal(a.voice.channelId,GLOBAL_VOICE);assert.ok(e.channels.has(GLOBAL_VOICE));
});
test('tenth manual transition entry moves to global, blocks Connect, restart preserves and expiry restores original permission',async()=>{
 const e=environment();const a=e.addMember('a');let now=0;let m=e.manager({now:()=>now});await m.tick();
 const entry=e.registry().channels.entry;const c=e.channels.get(entry);
 await c.permissionOverwrites.edit('a',{Connect:true});c.permissionOverwrites.cache.get('a').deny.add(P.Speak);
 for(let i=0;i<10;i++){
  a.voice.channelId=entry;e.guild.voiceStates.cache.get('a').channelId=entry;
  await m.voiceChanged({channelId:GLOBAL_VOICE},{guild:e.guild,channelId:entry,member:a});now+=1000;
 }
 assert.equal(a.voice.channelId,GLOBAL_VOICE);assert.ok(c.permissionOverwrites.cache.get('a').deny.has(P.Connect));
 m=e.manager({now:()=>now});await m.tick();assert.ok(c.permissionOverwrites.cache.get('a').deny.has(P.Connect));
 now=69000;await m.tick();assert.equal(c.permissionOverwrites.cache.get('a').deny.has(P.Connect),false);
 assert.equal(c.permissionOverwrites.cache.get('a').allow.has(P.Connect),true);
 assert.equal(c.permissionOverwrites.cache.get('a').deny.has(P.Speak),true);
});
test('bot transition moves do not count toward spam, blocked users remain blocked during bridge outage',async()=>{
 const e=environment();const a=e.addMember('a');let now=0;const m=e.manager({now:()=>now,sleep:async()=>{}});
 // Eleven demos move external -> entry via bot; their delayed gateway entry events must be ignored.
 e.channels.set('external',{id:'external',members:new Map()});e.state({...e.current(),enabled:false});
 e.onMove((member,from,to)=>m.voiceChanged({channelId:from},{guild:e.guild,channelId:to,member}));
 for(let i=0;i<11;i++)assert.equal((await m.runTest(a)).ok,true);
 e.onMove(null);
 e.state({...e.current(),enabled:true,links:[{discordId:'a',online:false}]});await m.tick();
 const entry=e.registry().channels.entry;
 for(let i=0;i<10;i++){a.voice.channelId=entry;e.guild.voiceStates.cache.get('a').channelId=entry;await m.voiceChanged({channelId:GLOBAL_VOICE},{guild:e.guild,channelId:entry,member:a});}
 e.state({ok:false});a.voice.channelId=entry;e.guild.voiceStates.cache.get('a').channelId=entry;
 await m.voiceChanged({channelId:GLOBAL_VOICE},{guild:e.guild,channelId:entry,member:a});assert.equal(a.voice.channelId,GLOBAL_VOICE);
 now=60000;await m.tick();assert.equal(e.channels.get(entry).permissionOverwrites.cache.get('a'),undefined);
});
