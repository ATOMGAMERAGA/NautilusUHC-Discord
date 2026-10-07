/** The game snapshot is the only authority for membership and deaths. */
export function destination(snapshot, link) {
  if (!snapshot.active || !link?.participant) return null;
  if (!link.alive) return 'spectator';
  return Number.isInteger(link.team) && link.team > 0 ? `team:${link.team}` : 'solo';
}
export function channelSpecs(snapshot) {
  const numbers = [...new Set((snapshot.teams ?? []).map(t => t.number)
    .filter(n => Number.isInteger(n) && n > 0))].sort((a,b) => a-b);
  return [{key:'entry',name:'Takım Geçiş'}, ...numbers.map(n=>({key:`team:${n}`,name:`Takım ${n}`})),
    {key:'solo',name:'Solo'},{key:'spectator',name:'İzleyici'}];
}
