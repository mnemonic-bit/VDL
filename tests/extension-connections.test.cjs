const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const tick = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const generation = 'a'.repeat(32);
const connection = (id = 'connection-a', extras = {}) => ({ id, generation, status: 'connected', revision: '0',
    device_label: 'Firefox profile', extension_version: '1.0.3', created_at: 1800000000, last_used_at: null, ...extras });
function harness({ legacy = false, count = () => 0, serverTime } = {}) {
    const context = vm.createContext({ Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations', 'extension-connections']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    }
    const requests = [], snapshots = [], events = [], timers = new Map();
    let serial = 0, clock = 1800000000000, authLosses = 0, refreshes = 0, controller;
    controller = context.VDL.createExtensionConnections({
        now: () => clock, random: () => (++serial).toString(16).padStart(32, '0'),
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }, additionalPendingCount: count,
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })); },
        onChange() { if (controller) snapshots.push(controller.snapshot()); }, onEvent(event) { events.push(event); },
        onAuthLoss() { authLosses++; }, refresh() { refreshes++; return Promise.resolve(true); },
    });
    const capabilities = legacy ? null : { mutation_protocol: 1, extension_connection_revocation: 1,
        tag_identity_version: context.VDL.tagIdentity.version, actions: ['connection.revoke'],
        ...(serverTime === undefined ? {} : { server_time: serverTime }) };
    controller.setCapabilities(capabilities);
    function list(values = [connection()]) { return controller.acceptList(controller.beginList(), values); }
    list();
    const reply = (request, extras = {}, status = 200) => ({ status, body: {
        connection: { id: 'connection-a', generation, status: 'revoked', revision: '1' },
        mutation: { id: request.body?.client_mutation_id || decodeURIComponent(request.url.split('/').pop()),
            domain: 'extension-connection', revision: '1', outcome: 'committed' }, ...extras,
    } });
    const row = (id = 'connection-a') => controller.snapshot().connections.find(value => value.id === id);
    return { context, controller, requests, snapshots, events, timers, list, row, reply, capabilities,
        advance: value => { clock += value; }, authLosses: () => authLosses, refreshes: () => refreshes };
}
async function unknown(h) {
    h.controller.revoke('connection-a'); await tick();
    const original = h.requests.at(-1);
    original.reject(new Error('response lost')); await tick();
    const receipt = h.requests.at(-1);
    assert.equal(receipt.method, 'GET');
    receipt.resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    return original;
}

test('revocation presents synchronous status beside confirmed state and sends one request', async () => {
    const h = harness();
    assert.equal(h.controller.revoke('connection-a').accepted, true);
    assert.equal(h.row().intent.status, 'sending');
    assert.equal(h.row().connection.status, 'connected');
    assert.equal(h.row().canRevoke, false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.controller.revoke('connection-a').accepted, false);
    await tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].method, 'DELETE');
    assert.equal(h.requests[0].body.generation, generation);
    assert.equal(h.requests[0].body.expected_revision, '0');
});

test('unrelated connection stays usable and has an independent mutation boundary', async () => {
    const h = harness(); h.list([connection(), connection('connection-b', { generation: 'b'.repeat(32) })]);
    h.controller.revoke('connection-a');
    assert.equal(h.row('connection-b').canRevoke, true);
    assert.equal(h.controller.revoke('connection-b').accepted, true);
    await tick(); assert.equal(h.requests.length, 2);
    assert.notEqual(h.requests[0].body.client_mutation_id, h.requests[1].body.client_mutation_id);
});

test('canonical acknowledgement removes the exact identity without any read or SSE', async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick();
    h.requests[0].resolve(h.reply(h.requests[0])); await tick();
    assert.equal(h.row(), undefined);
    assert.equal(h.controller.pendingCount(), 0);
    assert.equal(h.requests.length, 1);
    assert.match(h.controller.snapshot().message, /Already accepted downloads follow their existing lifecycle/);
});

test('held old lists cannot restore confirmed revocation or remove a replacement identity', async () => {
    const h = harness(); const token = h.controller.beginList();
    h.controller.revoke('connection-a'); await tick(); h.requests[0].resolve(h.reply(h.requests[0])); await tick();
    assert.equal(h.controller.acceptList(token, [connection()]), false);
    h.list([connection(), connection('replacement', { generation: 'b'.repeat(32) })]);
    assert.equal(h.row(), undefined);
    assert.equal(h.row('replacement').canRevoke, true);
});

test('disappeared list row remains retained while this attempt is unresolved', async () => {
    const h = harness(); h.controller.revoke('connection-a'); h.list([]);
    assert.equal(h.row().intent.status, 'sending');
    assert.equal(h.row().device_label, 'Firefox profile');
    await tick(); assert.equal(h.requests.length, 1);
});

test('lost committed response recovers its actor receipt without another DELETE', async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick();
    h.requests[0].reject(new Error('response lost')); await tick();
    const receipt = h.requests.at(-1); receipt.resolve(h.reply(receipt)); await tick();
    assert.equal(h.row(), undefined);
    assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1);
    assert.equal(h.controller.metrics().acknowledgements, 1);
});

test('missing receipt does not establish failure or permit a fresh revocation', async () => {
    const h = harness(); await unknown(h);
    assert.equal(h.row().intent.status, 'unconfirmed');
    assert.match(h.row().intent.message, /^Revocation not confirmed/);
    assert.equal(h.controller.resolve('connection-a'), false);
    assert.equal(h.controller.revoke('connection-a').accepted, false);
    assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1);
});

test('deliberate recovery replays the same immutable attempt after a bounded receipt check', async () => {
    const h = harness(); const original = await unknown(h);
    const recovery = h.controller.recover('connection-a', true); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await recovery; await tick(); const replay = h.requests.at(-1);
    assert.equal(replay.method, 'DELETE');
    assert.equal(JSON.stringify(replay.body), JSON.stringify(original.body));
    replay.resolve(h.reply(replay)); await tick(); assert.equal(h.row(), undefined);
});

test('concurrent recovery clicks share one bounded receipt check', async () => {
    const h = harness(); await unknown(h);
    const recovery = h.controller.recover('connection-a'); await tick(); const count = h.requests.length;
    assert.equal(await h.controller.recover('connection-a', true), false);
    assert.equal(h.requests.length, count);
    h.requests.at(-1).resolve(h.reply(h.requests.at(-1))); await recovery;
    assert.equal(h.row(), undefined);
});

test('an authorized current-state read cannot confirm the request', async () => {
    const h = harness(); await unknown(h);
    const recovery = h.controller.recover('connection-a'); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    assert.equal(h.requests.at(-1).url, '/api/extension/connections/connection-a');
    h.requests.at(-1).resolve({ status: 200, body: { connection: { id: 'connection-a', generation, status: 'connected', revision: '0' } } });
    await recovery; assert.equal(h.row().intent.status, 'unconfirmed');
    assert.equal(h.controller.resolve('connection-a'), false);
});

for (const status of [200, 404]) test(`serialized expired absence permits explicit resolution after authorized ${status} state check`, async () => {
    const h = harness(); await unknown(h); h.advance(86400001);
    const recovery = h.controller.recover('connection-a', true); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests.at(-1).resolve(status === 200 ? { status, body: { connection: { id: 'connection-a', generation, status: 'connected', revision: '0' } } }
        : { status, body: { error: 'Unknown companion connection' } });
    await recovery;
    assert.equal(h.row().intent.status, 'unconfirmed');
    assert.equal(h.row().intent.canResolve, true);
    assert.equal(h.row().intent.replayExpired, true);
    assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1);
    assert.equal(h.controller.resolve('connection-a'), true);
    assert.equal(h.row() === undefined, status === 404);
    assert.match(h.controller.snapshot().message, /does not confirm/);
});

test('failed expired state check retains uncertainty and blocks explicit resolution', async () => {
    const h = harness(); await unknown(h); h.advance(86400001);
    const recovery = h.controller.recover('connection-a'); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests.at(-1).resolve({ status: 500, body: {} }); await recovery;
    assert.equal(h.row().intent.canResolve, false);
    assert.equal(h.controller.resolve('connection-a'), false);
});

for (const changed of ['mutation-id', 'domain', 'generation', 'target', 'revision', 'outcome']) test(`malformed ${changed} success remains unconfirmed`, async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick(); const request = h.requests[0], reply = h.reply(request);
    if (changed === 'mutation-id') reply.body.mutation.id = 'other';
    if (changed === 'domain') reply.body.mutation.domain = 'pairing';
    if (changed === 'generation') reply.body.connection.generation = 'b'.repeat(32);
    if (changed === 'target') reply.body.connection.id = 'other';
    if (changed === 'revision') reply.body.connection.revision = reply.body.mutation.revision = '2';
    if (changed === 'outcome') reply.body.mutation.outcome = 'accepted';
    request.resolve(reply); await tick();
    assert.equal(h.row().intent.status, 'unconfirmed');
    assert.equal(h.row().connection.status, 'connected');
});

test('definite conflict retains old identity and requires deliberate review', async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick(); const request = h.requests[0];
    const reply = h.reply(request, { connection: { id: 'connection-a', generation: 'b'.repeat(32), status: 'connected', revision: '0' } }, 409);
    reply.body.mutation.outcome = 'conflicted'; reply.body.mutation.revision = '0';
    request.resolve(reply); await tick();
    assert.equal(h.row().intent.status, 'conflicted');
    assert.equal(h.row().connection.generation, generation);
    assert.equal(h.controller.revoke('connection-a').accepted, false);
    assert.equal(h.controller.resolve('connection-a'), true);
    assert.equal(h.requests.length, 1);
});

test('definite quota refusal keeps confirmed state and retained inline error', async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick();
    h.requests[0].resolve({ status: 429, body: { error: 'Too many pending requests', code: 'mutation_limit' } }); await tick();
    assert.equal(h.row().connection.status, 'connected');
    assert.equal(h.row().intent.status, 'rejected');
    assert.match(h.row().intent.message, /Too many/);
    assert.equal(h.controller.resolve('connection-a'), true);
});

test('generic 5xx and uncorrelated missing target remain unknown', async () => {
    for (const status of [404, 500]) {
        const h = harness(); h.controller.revoke('connection-a'); await tick();
        h.requests[0].resolve({ status, body: { error: 'Unknown companion connection' } }); await tick();
        assert.equal(h.row().intent.status, 'unconfirmed');
        assert.equal(h.row().connection.status, 'connected');
    }
});

test('authentication epoch clears private rows and fences late acknowledgements and lists', async () => {
    const h = harness(); const token = h.controller.beginList(); h.controller.revoke('connection-a'); await tick();
    h.controller.reset(); h.requests[0].resolve(h.reply(h.requests[0])); await tick();
    assert.equal(h.controller.snapshot().connections.length, 0);
    assert.equal(h.controller.acceptList(token, [connection()]), false);
    assert.equal(h.controller.snapshot().message, '');
});

for (const status of [401, 403]) test(`current ${status} authorization loss clears private rows and pending state`, async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick();
    h.requests[0].resolve({ status, body: { error: 'Access denied' } }); await tick();
    assert.equal(h.controller.snapshot().connections.length, 0);
    assert.equal(h.controller.pendingCount(), 0);
    assert.equal(h.authLosses(), 1);
});

test('only allowlisted non-secret connection fields enter snapshots, receipts and diagnostics', async () => {
    const h = harness(); h.list([connection('connection-a', { token: 'bearer-secret', token_hash: 'hash-secret' })]);
    h.controller.revoke('connection-a'); await tick();
    const request = h.requests[0]; request.resolve(h.reply(request, { token: 'bearer-secret', connection: {
        id: 'connection-a', generation, status: 'revoked', revision: '1', token: 'bearer-secret' }, private_details: 'private-secret' })); await tick();
    const output = JSON.stringify([h.snapshots, h.events, h.controller.metrics(), h.requests.map(({ url, body, method }) => ({ url, body, method }))]);
    assert.ok(!output.includes('bearer-secret'));
    assert.ok(!output.includes('hash-secret'));
    assert.ok(!output.includes('private-secret'));
    assert.equal(h.row(), undefined);
});

test('shared page limits refuse admission before any request', async () => {
    const h = harness({ count: () => 128 });
    assert.equal(h.controller.revoke('connection-a').reason, 'limit');
    await tick(); assert.equal(h.requests.length, 0);
});

test('legacy pending retains row and confirms only on its existing 204 acknowledgement', async () => {
    const h = harness({ legacy: true });
    h.controller.revoke('connection-a'); assert.equal(h.row().intent.status, 'sending');
    h.list([]); assert.ok(h.row()); await tick();
    assert.equal(h.requests[0].body, undefined);
    h.requests[0].resolve({ status: 204, body: null }); await tick();
    assert.equal(h.row(), undefined); assert.equal(h.requests.length, 1);
});

test('legacy unknown never replays or claims success from disappeared list row', async () => {
    const h = harness({ legacy: true }); h.controller.revoke('connection-a'); await tick();
    h.requests[0].reject(new Error('offline')); await tick();
    h.list([]); assert.equal(h.row().intent.status, 'unconfirmed');
    assert.equal(await h.controller.recover('connection-a', true), false);
    assert.equal(await h.controller.recover('connection-a'), true);
    assert.equal(h.refreshes(), 1); assert.equal(h.requests.length, 1);
    assert.equal(h.controller.resolve('connection-a'), false);
});

test('delay and timeout timers explain uncertainty without an automatic mutation replay', async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick();
    Array.from(h.timers.values()).find(timer => timer.delay === 5000).callback();
    assert.equal(h.row().intent.delayed, true);
    Array.from(h.timers.values()).find(timer => timer.delay === 30000).callback(); await tick();
    assert.equal(h.row().intent.status, 'unconfirmed');
    assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1);
});


test('a newer authorized present list invalidates an expired absence observation', async () => {
    const h = harness(); await unknown(h); h.advance(86400001);
    const recovery = h.controller.recover('connection-a'); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Unknown companion connection' } }); await recovery;
    h.list([connection()]);
    assert.equal(h.controller.resolve('connection-a'), true);
    assert.equal(h.row().connection.status, 'connected');
    assert.match(h.controller.snapshot().message, /does not confirm/);
});

test('an unrecognized targeted 404 cannot resolve serialized expired absence', async () => {
    const h = harness(); await unknown(h); h.advance(86400001);
    const recovery = h.controller.recover('connection-a'); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests.at(-1).resolve({ status: 404, body: { error: 'Unrecognized response' } }); await recovery;
    assert.equal(h.controller.resolve('connection-a'), false);
    assert.equal(h.row().intent.status, 'unconfirmed');
});

test('receipt confirmation fences a late original acknowledgement and announces once', async () => {
    const h = harness(); h.controller.revoke('connection-a'); await tick(); const original = h.requests[0];
    Array.from(h.timers.values()).find(timer => timer.delay === 30000).callback(); await tick();
    const receipt = h.requests.at(-1); receipt.resolve(h.reply(receipt)); await tick();
    h.list([connection('replacement', { generation: 'b'.repeat(32) })]);
    original.resolve(h.reply(original)); await tick();
    assert.equal(h.row(), undefined);
    assert.equal(h.row('replacement').canRevoke, true);
    assert.equal(h.controller.metrics().acknowledgements, 1);
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
});


test('reapplying the same capability snapshot preserves calibrated time on a long-lived page', async () => {
    const serverTime = 1800000005000;
    const elapsed = 86400001;
    const h = harness({ serverTime });
    h.advance(elapsed);
    h.controller.setCapabilities(h.capabilities);
    assert.equal(h.controller.revoke('connection-a').accepted, true);
    await tick();
    const createdAt = Number(h.requests[0].body.client_mutation_id.split('-')[0]);
    assert.equal(createdAt, serverTime + elapsed);
});
