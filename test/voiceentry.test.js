import {test} from 'node:test';
import assert from 'node:assert/strict';
const core=await import('../src/voiceentry.js').catch(()=>({}));
test('tenth transition entry in rolling minute blocks for a minute without extending on retry',()=>{
 assert.equal(typeof core.createEntryGuard,'function');let now=1000;
 const guard=core.createEntryGuard({now:()=>now});
 for(let i=0;i<9;i++){assert.equal(guard.attempt('a').blocked,false);now+=1000;}
 const result=guard.attempt('a');assert.equal(result.started,true);assert.equal(result.until,70000);
 now=20000;assert.equal(guard.attempt('a').until,70000);assert.equal(guard.attempt('b').blocked,false);
 now=70000;assert.equal(guard.blocked('a'),false);assert.equal(guard.attempt('a').blocked,false);
});
test('old entries age out and persisted blocks survive restart with permission restoration data',()=>{
 assert.equal(typeof core.createEntryGuard,'function');let now=0,stored='';
 const options={now:()=>now,read:()=>stored,write:value=>{stored=value;}};
 let guard=core.createEntryGuard(options);
 for(let i=0;i<9;i++)guard.attempt('a');now=60000;assert.equal(guard.attempt('a').blocked,false);
 for(let i=0;i<9;i++)guard.attempt('a');guard.rememberPermission('a',{channelId:'entry',connect:1,existed:true});
 guard=core.createEntryGuard(options);assert.equal(guard.blocked('a'),true);
 assert.deepEqual(guard.blocks()[0].permission,{channelId:'entry',connect:1,existed:true});
 now=120000;assert.equal(guard.blocks()[0].until,120000);guard.finish('a');assert.deepEqual(guard.blocks(),[]);
});

test('permission expiry deletes temporary overwrite even before Discord gateway reflects REST edits',async()=>{
 const {createEntryPermissionManager}=await import('../src/voiceentrypermissions.js');
 const {PermissionsBitField,PermissionFlagsBits:P}=await import('discord.js');
 let now=0;const guard=core.createEntryGuard({now:()=>now});for(let i=0;i<10;i++)guard.attempt('a');
 guard.rememberPermission('a',{channelId:'entry',connect:0,existed:false});
 const cache=new Map([['a',{allow:new PermissionsBitField(),deny:new PermissionsBitField([P.Connect])}]]);
 const channel={permissionOverwrites:{cache,edit:async()=>{},delete:async id=>cache.delete(id)}};
 now=60000;await createEntryPermissionManager(guard).sync({channels:{cache:new Map([['entry',channel]])}},'entry');
 assert.equal(cache.has('a'),false);assert.deepEqual(guard.blocks(),[]);
});
test('entry accepted just after block expiry remains in rolling count when permission cleanup finishes',()=>{
 let now=0;const guard=core.createEntryGuard({now:()=>now});for(let i=0;i<10;i++)guard.attempt('a');
 now=60000;assert.equal(guard.attempt('a').blocked,false);guard.finish('a');
 for(let i=0;i<8;i++)assert.equal(guard.attempt('a').blocked,false);
 assert.equal(guard.attempt('a').started,true);
});
