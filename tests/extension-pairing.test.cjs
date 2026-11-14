const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const tick = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const secret = 'VDL1-aaaaaaaaaaaaaaaaaaaaaa';
const pairing = (revision = '0', status = 'none', generation = null) => ({
    revision, status, generation, expires_at: generation ? 1800000300 : null,
});
function harness(legacy = false, additionalPendingCount = () => 0) {
    const context = vm.createContext({ Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations', 'extension-pairing']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    }
    const requests = [], secrets = [], snapshots = [], events = [], timers = new Map();
    let serial = 0, authLosses = 0, clearCount = 0;
    let controller;
    controller = context.VDL.createExtensionPairing({
        now: () => 1800000000000, random: () => (++serial).toString(16).padStart(32, '0'),
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })); },
        additionalPendingCount,
        onSecret(value) { secrets.push(value); }, onClearSecret() { clearCount++; },
        onChange() { if (controller) snapshots.push(controller.snapshot()); }, onEvent(event) { events.push(event); },
        onAuthLoss() { authLosses++; },
    });
    controller.setCapabilities(legacy ? null : { mutation_protocol: 1, extension_pairing: 1,
        tag_identity_version: context.VDL.tagIdentity.version, actions: ['pairing.create', 'pairing.invalidate'] });
    async function init(value = pairing()) {
        if (legacy) return;
        const refreshed = controller.refresh();
        requests.at(-1).resolve({ status: 200, body: { pairing: value } });
        await refreshed; await tick();
    }
    const reply = (request, value = pairing('1', 'available', 'generation-a'), extras = {}) => ({
        status: 201,
        body: { pairing: value, created_generation: 'generation-a', mutation: {
            id: request.body?.client_mutation_id || decodeURIComponent(request.url.split('/').pop()),
            domain: 'extension-pairing', revision: value.revision, outcome: 'committed',
        }, ...extras },
    });
    return { context, controller, requests, secrets, snapshots, events, timers, init, reply,
        authLosses: () => authLosses, clearCount: () => clearCount };
}
async function created(h) {
    await h.init(); h.controller.create(); await tick();
    const request = h.requests.at(-1); request.resolve(h.reply(request, undefined, { code: secret }));
    await tick();
}

test('pairing creation has synchronous pending state, no fabricated secret, and a single request', async () => {
    const h = harness(); await h.init();
    const count = h.requests.length;
    assert.equal(h.controller.create().accepted, true);
    assert.equal(h.requests.length, count);
    assert.equal(h.controller.snapshot().intent.kind, 'pairing.create');
    assert.equal(h.controller.snapshot().intent.status, 'sending');
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.equal(h.controller.create().accepted, false);
    assert.equal(h.controller.invalidate().accepted, false);
    await tick();
    assert.equal(h.requests.length, count + 1);
    assert.equal(h.requests.at(-1).body.expected_revision, '0');
    assert.equal(h.secrets.length, 0);
});

test('canonical acknowledgement presents secret through the private callback only', async () => {
    const h = harness(); await created(h);
    assert.equal(h.secrets[0].code, secret);
    assert.equal(h.controller.snapshot().hasSecret, true);
    assert.equal(h.controller.snapshot().intent, null);
    assert.equal(h.controller.snapshot().pairing.status, 'available');
    assert.equal(h.requests.length, 2);
    assert.ok(!JSON.stringify(h.snapshots).includes(secret));
    assert.ok(!JSON.stringify(h.events).includes(secret));
    assert.ok(!JSON.stringify(h.controller.metrics()).includes(secret));
});

test('invalidation retains confirmed availability and secret until acknowledgement', async () => {
    const h = harness(); await created(h);
    assert.equal(h.controller.invalidate().accepted, true);
    const model = h.controller.snapshot();
    assert.equal(model.pairing.status, 'available');
    assert.equal(model.hasSecret, true);
    assert.equal(model.intent.kind, 'pairing.invalidate');
    assert.equal(h.controller.create().accepted, false);
    assert.equal(h.controller.invalidate().accepted, false);
    await tick();
    const request = h.requests.at(-1);
    assert.equal(request.body.generation, 'generation-a');
    request.resolve(h.reply(request, pairing('2', 'invalidated', 'generation-a')));
    await tick();
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.equal(h.controller.snapshot().message, 'Pairing string invalidated.');
    assert.equal(h.controller.snapshot().canCreate, true);
});

test('closing before creation response prevents late credential presentation and requires explicit invalidation', async () => {
    const h = harness(); await h.init();
    h.controller.create(); await tick(); h.controller.close();
    const request = h.requests.at(-1); request.resolve(h.reply(request, undefined, { code: secret }));
    await tick();
    assert.equal(h.secrets.length, 0);
    assert.equal(h.controller.snapshot().canCreate, false);
    assert.equal(h.controller.snapshot().canInvalidate, true);
    assert.match(h.controller.snapshot().message, /cannot be recovered/);
});

test('close after success clears code and replaces copy instructions', async () => {
    const h = harness(); await created(h); h.controller.close();
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.match(h.controller.snapshot().message, /cannot be recovered/);
    assert.equal(h.controller.create().accepted, false);
});

test('authentication reset fences creation callbacks and clears secret state', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    const request = h.requests.at(-1); h.controller.reset();
    request.resolve(h.reply(request, undefined, { code: secret })); await tick();
    assert.equal(h.secrets.length, 0);
    assert.equal(h.controller.snapshot().pairing, null);
    assert.equal(h.controller.snapshot().intent, null);
});

test('lost committed creation recovers only non-secret status and does not mint another code', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    h.requests.at(-1).reject(new Error('response lost')); await tick();
    assert.equal(h.requests.at(-1).method, 'GET');
    const receipt = h.requests.at(-1); receipt.resolve(h.reply(receipt)); await tick();
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(h.secrets.length, 0);
    assert.match(h.controller.snapshot().message, /cannot be recovered/);
    assert.equal(h.controller.snapshot().canCreate, false);
    assert.equal(h.controller.invalidate().accepted, true);
    await tick();
    const invalidation = h.requests.at(-1);
    invalidation.resolve(h.reply(invalidation, pairing('2', 'invalidated', 'generation-a'))); await tick();
    assert.equal(h.controller.snapshot().canCreate, true);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(h.controller.create().accepted, true);
});

test('missing receipt remains ambiguous and deliberate replay freezes the attempt', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    const original = h.requests.at(-1);
    original.reject(new Error('offline')); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    assert.equal(h.controller.snapshot().intent.status, 'unconfirmed');
    assert.equal(h.controller.resolve(), false);
    const recovery = h.controller.recover(true); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await recovery; await tick();
    const replay = h.requests.at(-1);
    assert.equal(replay.method, 'POST');
    assert.equal(JSON.stringify(replay.body), JSON.stringify(original.body));
    replay.resolve(h.reply(replay)); await tick();
    assert.equal(h.secrets.length, 0);
    assert.equal(h.controller.snapshot().canCreate, false);
});

test('malformed success never preserves its credential for later receipt recovery', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    const request = h.requests.at(-1);
    request.resolve(h.reply(request, undefined, { code: secret, mutation: {
        id: request.body.client_mutation_id, domain: 'wrong', revision: '1', outcome: 'committed',
    } })); await tick();
    assert.equal(h.controller.snapshot().intent.status, 'unconfirmed');
    const receipt = h.requests.at(-1); receipt.resolve(h.reply(receipt)); await tick();
    assert.equal(h.secrets.length, 0);
    assert.match(h.controller.snapshot().message, /cannot be recovered/);
});

test('remote replacement clears displayed secret and old generation recovery binding', async () => {
    const h = harness(); await created(h);
    const refresh = h.controller.refresh();
    h.requests.at(-1).resolve({ status: 200, body: { pairing: pairing('2', 'available', 'generation-b') } });
    await refresh;
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.equal(h.controller.snapshot().recoveryGeneration, null);
    assert.equal(h.controller.invalidate().accepted, true); await tick();
    assert.equal(h.requests.at(-1).body.generation, 'generation-b');
});

test('conflicting invalidation keeps replacement generation and clears stale code', async () => {
    const h = harness(); await created(h); h.controller.invalidate(); await tick();
    const request = h.requests.at(-1);
    const response = h.reply(request, pairing('2', 'available', 'generation-b'));
    response.status = 409; response.body.mutation.outcome = 'conflicted'; delete response.body.created_generation;
    request.resolve(response); await tick();
    assert.equal(h.controller.snapshot().pairing.generation, 'generation-b');
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.equal(h.controller.snapshot().intent.status, 'conflicted');
    assert.ok(!h.controller.snapshot().message.includes('invalidated'));
    assert.equal(h.controller.resolve(), true);
});

test('stale refresh cannot replace acknowledged pairing generation or erase its secret', async () => {
    const h = harness(); await created(h);
    const refreshed = h.controller.refresh();
    h.requests.at(-1).resolve({ status: 200, body: { pairing: pairing() } }); await refreshed;
    assert.equal(h.controller.snapshot().pairing.generation, 'generation-a');
    assert.equal(h.controller.snapshot().hasSecret, true);
});

test('five seconds adds explanatory waiting and thirty seconds retains uncertainty', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    const delayed = [...h.timers.values()].find(timer => timer.delay === 5000); delayed.callback();
    assert.equal(h.controller.snapshot().intent.delayed, true);
    assert.equal(h.controller.snapshot().intent.status, 'sending');
    const timeout = [...h.timers.values()].find(timer => timer.delay === 30000); timeout.callback(); await tick();
    assert.equal(h.controller.snapshot().intent.status, 'unconfirmed');
    assert.match(h.controller.snapshot().intent.message, /Pairing request not confirmed/);
});

test('recovery authorization loss clears secret and fences original request', async () => {
    const h = harness(); await created(h); h.controller.invalidate(); await tick();
    h.requests.at(-1).reject(new Error('response lost')); await tick();
    h.requests.at(-1).resolve({ status: 403, body: { error: 'Access denied' } }); await tick();
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.equal(h.controller.snapshot().pairing, null);
    assert.equal(h.authLosses(), 1);
});

test('unsupported server retains legacy creation without capability-dependent payload', async () => {
    const h = harness(true); h.controller.create(); await tick();
    const request = h.requests.at(-1);
    assert.equal(request.body, undefined);
    request.resolve({ status: 201, body: { code: secret, expires_at: 1800000300 } }); await tick();
    assert.equal(h.secrets.length, 1);
    assert.equal(h.controller.snapshot().hasSecret, true);
    assert.equal(h.controller.invalidate().accepted, true); await tick();
    h.requests.at(-1).resolve({ status: 204, body: null }); await tick();
    assert.equal(h.controller.snapshot().message, 'Pairing string invalidated.');
});

test('legacy lost response remains unknown with no automatic check or replay', async () => {
    const h = harness(true); h.controller.create(); await tick();
    h.requests.at(-1).reject(new Error('offline')); await tick();
    assert.equal(h.controller.snapshot().intent.status, 'unconfirmed');
    assert.match(h.controller.snapshot().intent.message, /Pairing request not confirmed/);
    assert.equal(h.requests.length, 1);
    assert.equal(await h.controller.recover(true), false);
    assert.equal(h.controller.create().accepted, false);
    assert.equal(h.controller.resolve(), false);
});

test('legacy definite refusal can be resolved before a deliberate new creation', async () => {
    const h = harness(true); h.controller.create(); await tick();
    h.requests.at(-1).resolve({ status: 429, body: { error: 'Try again later' } }); await tick();
    assert.equal(h.controller.snapshot().intent.status, 'rejected');
    assert.match(h.controller.snapshot().intent.message, /Try again later/);
    assert.equal(h.controller.resolve(), true);
    assert.equal(h.controller.create().accepted, true);
});


test('page-wide admission includes edits owned by the other coordinator', async () => {
    const h = harness(false, () => 128); await h.init();
    const count = h.requests.length;
    assert.equal(h.controller.create().reason, 'limit');
    await tick();
    assert.equal(h.requests.length, count);
    assert.equal(h.controller.snapshot().intent, null);
});

test('legacy admission also respects the page-wide pending limit', async () => {
    const h = harness(true, () => 128);
    assert.equal(h.controller.create().reason, 'limit');
    await tick();
    assert.equal(h.requests.length, 0);
});

test('expiration clears presentation without inventing a revoked server status', async () => {
    const h = harness(); await created(h); h.controller.expire();
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.equal(h.controller.snapshot().message, '');
    assert.equal(h.controller.snapshot().pairing.status, 'available');
    assert.equal(h.controller.snapshot().canCreate, false);
});

test('bounded diagnostic totals include receipt reads without credential or generation content', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    h.requests.at(-1).reject(new Error('lost')); await tick();
    const receipt = h.requests.at(-1); receipt.resolve(h.reply(receipt)); await tick();
    const metrics = h.controller.metrics();
    assert.equal(metrics.submissions, 1);
    assert.equal(metrics.acknowledgements, 1);
    assert.equal(metrics.unconfirmedOutcomes, 1);
    assert.equal(metrics.reconciliationReads, 2);
    assert.equal(metrics.pending, 0);
    assert.ok(!JSON.stringify(metrics).includes(secret));
    assert.ok(!JSON.stringify(metrics).includes('generation-a'));
});


test('late original creation after receipt confirmation cannot restore a closed secret view', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    const original = h.requests.at(-1);
    const timeout = [...h.timers.values()].find(timer => timer.delay === 30000); timeout.callback(); await tick();
    const receipt = h.requests.at(-1); receipt.resolve(h.reply(receipt)); await tick();
    h.controller.close();
    original.resolve(h.reply(original, undefined, { code: secret })); await tick();
    assert.equal(h.secrets.length, 0);
    assert.equal(h.controller.snapshot().hasSecret, false);
    assert.equal(h.controller.snapshot().intent, null);
    assert.equal(h.controller.snapshot().canCreate, false);
    assert.ok(!JSON.stringify(h.snapshots).includes(secret));
    assert.equal(h.controller.invalidate().accepted, true); await tick();
    const request = h.requests.at(-1); request.resolve(h.reply(request, pairing('2', 'invalidated', 'generation-a'))); await tick();
    assert.equal(h.secrets.length, 0);
});


test('late creation response cannot change the invalidation generation after replacement', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    const original = h.requests.at(-1);
    [...h.timers.values()].find(timer => timer.delay === 30000).callback(); await tick();
    const receipt = h.requests.at(-1); receipt.resolve(h.reply(receipt)); await tick();
    assert.equal(h.controller.invalidate().accepted, true); await tick();
    const invalidateA = h.requests.at(-1);
    invalidateA.resolve(h.reply(invalidateA, pairing('2', 'invalidated', 'generation-a'))); await tick();
    assert.equal(h.controller.create().accepted, true); await tick();
    const createB = h.requests.at(-1);
    createB.resolve(h.reply(createB, pairing('3', 'available', 'generation-b'), {
        code: 'VDL1-bbbbbbbbbbbbbbbbbbbbbb', created_generation: 'generation-b',
    })); await tick();
    assert.equal(h.controller.snapshot().recoveryGeneration, 'generation-b');
    original.resolve(h.reply(original, undefined, { code: secret })); await tick();
    assert.equal(h.controller.snapshot().pairing.generation, 'generation-b');
    assert.equal(h.controller.snapshot().recoveryGeneration, 'generation-b');
    assert.equal(h.controller.invalidate().accepted, true); await tick();
    assert.equal(h.requests.at(-1).body.generation, 'generation-b');
    assert.equal(h.secrets.length, 1);
    assert.equal(h.secrets[0].code, 'VDL1-bbbbbbbbbbbbbbbbbbbbbb');
});


test('resolving unknown creation from a current-state read retains explicit invalidation requirement', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    h.requests.at(-1).reject(new Error('response lost')); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    const checking = h.controller.recover(); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    assert.equal(h.requests.at(-1).url, '/api/extension/pairing-codes/current');
    h.requests.at(-1).resolve({ status: 200, body: { pairing: pairing('1', 'available', 'generation-a') } });
    await checking; await tick();
    assert.equal(h.controller.snapshot().intent.status, 'unconfirmed');
    assert.equal(h.controller.resolve(), true);
    assert.equal(h.controller.snapshot().canCreate, false);
    assert.equal(h.controller.create().accepted, false);
    assert.equal(h.controller.snapshot().recoveryGeneration, 'generation-a');
    assert.equal(h.controller.invalidate().accepted, true); await tick();
    assert.equal(h.requests.at(-1).body.generation, 'generation-a');
});

test('expired receipt absence cannot release pairing until an authorized current-state check succeeds', async () => {
    const h = harness(); await h.init(); h.controller.create(); await tick();
    h.requests.at(-1).reject(new Error('response lost')); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    assert.equal(h.requests.at(-1).url, '/api/extension/pairing-codes/current');
    assert.equal(h.controller.resolve(), false);
    h.requests.at(-1).resolve({ status: 500, body: null }); await tick();
    assert.equal(h.controller.resolve(), false);
    const checking = h.controller.recover(); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests.at(-1).resolve({ status: 200, body: { pairing: pairing() } });
    await checking; await tick();
    assert.equal(h.controller.resolve(), true);
    assert.equal(h.controller.snapshot().canCreate, true);
});


test('expiration performs one bounded status read and releases creation after confirmed server expiry', async () => {
    const h = harness(); await created(h);
    const count = h.requests.length;
    const expiry = h.controller.expire();
    assert.equal(h.requests.length, count + 1);
    assert.equal(h.requests.at(-1).url, '/api/extension/pairing-codes/current');
    assert.equal(h.controller.snapshot().checking, true);
    assert.equal(h.controller.snapshot().canCreate, false);
    assert.equal(h.controller.snapshot().pairing.status, 'available');
    assert.equal(h.controller.snapshot().message, '');
    h.requests.at(-1).resolve({ status: 200, body: { pairing: pairing('2', 'expired', 'generation-a') } });
    await expiry; await tick();
    assert.equal(h.controller.snapshot().pairing.status, 'expired');
    assert.equal(h.controller.snapshot().recoveryGeneration, null);
    assert.equal(h.controller.snapshot().canCreate, true);
    assert.equal(h.requests.length, count + 1);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('a local expiry does not claim server expiry while the code remains available', async () => {
    const h = harness(); await created(h);
    const expiry = h.controller.expire();
    h.requests.at(-1).resolve({ status: 200, body: { pairing: pairing('1', 'available', 'generation-a') } });
    await expiry; await tick();
    assert.equal(h.controller.snapshot().pairing.status, 'available');
    assert.equal(h.controller.snapshot().message, '');
    assert.equal(h.controller.snapshot().canCreate, false);
    assert.equal(h.controller.snapshot().canInvalidate, true);
    assert.equal(h.controller.snapshot().hasSecret, false);
});
