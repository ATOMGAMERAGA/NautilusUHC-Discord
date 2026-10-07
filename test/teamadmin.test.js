import {test} from 'node:test';import assert from 'node:assert/strict';
process.env.DISCORD_TOKEN='test';process.env.BRIDGE_SECRET='test';process.env.DB_PATH=`/tmp/nautilus-teamadmin-${process.pid}.db`;
const {teamPanel,openTeamPanel,handleTeamAdmin}=await import('../src/teamadmin.js');
const {mcapi}=await import('../src/mcapi.js');const {config}=await import('../src/config.js');
const snapshot={ok:true,teams:[{number:1,members:[{uuid:'00000000-0000-0000-0000-000000000001',name:'Atom',alive:true,online:true}]}],players:[{uuid:'00000000-0000-0000-0000-000000000001',name:'Atom',team:1}],teamSize:2,active:false,revision:'v1'};
test('team panel uses valid Discord components and shows numbered rosters',()=>{
 const panel=teamPanel(snapshot,'token');assert.match(panel.embeds[0].data.description,/Takım 1/);
 for(const row of panel.components)assert.ok(row.toJSON().components.length<=5);
});
test('other users and revoked admins cannot execute panel actions',async()=>{
 const original=mcapi.teamAdmin;mcapi.teamAdmin=async()=>snapshot;
 try{
  let payload;await openTeamPanel({user:{id:'owner'},guildId:'g',deferReply:async()=>{},editReply:async p=>{payload=p;}});
  const customId=payload.components[0].toJSON().components[0].custom_id;
  for(const [id,roles] of [['other',new Map([[config.roles.admin,{}]])],['owner',new Map()]]){
   let response;await handleTeamAdmin({customId,user:{id},guildId:'g',member:{roles:{cache:roles}},reply:async p=>{response=p;},showModal:()=>{throw new Error('unauthorized modal');}});
   assert.match(response.content,/ait değil/);
  }
 }finally{mcapi.teamAdmin=original;}
});
test('modal mutation sends UUID, actor and the viewed revision to bridge',async()=>{
 const originalRead=mcapi.teamAdmin,originalWrite=mcapi.teamAction;mcapi.teamAdmin=async()=>snapshot;
 try{
  let payload,body;await openTeamPanel({user:{id:'owner'},guildId:'g',deferReply:async()=>{},editReply:async p=>{payload=p;}});
  const token=payload.components[0].toJSON().components[0].custom_id.split(':')[2];
  mcapi.teamAction=async b=>{body=b;return {...snapshot,revision:'v2'};};
  await handleTeamAdmin({customId:`teamadmin:submit:${token}:move`,user:{id:'owner'},guildId:'g',member:{roles:{cache:new Map([[config.roles.admin,{}]])}},fields:{getTextInputValue:k=>k==='player'?'Atom':'1'},isModalSubmit:()=>true,deferReply:async()=>{},editReply:async p=>{payload=p;}});
  assert.deepEqual(body,{action:'move',player:snapshot.players[0].uuid,team:1,revision:'v1',actor:'discord:owner'});
  assert.match(payload.embeds[0].data.description,/Takım 1/);
 }finally{mcapi.teamAdmin=originalRead;mcapi.teamAction=originalWrite;}
});
test('refreshing the panel cannot retarget an already pending disband after renumbering',async()=>{
 const read=mcapi.teamAdmin,write=mcapi.teamAction;mcapi.teamAdmin=async()=>snapshot;
 try{
  let payload,body;const actor={user:{id:'owner'},guildId:'g',member:{roles:{cache:new Map([[config.roles.admin,{}]])}}};
  await openTeamPanel({...actor,deferReply:async()=>{},editReply:async p=>{payload=p;}});
  const token=payload.components[0].toJSON().components[0].custom_id.split(':')[2];
  await handleTeamAdmin({...actor,customId:`teamadmin:submit:${token}:disband`,fields:{getTextInputValue:()=> '1'},isModalSubmit:()=>true,reply:async()=>{}});
  mcapi.teamAdmin=async()=>({...snapshot,revision:'v2'});
  await handleTeamAdmin({...actor,customId:`teamadmin:action:${token}:refresh`,deferUpdate:async()=>{},editReply:async()=>{}});
  mcapi.teamAction=async b=>{body=b;return {...snapshot,revision:'v3'};};
  await handleTeamAdmin({...actor,customId:`teamadmin:confirm:${token}`,isModalSubmit:()=>false,deferUpdate:async()=>{},editReply:async()=>{}});
  assert.equal(body.revision,'v1','pending operation must retain the original roster identity');
 }finally{mcapi.teamAdmin=read;mcapi.teamAction=write;}
});
test('large teams remain visible within Discord description limits',()=>{
 const big={...snapshot,teams:Array.from({length:10},(_,i)=>({number:i+1,members:Array.from({length:100},(_,j)=>({name:`PlayerName${String(j).padStart(6,'0')}`,alive:false,online:false}))}))};
 const payload=teamPanel(big,'token');const description=payload.embeds[0].data.description;
 assert.ok(description.length<4096);for(let n=1;n<=10;n++)assert.ok(description.includes(`**Takım ${n}**`));assert.match(description,/\+92 oyuncu/);
});
