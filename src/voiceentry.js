/** Sliding-window admission control. Permission restoration survives bot restarts. */
export function createEntryGuard({now=Date.now,read=()=>'',write=()=>{}}={}) {
  let users;
  try {users=JSON.parse(read()||'{}');}catch{users={};}
  if(!users||typeof users!=='object'||Array.isArray(users))users={};
  const save=()=>write(JSON.stringify(users));
  function blocked(id){return Number(users[id]?.until)>now();}
  function attempt(id) {
    if(blocked(id))return {blocked:true,started:false,until:users[id].until};
    const t=now(),row=users[id]??={hits:[]};
    row.hits=(row.hits??[]).filter(at=>at>t-60000&&at<=t);row.hits.push(t);
    if(row.hits.length>=10){row.until=t+60000;row.hits=[];save();return {blocked:true,started:true,until:row.until};}
    save();return {blocked:false,started:false};
  }
  function rememberPermission(id,permission){if(users[id]){users[id].permission=permission;save();}}
  function blocks(){return Object.entries(users).filter(([,row])=>row.until).map(([id,row])=>({id,...row}));}
  function finish(id){
    if(blocked(id)||!users[id])return;
    const hits=(users[id].hits??[]).filter(t=>t>now()-60000&&t<=now());
    if(hits.length)users[id]={hits};else delete users[id];save();
  }
  function prune(){let changed=false;for(const [id,row] of Object.entries(users))if(!row.until&&(row.hits??[]).every(t=>t<=now()-60000)){delete users[id];changed=true;}if(changed)save();}
  return {attempt,blocked,rememberPermission,blocks,finish,prune};
}
