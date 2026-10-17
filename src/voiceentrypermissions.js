import { PermissionFlagsBits as P } from 'discord.js';

/** Restore only Connect; preserve any unrelated member permission changes. */
export function createEntryPermissionManager(guard, {onError=null,now=Date.now,restoreConnect=(_id,connect)=>connect}={}) {
  let queue=Promise.resolve();
  const retries=new Map();
  const retryAt=id=>retries.get(id)?.until??0;
  async function channelFor(guild,id) {
    const cached=guild.channels.cache.get(id);if(cached)return cached;
    // A cache miss after restart is not evidence that a temporary overwrite is gone.
    if(!guild.channels.fetch)throw new Error('Ses giriş izin kanalı önbellekte yok');
    try{return await guild.channels.fetch(id);}
    catch(error){if(error.code===10003)return null;throw error;}
  }
  function sync(guild,entryId) {
    const run=async()=>{
      if(!guild)return;
      const errors=[];
      for(const block of guard.blocks()) {
        if(retryAt(block.id)>now())continue;
        try {
        if(!guard.blocked(block.id)) {
          const old=block.permission,channel=old?await channelFor(guild,old.channelId):null;
          if(channel&&old) {
            const connect=restoreConnect(block.id,old.connect);
            const current=channel.permissionOverwrites.cache.get(block.id);
            const unrelatedAllow=(current?.allow.bitfield??0n)&~P.Connect;
            const unrelatedDeny=(current?.deny.bitfield??0n)&~P.Connect;
            if(!old.existed&&unrelatedAllow===0n&&unrelatedDeny===0n&&connect!==-1)
              await channel.permissionOverwrites.delete(block.id,'UHC: geçici ses giriş izni temizlendi');
            else await channel.permissionOverwrites.edit(block.id,{Connect:connect===0?null:connect===1},
              {type:1,reason:'UHC: bir dakikalık ses giriş engeli bitti'});
          }
          guard.finish(block.id);retries.delete(block.id);continue;
        }
        if(!entryId)continue;
        const entry=await channelFor(guild,entryId);if(!entry)continue;
        if(block.permission?.channelId!==entryId) {
          const old=entry.permissionOverwrites.cache.get(block.id);
          guard.rememberPermission(block.id,{channelId:entryId,existed:!!old,
            connect:old?.allow.has(P.Connect)?1:old?.deny.has(P.Connect)?-1:0});
        }
        if(!entry.permissionOverwrites.cache.get(block.id)?.deny.has(P.Connect))
          await entry.permissionOverwrites.edit(block.id,{Connect:false},{type:1,reason:'UHC: 60 saniyede 10 ses girişi, bir dakika engel'});
        retries.delete(block.id);
        } catch(error) {
          const failures=(retries.get(block.id)?.failures??0)+1;
          const retryAfter=Number(error?.rawError?.retry_after??error?.retry_after??0)*1000;
          const delay=Math.max(error?.status===403?30000:5000,
            Number.isFinite(retryAfter)?retryAfter:0,Math.min(60000,5000*2**Math.min(failures-1,4)));
          retries.set(block.id,{failures,until:now()+delay});
          errors.push({error,block});
        }
      }
      guard.prune();
      if(onError)for(const {error,block} of errors)onError(error,block);
      else if(errors.length)throw new AggregateError(errors.map(row=>row.error),'Ses giriş izinleri güncellenemedi');
    };
    const result=queue.then(run);queue=result.catch(()=>{});return result;
  }
  return {sync,retryAt};
}
