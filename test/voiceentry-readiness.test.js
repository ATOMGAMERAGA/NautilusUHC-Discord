import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { createEntryGuard } from '../src/voiceentry.js';
import { createEntryPermissionManager } from '../src/voiceentrypermissions.js';

function environment() {
  let now=1000;
  const guard=createEntryGuard({now:()=>now});
  const cache=new Map();
  const channel={id:'entry',permissionOverwrites:{cache,
    edit:async(id,{Connect})=>{
      const old=cache.get(id);
      const allow=new PermissionsBitField(old?.allow.bitfield??0n),deny=new PermissionsBitField(old?.deny.bitfield??0n);
      allow.remove(P.Connect);deny.remove(P.Connect);
      if(Connect===true)allow.add(P.Connect);if(Connect===false)deny.add(P.Connect);
      cache.set(id,{id,type:1,allow,deny});
    },delete:async id=>cache.delete(id),
  }};
  const guild={channels:{cache:new Map([['entry',channel]])}};
  const block=id=>{for(let i=0;i<10;i++)guard.attempt(id);};
  return {guard,channel,guild,block,now:()=>now,advance:ms=>{now+=ms;},expire:()=>{now=61000;}};
}

test('permission expiry failure for one member leaves other members restored and retries the failed member',async()=>{
  const e=environment();e.block('a');e.block('b');
  const manager=createEntryPermissionManager(e.guard,{now:e.now});await manager.sync(e.guild,'entry');
  const remove=e.channel.permissionOverwrites.delete;
  e.channel.permissionOverwrites.delete=async id=>{if(id==='a')throw Object.assign(new Error('Forbidden'),{status:403});return remove(id);};
  e.expire();await assert.rejects(manager.sync(e.guild,'entry'));
  assert.equal(e.channel.permissionOverwrites.cache.has('b'),false);
  assert.deepEqual(e.guard.blocks().map(row=>row.id),['a']);
  e.channel.permissionOverwrites.delete=remove;e.advance(30000);await manager.sync(e.guild,'entry');
  assert.deepEqual(e.guard.blocks(),[]);assert.equal(e.channel.permissionOverwrites.cache.size,0);
});

test('expired permission is fetched when its channel is absent from gateway cache',async()=>{
  const e=environment();e.block('a');
  const manager=createEntryPermissionManager(e.guard,{now:e.now});await manager.sync(e.guild,'entry');e.expire();
  e.guild.channels.cache.clear();e.guild.channels.fetch=async id=>id==='entry'?e.channel:null;
  await manager.sync(e.guild,'entry');
  assert.equal(e.channel.permissionOverwrites.cache.has('a'),false);assert.deepEqual(e.guard.blocks(),[]);
});

test('temporary channel fetch failure retains expiry restoration data for retry',async()=>{
  const e=environment();e.block('a');const errors=[];
  const manager=createEntryPermissionManager(e.guard,{now:e.now,onError:(error,block)=>errors.push([error.status,block.id])});
  await manager.sync(e.guild,'entry');e.expire();e.guild.channels.cache.clear();
  e.guild.channels.fetch=async()=>{throw Object.assign(new Error('Rate limited'),{status:429});};
  await manager.sync(e.guild,'entry');
  assert.deepEqual(errors,[[429,'a']]);assert.equal(e.guard.blocks().length,1);
  e.guild.channels.fetch=async()=>e.channel;e.advance(5000);await manager.sync(e.guild,'entry');
  assert.deepEqual(e.guard.blocks(),[]);
});

test('expiry restores Connect while preserving unrelated member permission edits',async()=>{
  const e=environment();e.block('a');
  e.channel.permissionOverwrites.cache.set('a',{id:'a',type:1,allow:new PermissionsBitField([P.Connect]),deny:new PermissionsBitField([P.Speak])});
  const manager=createEntryPermissionManager(e.guard,{now:e.now});await manager.sync(e.guild,'entry');
  e.channel.permissionOverwrites.cache.get('a').allow.add(P.Stream);e.expire();await manager.sync(e.guild,'entry');
  const row=e.channel.permissionOverwrites.cache.get('a');
  assert.equal(row.allow.has(P.Connect),true);assert.equal(row.deny.has(P.Speak),true);assert.equal(row.allow.has(P.Stream),true);
});

test('expired 403 restoration waits thirty seconds while other members restore and then retries successfully',async()=>{
  const e=environment();e.block('a');e.block('b');
  const errors=[];const manager=createEntryPermissionManager(e.guard,{now:e.now,onError:error=>errors.push(error.status)});
  await manager.sync(e.guild,'entry');
  const remove=e.channel.permissionOverwrites.delete;let attempts=0;
  e.channel.permissionOverwrites.delete=async id=>{
    if(id==='a'&&++attempts===1)throw Object.assign(new Error('Forbidden'),{status:403});
    return remove(id);
  };
  e.expire();await manager.sync(e.guild,'entry');
  assert.equal(e.channel.permissionOverwrites.cache.has('b'),false);
  assert.deepEqual(e.guard.blocks().map(row=>row.id),['a']);
  await manager.sync(e.guild,'entry');assert.equal(attempts,1);
  assert.equal(manager.retryAt('a'),91000);
  e.advance(29999);await manager.sync(e.guild,'entry');assert.equal(attempts,1);
  e.advance(1);await manager.sync(e.guild,'entry');
  assert.equal(attempts,2);assert.deepEqual(e.guard.blocks(),[]);assert.deepEqual(errors,[403]);
  assert.equal(manager.retryAt('a'),0);
});

for(const {status,retryAfter,delay} of [{status:429,retryAfter:90,delay:90000},{status:503,delay:5000}]) {
  test(`expired ${status} restoration respects its retry deadline`,async()=>{
    const e=environment();e.block('a');
    const manager=createEntryPermissionManager(e.guard,{now:e.now,onError:()=>{}});
    await manager.sync(e.guild,'entry');let attempts=0;const remove=e.channel.permissionOverwrites.delete;
    e.channel.permissionOverwrites.delete=async id=>{
      if(++attempts===1)throw Object.assign(new Error('Unavailable'),{status,rawError:{retry_after:retryAfter}});
      return remove(id);
    };
    e.expire();await manager.sync(e.guild,'entry');await manager.sync(e.guild,'entry');assert.equal(attempts,1);
    assert.equal(manager.retryAt('a'),61000+delay);
    e.advance(delay-1);await manager.sync(e.guild,'entry');assert.equal(attempts,1);
    e.advance(1);await manager.sync(e.guild,'entry');assert.equal(attempts,2);assert.deepEqual(e.guard.blocks(),[]);
  });
}

test('expiry retains member Connect denial when a failed role revocation still requires it',async()=>{
  const e=environment();e.block('a');
  const manager=createEntryPermissionManager(e.guard,{now:e.now,restoreConnect:(id,saved)=>id==='a'?-1:saved});
  await manager.sync(e.guild,'entry');
  assert.deepEqual(e.guard.blocks()[0].permission,{channelId:'entry',existed:false,connect:0});
  e.expire();await manager.sync(e.guild,'entry');
  const row=e.channel.permissionOverwrites.cache.get('a');
  assert.equal(row?.deny.has(P.Connect)??false,true);
  assert.equal(row?.allow.has(P.Connect)??false,false);assert.deepEqual(e.guard.blocks(),[]);
});
