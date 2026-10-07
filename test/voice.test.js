import { test } from 'node:test';
import assert from 'node:assert/strict';
const core = await import('../src/voicecore.js').catch(() => ({}));
test('linked alive player routes to numbered team; death and revival follow game', () => {
 assert.equal(typeof core.destination, 'function');
 const state={active:true};
 assert.equal(core.destination(state,{participant:true,alive:true,team:2}), 'team:2');
 assert.equal(core.destination(state,{participant:true,alive:false,team:2}), 'spectator');
 assert.equal(core.destination(state,{participant:true,alive:true,team:null}), 'solo');
 assert.equal(core.destination(state,{participant:false,alive:false}), null);
 assert.equal(core.destination({active:false},{participant:true,alive:true,team:2}),null);
});
test('channel names sort by numeric team number',()=>{
 assert.equal(typeof core.channelSpecs,'function');
 assert.deepEqual(core.channelSpecs({teams:[{number:10},{number:2},{number:1}]}).map(x=>x.name),['Takım Geçiş','Takım 1','Takım 2','Takım 10','Solo','İzleyici']);
});

process.env.DISCORD_TOKEN='test';process.env.BRIDGE_SECRET='test';
process.env.DB_PATH=`/tmp/nautilus-voice-test-${process.pid}.db`;
const {createVoiceManager,VOICE_CATEGORY}=await import('../src/voice.js');
const {ChannelType,PermissionFlagsBits:P}=await import('discord.js');
function environment() {
 const channels=new Map([[VOICE_CATEGORY,{id:VOICE_CATEGORY,type:ChannelType.GuildCategory}]]);
 const roles=new Map();const members=new Map();const voices=new Map();const moves=[],deletions=[];let serial=0,stored='';
 const guild={id:'guild',channels:{cache:channels,fetch:async()=>channels,setPositions:async()=>{},create:async opts=>{
  const c={...opts,id:`channel-${++serial}`,parentId:opts.parent,members:new Map(),permissionOverwrites:{set:async o=>{c.overwrites=o;}},
   setParent:async id=>{c.parentId=id;},setName:async name=>{c.name=name;},delete:async()=>{deletions.push(c.name);channels.delete(c.id);}};channels.set(c.id,c);return c;
 }},roles:{cache:roles,create:async opts=>{const r={id:'linked-role',...opts};roles.set(r.id,r);return r;}},members:{cache:members,fetch:async id=>members.get(id)},voiceStates:{cache:voices}};
 function addMember(id,channelId='external') {
  const rs=new Map();const m={id,roles:{cache:rs,add:async role=>rs.set(role,{}),remove:async role=>rs.delete(role)},voice:{channelId,setChannel:async to=>{
   channels.get(m.voice.channelId)?.members.delete(id);m.voice.channelId=to;voices.get(id).channelId=to;channels.get(to)?.members.set(id,m);moves.push([id,to]);
  }}};members.set(id,m);voices.set(id,{id,channelId,member:m});channels.get(channelId)?.members.set(id,m);return m;
 }
 let state={ok:true,enabled:true,active:false,matchKey:'',teams:[{number:1},{number:2}],links:[{discordId:'a',participant:false,alive:false,team:1}]};
 const client={user:{id:'bot'},guilds:{cache:new Map([['guild',guild]])}};
 const options={client,guildId:'guild',api:{voiceSnapshot:async()=>state},read:()=>stored,write:v=>{stored=v;},logger:{error:()=>{}}};
 return {channels,guild,moves,deletions,addMember,manager:()=>createVoiceManager(options),state:v=>{state=v;},current:()=>state,registry:()=>JSON.parse(stored)};
}
test('planned match creates locked channels; start moves only connected participants',async()=>{
 const e=environment();const a=e.addMember('a');const m=e.manager();await m.tick();
 assert.equal(e.channels.size,6);assert.equal(e.moves.length,0);
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
