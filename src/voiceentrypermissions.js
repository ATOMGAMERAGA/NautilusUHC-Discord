import { PermissionFlagsBits as P } from 'discord.js';

/** Restore only Connect; preserve any unrelated member permission changes. */
export function createEntryPermissionManager(guard) {
  let queue=Promise.resolve();
  function sync(guild,entryId) {
    const run=async()=>{
      if(!guild)return;
      for(const block of guard.blocks()) {
        if(!guard.blocked(block.id)) {
          const old=block.permission,channel=guild.channels.cache.get(old?.channelId);
          if(channel&&old) {
            const current=channel.permissionOverwrites.cache.get(block.id);
            const unrelatedAllow=(current?.allow.bitfield??0n)&~P.Connect;
            const unrelatedDeny=(current?.deny.bitfield??0n)&~P.Connect;
            if(!old.existed&&unrelatedAllow===0n&&unrelatedDeny===0n)
              await channel.permissionOverwrites.delete(block.id,'UHC: geçici ses giriş izni temizlendi');
            else await channel.permissionOverwrites.edit(block.id,{Connect:old.connect===0?null:old.connect===1},
              {type:1,reason:'UHC: bir dakikalık ses giriş engeli bitti'});
          }
          guard.finish(block.id);continue;
        }
        const entry=guild.channels.cache.get(entryId);if(!entry)continue;
        if(block.permission?.channelId!==entryId) {
          const old=entry.permissionOverwrites.cache.get(block.id);
          guard.rememberPermission(block.id,{channelId:entryId,existed:!!old,
            connect:old?.allow.has(P.Connect)?1:old?.deny.has(P.Connect)?-1:0});
        }
        if(!entry.permissionOverwrites.cache.get(block.id)?.deny.has(P.Connect))
          await entry.permissionOverwrites.edit(block.id,{Connect:false},{type:1,reason:'UHC: 60 saniyede 10 ses girişi, bir dakika engel'});
      }
      guard.prune();
    };
    const result=queue.then(run);queue=result.catch(()=>{});return result;
  }
  return {sync};
}
