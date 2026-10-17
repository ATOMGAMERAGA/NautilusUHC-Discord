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
 const guild={id:'guild',channels:{cache:channels,fetch:async id=>{if(!id)return channels;if(channels.has(id))return channels.get(id);throw Object.assign(new Error("unknown"),{code:10003});},setPositions:async()=>{},create:async opts=>{
  const c={...opts,id:`channel-${++serial}`,parentId:opts.parent,members:new Map(),permissionOverwrites:{cache:new Map(),set:async o=>{c.overwrites=o;c.permissionOverwrites.cache.clear();for(const row of o)c.permissionOverwrites.cache.set(row.id,{id:row.id,type:['guild','linked-role'].includes(row.id)?0:1,allow:new PermissionsBitField(row.allow??[]),deny:new PermissionsBitField(row.deny??[])});},
    edit:async(id,opts)=>{const old=c.permissionOverwrites.cache.get(id);const row={id,type:1,allow:new PermissionsBitField(old?.allow.bitfield??0n),deny:new PermissionsBitField(old?.deny.bitfield??0n)};row.allow.remove(P.Connect);row.deny.remove(P.Connect);if(opts.Connect===true)row.allow.add(P.Connect);if(opts.Connect===false)row.deny.add(P.Connect);c.permissionOverwrites.cache.set(id,row);},
    delete:async id=>c.permissionOverwrites.cache.delete(id)},
   setParent:async id=>{c.parentId=id;},setName:async name=>{c.name=name;},delete:async()=>{deletions.push(c.name);channels.delete(c.id);}};channels.set(c.id,c);return c;
 }},roles:{cache:roles,create:async opts=>{const r={id:'linked-role',...opts};roles.set(r.id,r);return r;}},members:{cache:members,fetch:async id=>members.get(id)},voiceStates:{cache:voices}};
 function addMember(id,channelId='external') {
  const rs=new Map();const m={id,roles:{cache:rs,add:async role=>rs.set(typeof role==='object'?role.id:role,{}),remove:async role=>rs.delete(typeof role==='object'?role.id:role)},voice:{channelId,setChannel:async to=>{
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
 const e=environment();e.state({...e.current(),enabled:false});const a=e.addMember('a');let waits=0,release;const mApi={voiceSnapshot:async()=>e.current()};
 const m=e.manager({api:mApi,sleep:async()=>{
  if(++waits!==4)return;
  const fetch=mApi.voiceSnapshot;
  mApi.voiceSnapshot=()=>{mApi.voiceSnapshot=fetch;return new Promise(resolve=>{release=()=>resolve(e.current());});};
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

function activeMembers(e) {
 const a=e.addMember('a'),b=e.addMember('b');
 e.state({...e.current(),active:true,matchKey:'reliable-match',links:[
  {discordId:'a',online:true,participant:true,alive:true,team:1},
  {discordId:'b',online:true,participant:true,alive:true,team:2}]});
 return {a,b};
}
test('role 403 for one member does not stop channel creation or other participant routing',async()=>{
 const e=environment();const {a,b}=activeMembers(e);let attempts=0,now=1;const errors=[];
 a.roles.add=async()=>{attempts++;throw Object.assign(new Error('PRIVATE_TOKEN_DO_NOT_LOG'),{code:50013,status:403});};
 const m=e.manager({now:()=>now,logger:{error:(...v)=>errors.push(v)}});await m.tick();
 assert.equal(b.voice.channelId,e.registry().channels['team:2']);
 assert.equal(attempts,1);await m.tick();assert.equal(attempts,1);
 now+=31000;await m.tick();assert.equal(attempts,2);
 assert.ok(errors.length);assert.equal(JSON.stringify(errors).includes('PRIVATE_TOKEN_DO_NOT_LOG'),false);
});
test('failed initial move is retried from external voice without moving successful peers again',async()=>{
 const e=environment();const {a,b}=activeMembers(e);let attempts=0,now=0;const original=a.voice.setChannel;
 a.voice.setChannel=async id=>{attempts++;if(attempts===1)throw Object.assign(new Error('forbidden'),{code:50013,status:403});return original(id);};
 const m=e.manager({now:()=>now});await m.tick();const reg=e.registry();
 assert.equal(b.voice.channelId,reg.channels['team:2']);assert.equal(a.voice.channelId,'external');
 await m.tick();assert.equal(attempts,1);now=31000;await m.tick();
 assert.equal(a.voice.channelId,reg.channels['team:1']);assert.equal(e.moves.filter(([id])=>id==='b').length,1);
});
test('REST move success without a changed voice state stays pending and retries after backoff',async()=>{
 const e=environment();const {a,b}=activeMembers(e);let attempts=0,now=0;const original=a.voice.setChannel;
 a.voice.setChannel=async id=>{attempts++;if(attempts>1)return original(id);};
 const m=e.manager({now:()=>now,sleep:async()=>{}});await m.tick();
 assert.equal(b.voice.channelId,e.registry().channels['team:2']);assert.equal(a.voice.channelId,'external');
 now=31000;await m.tick();assert.equal(a.voice.channelId,e.registry().channels['team:1']);assert.equal(attempts,2);
});
test('429 retry_after isolates member and defers API retries until deadline',async()=>{
 const e=environment();const {a,b}=activeMembers(e);let now=0,calls=0;const original=a.voice.setChannel;
 a.voice.setChannel=async id=>{calls++;if(calls===1)throw Object.assign(new Error('limited'),{status:429,rawError:{retry_after:40}});return original(id);};
 const m=e.manager({now:()=>now});await m.tick();assert.equal(b.voice.channelId,e.registry().channels['team:2']);
 now=39000;await m.tick();assert.equal(calls,1);now=41000;await m.tick();assert.equal(calls,2);
});
test('actual permission drift is repaired and unknown Connect overrides are removed',async()=>{
 const e=environment();e.addMember('a');const m=e.manager();await m.tick();const reg=e.registry();
 const team=e.channels.get(reg.channels['team:1']),entry=e.channels.get(reg.channels.entry);
 team.permissionOverwrites.cache.set('alien-role',{id:'alien-role',type:0,allow:new PermissionsBitField(P.Connect),deny:new PermissionsBitField()});
 await entry.permissionOverwrites.edit('unlinked',{Connect:true});await m.tick();
 assert.equal(team.permissionOverwrites.cache.has('alien-role'),false);
 assert.equal(entry.permissionOverwrites.cache.get('unlinked')?.allow.has(P.Connect)??false,false);
});
test('steady reconciliation does not fetch all channels or rewrite unchanged overwrites',async()=>{
 const e=environment();e.addMember('a');let fetches=0,writes=0;const fetch=e.guild.channels.fetch;
 e.guild.channels.fetch=async id=>{if(!id)fetches++;return fetch(id);};const m=e.manager();await m.tick();
 for(const c of e.channels.values())if(c.permissionOverwrites){const set=c.permissionOverwrites.set;c.permissionOverwrites.set=async v=>{writes++;return set(v);};}
 await m.tick();await m.tick();assert.equal(fetches,1);assert.equal(writes,0);
});
test('cache miss fetches owned channel by ID without losing its identity',async()=>{
 const e=environment();const m=e.manager();await m.tick();const reg=e.registry(),id=reg.channels['team:1'],channel=e.channels.get(id);e.channels.delete(id);
 const fetch=e.guild.channels.fetch;e.guild.channels.fetch=async query=>{if(query===id){e.channels.set(id,channel);return channel;}return fetch(query);};
 await m.tick();assert.equal(e.registry().channels['team:1'],id);
});
test('confirmed channel deletion recreates only missing owned channel',async()=>{
 const e=environment();const m=e.manager();await m.tick();const reg=e.registry();e.channels.delete(reg.channels['team:1']);await m.tick();
 assert.notEqual(e.registry().channels['team:1'],reg.channels['team:1']);assert.equal(e.registry().channels['team:2'],reg.channels['team:2']);
});
test('cleanup preserves a channel whose occupant cannot be evacuated and still cleans other channels',async()=>{
 const e=environment();const {a}=activeMembers(e);let now=0;const m=e.manager({now:()=>now});await m.tick();const id=a.voice.channelId;
 a.voice.setChannel=async()=>{throw Object.assign(new Error('forbidden'),{status:403});};e.state({...e.current(),active:false,enabled:false});await m.tick();
 assert.equal(e.channels.has(id),true);assert.equal(Object.keys(e.registry().channels).length,1);
 assert.ok(e.deletions.length>=3);
});
test('full category transitions retire old managed team safely before replacement',async()=>{
 const e=environment();const a=e.addMember('a');
 e.state({...e.current(),active:true,matchKey:'full',teams:[{number:1}],links:[{discordId:'a',online:true,participant:true,alive:true,team:1}]});
 for(let i=0;i<46;i++)e.channels.set(`manual${i}`,{id:`manual${i}`,parentId:VOICE_CATEGORY,type:ChannelType.GuildVoice});
 const create=e.guild.channels.create;e.guild.channels.create=async opts=>{assert.ok([...e.channels.values()].filter(c=>c.parentId===VOICE_CATEGORY).length<50);return create(opts);};
 const m=e.manager();await m.tick();const old=e.registry().channels['team:1'];
 e.state({...e.current(),teams:[{number:2}],links:[{discordId:'a',online:true,participant:true,alive:true,team:2}]});await m.tick();
 assert.equal(a.voice.channelId,e.registry().channels['team:2']);assert.equal(e.channels.has(old),false);assert.equal(e.channels.has('manual0'),true);
});

test('failed retiring team move retries destination after evacuation',async()=>{
 const e=environment();const a=e.addMember('a');let now=1000;
 const m=e.manager({now:()=>now});
 e.state({...e.current(),active:true,matchKey:'m',links:[{discordId:'a',online:true,participant:true,alive:true,team:1}]});
 await m.tick();const team2=e.registry().channels['team:2'];const original=a.voice.setChannel;
 a.voice.setChannel=async id=>{if(id===team2)throw Object.assign(new Error('Forbidden'),{status:403});return original(id);};
 e.state({...e.current(),teams:[{number:2}],links:[{discordId:'a',online:true,participant:true,alive:true,team:2}]});
 await m.tick();a.voice.setChannel=original;now+=31000;await m.tick();
 assert.equal(a.voice.channelId,team2);
});
test('failed member fetch preserves the start move until recovery',async()=>{
 const e=environment();const a=e.addMember('a');let now=1000;
 e.guild.members.cache.delete('a');e.guild.members.fetch=async()=>{throw Object.assign(new Error('Forbidden'),{status:403});};
 const m=e.manager({now:()=>now});
 e.state({...e.current(),active:true,matchKey:'m',links:[{discordId:'a',online:true,participant:true,alive:true,team:1}]});
 await m.tick();now+=31000;e.guild.members.fetch=async()=>{e.guild.members.cache.set('a',a);return a;};await m.tick();
 assert.equal(a.voice.channelId,e.registry().channels['team:1']);
});
test('unlink during guard block cannot restore member Connect during outage',async()=>{
 const e=environment();const a=e.addMember('a');let now=1000;
 const m=e.manager({now:()=>now});await m.tick();const entry=e.registry().channels.entry;const c=e.channels.get(entry);
 await c.permissionOverwrites.edit('a',{Connect:true});
 for(let i=0;i<10;i++){
  a.voice.channelId=entry;e.guild.voiceStates.cache.get('a').channelId=entry;
  await m.voiceChanged({channelId:GLOBAL_VOICE},{guild:e.guild,channelId:entry,member:a});
 }
 e.state({...e.current(),links:[]});await m.tick();
 e.state({ok:false});now+=60000;await m.tick();
 assert.equal(c.permissionOverwrites.cache.get('a')?.allow.has(P.Connect)??false,false);
});

test('concurrent entry events coalesce reconciliation and perform only one confirmed move per member',async()=>{
 const e=environment();let reads=0;const members=[];
 for(let i=0;i<20;i++)members.push(e.addMember('p'+i));
 const links=members.map((m,i)=>({discordId:m.id,online:true,participant:true,alive:true,team:i%2+1}));
 e.state({...e.current(),links:links.map(l=>({...l,participant:false}))});
 const m=e.manager({api:{voiceSnapshot:async()=>{reads++;return e.current();}}});await m.tick();
 const entry=e.registry().channels.entry;
 for(const member of members){member.voice.channelId=entry;e.guild.voiceStates.cache.get(member.id).channelId=entry;e.channels.get(entry).members.set(member.id,member);}
 e.state({...e.current(),active:true,matchKey:'parallel',links});reads=0;
 await Promise.all(members.map(member=>m.voiceChanged({channelId:'external'},{guild:e.guild,channelId:entry,member})));
 assert.equal(reads,1);assert.equal(e.moves.length,20);
 for(const [i,member]of members.entries())assert.equal(member.voice.channelId,e.registry().channels[`team:${i%2+1}`]);
});
test('match ending while a REST move is pending waits for completion then evacuates and cleans only owned channels',async()=>{
 const e=environment();const {a}=activeMembers(e);const original=a.voice.setChannel;let release;
 a.voice.setChannel=id=>new Promise(resolve=>{release=async()=>{a.voice.setChannel=original;await original(id);resolve();};});
 const m=e.manager();const starting=m.tick();while(!release)await new Promise(setImmediate);
 e.state({...e.current(),active:false,enabled:false,matchKey:''});const overlap=m.tick();
 await release();await starting;await overlap;await m.tick();
 assert.equal(a.voice.channelId,GLOBAL_VOICE);assert.equal(Object.keys(e.registry().channels).length,0);assert.equal(e.channels.has(GLOBAL_VOICE),true);
});
test('role removal failure denies entry immediately and retry later releases only its temporary denial',async()=>{
 const e=environment();const {a}=activeMembers(e);let now=0;const m=e.manager({now:()=>now});await m.tick();
 const entry=e.channels.get(e.registry().channels.entry),remove=a.roles.remove;
 a.roles.remove=async()=>{throw Object.assign(new Error('forbidden'),{status:403});};
 e.state({...e.current(),links:e.current().links.filter(l=>l.discordId!=='a')});await m.tick();
 assert.equal(entry.permissionOverwrites.cache.get('a').deny.has(P.Connect),true);
 now=31000;a.roles.remove=remove;await m.tick();
 assert.equal(a.roles.cache.has('linked-role'),false);assert.equal(entry.permissionOverwrites.cache.get('a')?.deny.has(P.Connect)??false,false);
});
test('wrong category reports a safe specific configuration code and preserves existing channels',async()=>{
 const e=environment();const errors=[];const m=e.manager({logger:{error:(...args)=>errors.push(args)}});await m.tick();const before=e.registry().channels;
 e.channels.get(VOICE_CATEGORY).type=ChannelType.GuildVoice;await m.tick();
 assert.deepEqual(e.registry().channels,before);assert.equal(errors.at(-1)[1].code,'voice_category_missing_or_wrong_type');
});
test('managed voice moved outside a full category is not blindly moved back over the capacity limit',async()=>{
 const e=environment();e.state({...e.current(),teams:[{number:1}]});const m=e.manager();await m.tick();
 const c=e.channels.get(e.registry().channels.solo);c.parentId='outside';
 for(let i=0;i<47;i++)e.channels.set(`manual${i}`,{id:`manual${i}`,parentId:VOICE_CATEGORY,type:ChannelType.GuildVoice});
 await m.tick();assert.equal(c.parentId,'outside');assert.equal(e.channels.has('manual0'),true);
});

test('unlink role failure stays denied when guard expires during bridge outage, then recovers after removal',async()=>{
 const e=environment();const a=e.addMember('a');let now=0;const m=e.manager({now:()=>now});await m.tick();
 const entry=e.registry().channels.entry,c=e.channels.get(entry);await c.permissionOverwrites.edit('a',{Connect:true});
 c.permissionOverwrites.cache.get('a').deny.add(P.Speak);
 for(let i=0;i<10;i++){a.voice.channelId=entry;e.guild.voiceStates.cache.get('a').channelId=entry;await m.voiceChanged({channelId:GLOBAL_VOICE},{guild:e.guild,channelId:entry,member:a});}
 const remove=a.roles.remove;a.roles.remove=async()=>{throw Object.assign(new Error('forbidden'),{status:403});};
 const state={...e.current(),links:[]};e.state(state);await m.tick();
 assert.equal(a.roles.cache.has('linked-role'),true);assert.equal(c.permissionOverwrites.cache.get('a').deny.has(P.Connect),true);
 e.state({ok:false});now=60000;await m.tick();
 assert.equal(c.permissionOverwrites.cache.get('a').deny.has(P.Connect),true);assert.equal(c.permissionOverwrites.cache.get('a').deny.has(P.Speak),true);
 a.roles.remove=remove;e.state(state);await m.tick();assert.equal(a.roles.cache.has('linked-role'),false);
 assert.equal(c.permissionOverwrites.cache.get('a')?.deny.has(P.Connect)??false,false);assert.equal(c.permissionOverwrites.cache.get('a').deny.has(P.Speak),true);
});
