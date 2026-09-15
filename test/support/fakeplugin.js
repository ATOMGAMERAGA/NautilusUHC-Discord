import { randomUUID } from 'node:crypto';

/**
 * Bot karar mantığını kontrollü zamanlama ve hata enjeksiyonuyla sürmek için
 * plugin modeli. Gerçek sözleşme (JAR + SQLite) Java harness'lı entegrasyon
 * testinde ayrıca doğrulanır; burası yalnız bot tarafının davranışını izole eder.
 *
 * linkProtocol < 2 → 1.2.1 plugin davranışı (v2 uçları yok, unlink kodları iptal
 * etmez). linkProtocol >= 2 → 1.2.2 sözleşmesi.
 */
export function createFakePlugin({ instanceId = 'mc-live', linkProtocol = 2, now = () => Date.now() } = {}) {
  const pending = new Map();
  const receipts = new Map();
  const links = new Map();
  const epochs = new Map();
  const names = new Map();
  const events = [];
  const operations = new Map();
  const calls = [];
  let nextEventId = 1;

  const norm = (code) => String(code ?? '').trim().toUpperCase();
  const linkByDiscord = (discordId) => [...links.values()].find((l) => l.discordId === discordId) ?? null;
  const view = (link) => (link ? {
    uuid: link.uuid,
    mcName: link.mcName,
    currentName: names.get(link.uuid) ?? link.mcName,
    discordId: link.discordId,
    discordTag: link.discordTag,
    linkedAt: link.linkedAt,
    linkId: link.linkId,
  } : null);

  function issueCode(uuid, name, code) {
    for (const [c, p] of pending) if (p.uuid === uuid) pending.delete(c);
    if (linkProtocol >= 2) {
      for (const [c, r] of receipts) if (r.uuid === uuid) receipts.delete(c);
    }
    const normalized = norm(code);
    pending.set(normalized, {
      uuid, name, epoch: epochs.get(uuid) ?? 0, issuanceId: randomUUID(), expiresAt: now() + 600_000,
    });
    names.set(uuid, name);
    return normalized;
  }

  function record(event) {
    const entry = { id: nextEventId++, occurredAt: now(), ...event };
    events.push(entry);
    if (event.requestId) operations.set(event.requestId, entry);
    return entry;
  }

  function verify({ code, discordId, discordTag, requestId = null }) {
    const c = norm(code);
    const p = pending.get(c);
    if (!p) {
      const r = receipts.get(c);
      const link = r ? links.get(r.uuid) : null;
      const sameOperation = linkProtocol >= 2 ? link?.linkId === r?.linkId : true;
      if (r && r.discordId === discordId && link && link.discordId === discordId && sameOperation) {
        return { status: 200, data: { result: 'linked', created: false, replay: true, link: view(link) } };
      }
      return { status: 404, data: { error: 'invalid_code' } };
    }
    if (p.expiresAt <= now()) {
      pending.delete(c);
      return { status: 404, data: { error: 'expired_code' } };
    }
    if (linkProtocol >= 2 && (epochs.get(p.uuid) ?? 0) !== p.epoch) {
      pending.delete(c);
      return { status: 404, data: { error: 'invalid_code' } };
    }
    const byUuid = links.get(p.uuid);
    if (byUuid) {
      if (byUuid.discordId === discordId) {
        pending.delete(c);
        receipts.set(c, { uuid: p.uuid, discordId, linkId: byUuid.linkId });
        return {
          status: 200,
          data: { result: 'linked', created: false, replay: byUuid.linkId === p.issuanceId, link: view(byUuid) },
        };
      }
      if (linkProtocol >= 2) pending.delete(c);
      return { status: 404, data: { error: 'invalid_code' } };
    }
    const byDiscord = linkByDiscord(discordId);
    if (byDiscord) return { status: 409, data: { error: 'discord_already_linked', link: view(byDiscord) } };

    const link = {
      uuid: p.uuid, mcName: p.name, discordId, discordTag, linkedAt: now(), linkId: p.issuanceId,
    };
    links.set(p.uuid, link);
    pending.delete(c);
    receipts.set(c, { uuid: p.uuid, discordId, linkId: link.linkId });
    record({
      action: 'link', result: 'ok', ...view(link), actorType: 'player_discord', actorId: discordId,
      source: 'discord_modal', requestId,
    });
    return { status: 200, data: { result: 'linked', created: true, replay: false, link: view(link) } };
  }

  function resolveName(name) {
    const lower = String(name).toLowerCase();
    const uuids = new Set();
    for (const link of links.values()) if (link.mcName.toLowerCase() === lower) uuids.add(link.uuid);
    for (const [uuid, current] of names) if (current.toLowerCase() === lower) uuids.add(uuid);
    return [...uuids];
  }

  function select(selector, value) {
    if (selector === 'uuid') return { uuid: value };
    if (selector === 'discord') return { uuid: linkByDiscord(value)?.uuid ?? null, discordOnly: true };
    const candidates = resolveName(value);
    if (candidates.length > 1) return { ambiguous: candidates };
    return { uuid: candidates[0] ?? null, resolved: candidates.length === 1 };
  }

  function unlink({
    selector, value, expectedLinkId = null, reason = null, actor = null, requestId = null,
  }) {
    const target = select(selector, value);
    if (target.ambiguous) {
      return {
        status: 409,
        data: {
          error: 'ambiguous_name',
          candidates: target.ambiguous.map((uuid) => ({ uuid, linked: links.has(uuid), link: view(links.get(uuid)) })),
        },
      };
    }
    const link = target.uuid ? links.get(target.uuid) : null;
    if (!link) {
      record({ action: 'unlink', result: 'not_linked', uuid: target.uuid, requestId, reason });
      return { status: 200, data: { result: 'not_linked', resolved: target.resolved ?? Boolean(target.uuid) } };
    }
    if (expectedLinkId && expectedLinkId !== link.linkId) {
      record({ action: 'unlink', result: 'stale_version', ...view(link), requestId, reason });
      return { status: 409, data: { error: 'stale_version', current: view(link) } };
    }
    links.delete(link.uuid);
    if (linkProtocol >= 2) {
      epochs.set(link.uuid, (epochs.get(link.uuid) ?? 0) + 1);
      for (const [c, p] of pending) if (p.uuid === link.uuid) pending.delete(c);
      for (const [c, r] of receipts) if (r.uuid === link.uuid) receipts.delete(c);
    }
    record({
      action: 'unlink', result: 'ok', ...view(link), actorType: actor?.type ?? null, actorId: actor?.id ?? null,
      reason, requestId,
    });
    return { status: 200, data: { result: 'removed', link: view(link), epoch: epochs.get(link.uuid) ?? 0 } };
  }

  function legacyStatus(query) {
    if (query.has('discord')) {
      const link = linkByDiscord(query.get('discord'));
      return {
        status: 200,
        data: link
          ? { linked: true, mc: link.mcName, discordId: link.discordId, linkedAt: link.linkedAt }
          : { linked: false },
      };
    }
    const candidates = resolveName(query.get('mc') ?? '').filter((uuid) => links.has(uuid));
    if (linkProtocol >= 2 && candidates.length > 1) return { status: 409, data: { error: 'ambiguous_name' } };
    const link = candidates.length ? links.get(candidates[0]) : null;
    return {
      status: 200,
      data: link ? { linked: true, mc: link.mcName, discordId: link.discordId, linkedAt: link.linkedAt } : { linked: false },
    };
  }

  function route(job) {
    const [pathname, rawQuery = ''] = String(job.path).split('?');
    const query = new URLSearchParams(rawQuery);
    const body = job.body ?? {};
    const method = String(job.method ?? 'GET').toUpperCase();

    if (method === 'GET' && pathname === '/api/link/status') return legacyStatus(query);
    if (method === 'POST' && pathname === '/api/link/verify') {
      const res = verify(body);
      if (res.status === 200) return { status: 200, data: { mc: res.data.link.mcName, ...res.data } };
      return res;
    }
    if (method === 'DELETE' && pathname === '/api/link') {
      const res = unlink({ selector: body.type === 'dc' ? 'discord' : 'name', value: body.value });
      if (res.status !== 200) return res;
      const removed = res.data.result === 'removed';
      return {
        status: 200,
        data: { removed, mc: res.data.link?.mcName, discordId: res.data.link?.discordId },
      };
    }
    if (linkProtocol < 2 || !pathname.startsWith('/api/link/v2/')) {
      return { status: 404, data: { error: 'not_found' } };
    }

    const endpoint = pathname.slice('/api/link/v2/'.length);
    if (method === 'POST' && endpoint === 'probe') {
      const p = pending.get(norm(body.code));
      return { status: 200, data: { holder: Boolean(p && p.expiresAt > now()), expired: Boolean(p && p.expiresAt <= now()) } };
    }
    if (method === 'POST' && endpoint === 'verify') return verify(body);
    if (method === 'GET' && endpoint === 'operation') {
      // Java LinkBridgeApi sözleşmesi: başarılı link → "linked", başarılı unlink → "removed".
      const op = operations.get(query.get('requestId'));
      if (!op) return { status: 200, data: { found: false } };
      const result = op.result === 'ok' ? (op.action === 'link' ? 'linked' : 'removed') : op.result;
      return {
        status: 200,
        data: {
          found: true,
          action: op.action,
          result,
          occurredAt: op.occurredAt,
          link: op.uuid ? {
            uuid: op.uuid, mcName: op.mcName, discordId: op.discordId, linkId: op.linkId,
          } : null,
        },
      };
    }
    if (method === 'GET' && endpoint === 'info') {
      let uuid = null;
      if (query.has('uuid')) uuid = query.get('uuid');
      else if (query.has('discord')) uuid = linkByDiscord(query.get('discord'))?.uuid ?? null;
      else if (query.has('name')) {
        const candidates = resolveName(query.get('name'));
        if (candidates.length > 1) {
          return {
            status: 409,
            data: {
              error: 'ambiguous_name',
              candidates: candidates.map((u) => ({ uuid: u, linked: links.has(u), link: view(links.get(u)) })),
            },
          };
        }
        uuid = candidates[0] ?? null;
      }
      const link = uuid ? links.get(uuid) : null;
      return { status: 200, data: link ? { linked: true, link: view(link), epoch: epochs.get(uuid) ?? 0 } : { linked: false, uuid } };
    }
    if (method === 'GET' && endpoint === 'list') {
      const offset = Number(query.get('offset') ?? 0);
      const limit = Math.min(Number(query.get('limit') ?? 10), 25);
      const sorted = [...links.values()].sort((a, b) => (b.linkedAt - a.linkedAt) || a.uuid.localeCompare(b.uuid));
      return {
        status: 200,
        data: { total: sorted.length, offset, limit, links: sorted.slice(offset, offset + limit).map(view) },
      };
    }
    if (method === 'GET' && endpoint === 'history') {
      const limit = Math.min(Number(query.get('limit') ?? 10), 25);
      const beforeId = query.has('beforeId') ? Number(query.get('beforeId')) : Infinity;
      const filtered = events
        .filter((e) => e.id < beforeId)
        .filter((e) => !query.has('uuid') || e.uuid === query.get('uuid'))
        .filter((e) => !query.has('discord') || e.discordId === query.get('discord'))
        .sort((a, b) => b.id - a.id);
      const page = filtered.slice(0, limit);
      return {
        status: 200,
        data: { events: page, nextBeforeId: filtered.length > limit ? page.at(-1).id : null },
      };
    }
    if (method === 'POST' && endpoint === 'unlink') {
      if (!body.actor?.type || !body.actor?.id) return { status: 400, data: { error: 'actor_required' } };
      return unlink(body);
    }
    return { status: 404, data: { error: 'not_found' } };
  }

  const plugin = {
    instanceId,
    linkProtocol,
    calls,
    events,
    links,
    pending,
    names,
    issueCode,
    linkByDiscord,
    faults: {},
    handle(job) {
      calls.push({
        method: String(job.method ?? 'GET').toUpperCase(),
        path: String(job.path).split('?')[0],
        targetInstance: job.targetInstance ?? null,
        body: job.body ?? null,
      });
      if (job.targetInstance && job.targetInstance !== instanceId) {
        return { status: 421, data: { error: 'wrong_instance', instance: instanceId } };
      }
      const res = route(job);
      if (linkProtocol >= 2) res.data = { ...res.data, instance: instanceId };
      return res;
    },
  };
  return plugin;
}

/** Yazma yapan bağlantı uçları (bu yollara körlemesine iş gönderilmemeli). */
export const LINK_WRITE_PATHS = new Set(['/api/link/verify', '/api/link/v2/verify', '/api/link', '/api/link/v2/unlink']);

/**
 * mcapi'nin beklediği kuyruk yüzeyi. İşleri targetInstance'a göre modele
 * yönlendirir; `faults.onJob(job, plugin)` 'timeout' ya da 'apply_then_timeout'
 * döndürerek taşıma katmanı arızası üretir.
 */
export function createFakeBridge(plugins, { anonymous = false, pollers = null, faults = {} } = {}) {
  const jobs = [];
  const idOf = (plugin) => (anonymous ? `ip:${plugin.instanceId}` : plugin.instanceId);
  const byId = new Map(plugins.map((plugin) => [idOf(plugin), plugin]));
  const instances = () => plugins.map(idOf);
  const timeout = () => new Error('Minecraft sunucusuna ulaşılamadı (zaman aşımı).');

  return {
    jobs,
    pluginConnected: () => plugins.length > 0,
    activeInstances: instances,
    instanceMeta: () => plugins.map((plugin) => ({
      id: idOf(plugin), linkProtocol: anonymous ? 0 : plugin.linkProtocol, lastSeen: Date.now(),
    })),
    routingAmbiguity: () => {
      const ids = instances();
      const count = pollers ?? ids.length;
      let reason = null;
      if (ids.length > 1) reason = 'instances';
      else if (count > 1) reason = 'concurrent_pollers';
      return {
        ambiguous: reason !== null, reason, instances: ids, duplicateInstances: [], pollers: count, peakPollers: count,
      };
    },
    stats: () => ({ pollers: plugins.length, peakPollers: plugins.length, instances: plugins.length }),
    async enqueue(job) {
      jobs.push(job);
      const target = job.targetInstance ? byId.get(job.targetInstance) : plugins[0];
      if (!target) throw timeout();
      const fault = faults.onJob?.(job, target);
      if (fault === 'timeout') throw timeout();
      if (fault === 'apply_then_timeout') {
        target.handle(job);
        throw timeout();
      }
      const res = target.handle(job);
      return { ...res, claimedBy: idOf(target), claimedPollId: 'poll-test' };
    },
  };
}
