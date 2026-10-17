/** Reject incomplete state before it can delete channels or route players. */
export function isValidVoiceSnapshot(state) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(state) || typeof state.enabled !== 'boolean' || typeof state.active !== 'boolean'
    || !Array.isArray(state.teams) || !Array.isArray(state.links)) return false;
  if (state.active && (!state.enabled || typeof state.matchKey !== 'string' || !state.matchKey.trim())) return false;
  if (typeof state.matchKey !== 'string') return false;
  const teams = new Set();
  for (const team of state.teams) {
    if (!record(team) || !Number.isInteger(team.number) || team.number < 1 || teams.has(team.number)) return false;
    teams.add(team.number);
  }
  const accounts = new Set();
  for (const link of state.links) {
    if (!record(link) || typeof link.discordId !== 'string' || !link.discordId.trim()) return false;
    // Older snapshots omitted UUID/online. A modern row must retain its online flag.
    if (link.uuid !== undefined && (typeof link.uuid !== 'string' || !link.uuid.trim() || typeof link.online !== 'boolean')) return false;
    for (const field of ['online', 'participant', 'alive']) {
      if (link[field] !== undefined && typeof link[field] !== 'boolean') return false;
    }
    if (state.active && (typeof link.participant !== 'boolean' || typeof link.alive !== 'boolean')) return false;
    if (link.team != null && (!Number.isInteger(link.team) || link.team < 1 || !teams.has(link.team))) return false;
    const account = link.uuid === undefined ? `discord:${link.discordId}` : `uuid:${link.uuid}`;
    if (accounts.has(account)) return false;
    accounts.add(account);
  }
  return true;
}

/** The game snapshot is the only authority for membership and deaths. */
export function destination(snapshot, link) {
  if(link?.online===false || (snapshot.active&&link&&!link.participant))return 'global';
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

/** A Discord member can own two accounts; route once using the account actually online. */
export function selectVoiceLink(links,discordId) {
  const candidates=links.filter(l=>l.discordId===discordId).sort((a,b)=>String(a.uuid??'').localeCompare(String(b.uuid??'')));
  return candidates.find(l=>l.online===true&&l.participant)
    ??candidates.find(l=>l.online===true)
    ??candidates.find(l=>l.online!==false&&l.participant)
    ??candidates[0];
}
