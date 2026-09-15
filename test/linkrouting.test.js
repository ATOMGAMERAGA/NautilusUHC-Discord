import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Kod kapsamı + hedef planı. Kapsam vektörleri plugin-patch/test/LinkScopeTest.java
 * ile BİREBİR aynıdır: plugin ve bot farklı hesaplarsa doğrulama hiçbir sunucuya
 * gidemez; iki taraf da ayrıca kilitlenir.
 */

const {
  linkScope, isScopedCode, codeScope, planLinkTargets,
} = await import('../src/linkrouting.js');

const VECTORS = {
  '': '6S',
  'mc-live': '9D',
  'mc-canli': 'ZX',
  'mc-test': '4S',
  'auto-1a2b3c4d': 'RP',
  'Türkçe-İd': 'EG',
  'mc-b': 'UN',
  'mc-a-559': 'UN',
};

const reverse = (instanceMeta, routing = {}) => ({
  ok: true, transport: 'reverse', instances: instanceMeta.map((m) => m.id), instanceMeta, routing,
});
const v2 = (id) => ({ id, linkProtocol: 2 });
const v1 = (id) => ({ id, linkProtocol: 0 });

test('kapsam vektörleri plugin LinkScope ile aynıdır', () => {
  for (const [id, scope] of Object.entries(VECTORS)) {
    assert.equal(linkScope(id), scope, `${JSON.stringify(id)} kapsamı`);
  }
  assert.equal(linkScope('  mc-live '), '9D', 'kimlik kırpılarak hesaplanır');
});

test('yalnız 8 karakterli geçerli alfabe kodu kapsamlıdır', () => {
  assert.equal(isScopedCode('9DK7QX4M'), true);
  assert.equal(codeScope('9DK7QX4M'), '9D');
  assert.equal(isScopedCode('K7QX4M'), false, 'eski 6 karakterli kod');
  assert.equal(isScopedCode('9DK7QX4O'), false, 'O alfabede yok');
  assert.equal(isScopedCode('9dk7qx4m'), false, 'normalize edilmemiş kod');
  assert.equal(codeScope('A1B2C3'), null);
});

test('doğrudan HTTP (eski) modu tek hedeftir', () => {
  assert.deepEqual(planLinkTargets({ ok: true, transport: 'direct' }, 'K7QX4M'),
    { ok: true, mode: 'direct', targets: [{ id: null, linkProtocol: 0 }] });
});

test('aynı/anonim kimlikli eşzamanlı yoklamalar reddedilir', () => {
  for (const reason of ['concurrent_pollers', 'duplicate_instance']) {
    const plan = planLinkTargets(reverse([v2('mc-live')], { reason }), 'K7QX4M');
    assert.equal(plan.ok, false);
    assert.equal(plan.errorCode, 'multiple_plugin_instances');
  }
});

test('tek instance: eski ya da yeni plugin, anonim ya da açık kimlik — doğrudan hedef', () => {
  assert.deepEqual(planLinkTargets(reverse([v1('ip:10.0.0.9')]), 'K7QX4M').targets, [{ id: null, linkProtocol: 0 }]);
  assert.deepEqual(planLinkTargets(reverse([v2('mc-live')]), '4SK7QX4M').targets, [{ id: 'mc-live', linkProtocol: 2 }],
    'tek depo belirsiz değildir; kapsam uyuşmasa da doğrulama o depoda yapılır');
});

test('çoklu instance: kapsamlı kod yalnız aynı kapsamdaki sunucuya gider', () => {
  const plan = planLinkTargets(reverse([v2('mc-live'), v2('mc-test')]), '4SK7QX4M');
  assert.equal(plan.mode, 'scoped');
  assert.deepEqual(plan.targets.map((t) => t.id), ['mc-test']);
});

test('çoklu instance: aynı kapsamı paylaşan sunucular salt-okunur yoklanır', () => {
  const plan = planLinkTargets(reverse([v2('mc-b'), v2('mc-a-559'), v2('mc-live')]), 'UNK7QX4M');
  assert.equal(plan.mode, 'probe');
  assert.deepEqual(plan.targets.map((t) => t.id).sort(), ['mc-a-559', 'mc-b']);
});

test('çoklu instance: kapsamsız kod tüm protokol 2 sunucularda yoklanır', () => {
  const plan = planLinkTargets(reverse([v2('mc-live'), v2('mc-test')]), 'K7QX4M');
  assert.equal(plan.mode, 'probe');
  assert.equal(plan.targets.length, 2);
});

test('çoklu instance: kapsamı hiçbir sunucuya uymayan kod da yoklanır (instance-id değişmiş olabilir)', () => {
  const plan = planLinkTargets(reverse([v2('mc-live'), v2('mc-test')]), 'ZXK7QX4M');
  assert.equal(plan.mode, 'probe');
  assert.equal(plan.targets.length, 2);
});

test('çoklu instance: eski plugin ya da anonim kimlik varsa sahiplik kanıtlanamaz', () => {
  assert.equal(planLinkTargets(reverse([v2('mc-live'), v1('mc-eski')]), 'K7QX4M').errorCode, 'multiple_plugin_instances');
  assert.equal(planLinkTargets(reverse([v2('mc-live'), v1('ip:1.2.3.4')]), '9DK7QX4M').errorCode, 'multiple_plugin_instances');
});
