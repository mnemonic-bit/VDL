const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function harness() {
    const context = vm.createContext({ setTimeout, clearTimeout, Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    }
    const state = context.VDL.createClientState();
    const defaults = Object.fromEntries(context.VDL.preferenceFields.map(key => [key, 'original']));
    const values = extra => ({ ...defaults, ...extra });
    const snapshot = (revision = '1', extra = {}) => ({ id: 'installation', values: values(extra), preferences_revision: revision });
    state.acceptPreferences(snapshot());
    let clock = 1800000000000;
    let sequence = 0;
    const timers = new Map();
    const requests = [];
    const events = [];
    const notices = [];
    let authLoss = 0;
    const capabilities = { mutation_protocol: 1, actions: ['preference.set', 'favorite.set'], server_time: clock };
    const mutations = context.VDL.createMutations({
        state, capabilities,
        now: () => clock,
        random: () => (++sequence).toString(16).padStart(32, '0'),
        setTimeout(callback, delay) { const timer = { callback, at: clock + delay }; timers.set(timer, timer); return timer; },
        clearTimeout(timer) { timers.delete(timer); },
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })); },
        onEvent: event => events.push(event), onNotice: event => notices.push(event),
        onAuthLoss() { authLoss++; },
    });
    function reply(request, outcome = 'committed', revision = '2', extra = {}) {
        return { status: outcome === 'committed' ? 200 : outcome === 'conflicted' ? 409 : 400,
            body: { ...snapshot(revision, extra),
                mutation: { id: request.body.client_mutation_id, domain: 'preferences', outcome, revision } } };
    }
    return { state, mutations, requests, events, notices, values, snapshot, reply, capabilities,
        authLoss: () => authLoss,
        submit: extra => mutations.submit({ kind: 'preference.set', targetId: 'installation', value: values(extra) }),
        advance(ms) { clock += ms; for (const [key, timer] of [...timers]) if (timer.at <= clock) { timers.delete(key); timer.callback(); } },
    };
}

test('settings pending presentation is immediate and keeps all sensitive values confirmed', async () => {
    const h = harness();
    const first = h.submit({ theme: 'dark', download_dir: '/new', player_mode: 'new' });
    assert.equal(first.accepted, true);
    assert.equal(h.state.selectPreferences().preference_intents[0].status, 'sending');
    assert.equal(h.state.selectPreferences().values.theme, 'original');
    assert.equal(h.state.selectPreferences().values.download_dir, 'original');
    assert.equal(h.state.selectPreferences().values.player_mode, 'original');
    assert.equal(h.requests.length, 0);
    assert.deepEqual(plain(h.state.selectPreferences().tag_chips), []);
    await tick();
    assert.equal(h.requests[0].url, '/api/preferences');
    assert.equal(h.requests[0].body.expected_revision, '1');
    h.mutations.reset();
});

test('duplicate submissions reuse an intent while newer drafts must await explicit resolution', async () => {
    const h = harness();
    const first = h.submit({ theme: 'dark' });
    assert.equal(h.submit({ theme: 'dark' }).intentId, first.intentId);
    assert.equal(h.submit({ theme: 'light' }).reason, 'unresolved');
    await tick();
    assert.equal(h.requests.length, 1);
    h.mutations.reset();
});

test('admission copies mutable forms and replay retains the complete frozen original attempt', async () => {
    const h = harness();
    const value = h.values({ theme: 'dark' });
    const first = h.mutations.submit({ kind: 'preference.set', targetId: 'installation', value });
    value.theme = 'newer draft';
    await tick();
    const original = plain(h.requests[0].body);
    assert.equal(original.values.theme, 'dark');
    h.requests[0].reject(new Error('response lost'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.mutations.resolve(first.intentId), false);
    const replay = h.mutations.recover(first.intentId, { replay: true });
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await replay;
    await tick();
    assert.deepEqual(plain(h.requests[3].body), original);
    h.mutations.reset();
});

test('canonical normalization confirms atomically without SSE or collection reads', async () => {
    const h = harness();
    const first = h.submit({ max_concurrent: '002' });
    const frames = [];
    h.state.subscribe(ids => frames.push({ ids: plain(ids), model: plain(h.state.selectPreferences()) }));
    await tick();
    frames.length = 0;
    h.requests[0].resolve(h.reply(h.requests[0], 'committed', '2', { max_concurrent: '2' }));
    await tick();
    assert.equal(h.state.selectPreferences().values.max_concurrent, '2');
    assert.equal(h.mutations.status(first.intentId), null);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].ids, ['installation']);
    assert.equal(frames[0].model.preference_intents.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.events.at(-1).outcome, 'confirmed');
    h.mutations.reset();
});

test('newer snapshots win over older acknowledgements and stale loads cannot regress values', async () => {
    const h = harness();
    h.submit({ theme: 'dark' });
    await tick();
    h.state.acceptPreferences(h.snapshot('10', { theme: 'remote' }));
    h.requests[0].resolve(h.reply(h.requests[0], 'committed', '2', { theme: 'dark' }));
    await tick();
    assert.equal(h.state.selectPreferences().values.theme, 'remote');
    assert.equal(h.state.selectPreferences().preferences_revision, '10');
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.notices.length, 1);
    h.state.acceptPreferences(h.snapshot('9'));
    assert.equal(h.state.selectPreferences().values.theme, 'remote');
    assert.equal(h.state.acceptPreferences(h.snapshot('10', { theme: 'mismatch' })), false);
    h.mutations.reset();
});

test('canonical values compare by field instead of object property insertion order', () => {
    const h = harness();
    const reordered = h.snapshot();
    reordered.values = Object.fromEntries(Object.entries(reordered.values).reverse());
    assert.equal(h.state.acceptPreferences(reordered), true);
    const model = h.state.selectPreferences();
    assert.equal(Object.isFrozen(model.values), true);
    model.values.theme = 'corrupt';
    assert.equal(h.state.selectPreferences().values.theme, 'original');
    h.mutations.reset();
});

test('definite validation failure retains submitted values and field errors without applying them', async () => {
    const h = harness();
    const first = h.submit({ max_concurrent: 'invalid' });
    await tick();
    const reply = h.reply(h.requests[0], 'rejected', '1');
    reply.body.error = 'Total limit must be positive';
    reply.body.field_errors = { max_concurrent: 'Must be positive', unknown: 'ignored' };
    h.requests[0].resolve(reply);
    await tick();
    const status = h.mutations.status(first.intentId);
    assert.equal(status.status, 'rejected');
    assert.equal(status.value.max_concurrent, 'invalid');
    assert.deepEqual(plain(status.fieldErrors), { max_concurrent: 'Must be positive' });
    assert.match(status.message, /Total limit/);
    assert.equal(h.state.selectPreferences().values.max_concurrent, 'original');
    assert.equal(h.mutations.resolve(first.intentId), true);
    assert.equal(h.submit({ max_concurrent: '3' }).accepted, true);
    h.mutations.reset();
});

test('conflict requires review and a fresh explicit save instead of retrying a stale whole form', async () => {
    const h = harness();
    const first = h.submit({ theme: 'dark' });
    await tick();
    const originalId = h.requests[0].body.client_mutation_id;
    h.requests[0].resolve(h.reply(h.requests[0], 'conflicted', '7', { download_dir: '/remote' }));
    await tick();
    assert.equal(h.state.selectPreferences().values.download_dir, '/remote');
    assert.equal(h.state.selectPreferences().preference_intents[0].value.theme, 'dark');
    assert.equal(h.mutations.retry(first.intentId).reason, 'review_required');
    await tick();
    assert.equal(h.requests.length, 1);
    h.mutations.resolve(first.intentId);
    h.submit({ theme: 'dark', download_dir: '/remote' });
    await tick();
    assert.equal(h.requests[1].body.expected_revision, '7');
    assert.notEqual(h.requests[1].body.client_mutation_id, originalId);
    h.mutations.reset();
});

test('malformed acknowledgements and generic server errors remain unknown with bounded read recovery', async () => {
    for (const corrupt of [
        reply => { delete reply.body.values.download_dir; },
        reply => { reply.body.values.extra = 'unexpected'; },
        reply => { reply.body.preferences_revision = '3'; },
        reply => { reply.body.id = 'another-user'; },
        reply => { reply.body.mutation.domain = 'tags'; },
        reply => { reply.status = 500; reply.body = {}; },
    ]) {
        const h = harness();
        const first = h.submit({ theme: 'dark' });
        await tick();
        const reply = h.reply(h.requests[0]);
        corrupt(reply);
        h.requests[0].resolve(reply);
        await tick();
        assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
        assert.equal(h.state.selectPreferences().values.theme, 'original');
        assert.equal(h.requests[1].method, 'GET');
        h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
        await tick();
        assert.equal(h.requests.length, 2);
        h.mutations.reset();
    }
});

test('receipt recovery confirms a lost response without ever retrying the mutation automatically', async () => {
    const h = harness();
    const first = h.submit({ theme: 'dark' });
    await tick();
    h.requests[0].reject(new Error('lost response'));
    await tick();
    assert.match(h.requests[1].url, /^\/api\/mutations\//);
    h.requests[1].resolve(h.reply(h.requests[0], 'committed', '2', { theme: 'dark' }));
    await tick();
    assert.equal(h.mutations.status(first.intentId), null);
    assert.equal(h.state.selectPreferences().values.theme, 'dark');
    assert.equal(h.requests.length, 2);
    h.mutations.reset();
});

test('ordinary matching state does not prove unknown finality but a newer revision fences the conditional write', async () => {
    const h = harness();
    const first = h.submit({ theme: 'dark' });
    await tick();
    h.requests[0].reject(new Error('lost'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.mutations.resolve(first.intentId), false);
    const checking = h.mutations.recover(first.intentId);
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.requests[3].url, '/api/preferences');
    h.requests[3].resolve({ status: 200, body: h.snapshot('2', { theme: 'dark' }) });
    await checking;
    assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
    assert.equal(h.mutations.resolve(first.intentId), true);
    h.mutations.reset();
});

test('serialized expired missing receipt releases an unknown save without claiming success', async () => {
    const h = harness();
    const first = h.submit({ theme: 'dark' });
    await tick();
    h.requests[0].reject(new Error('lost'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } });
    await tick();
    assert.equal(h.mutations.resolve(first.intentId), true);
    assert.equal(h.state.selectPreferences().values.theme, 'original');
    h.mutations.reset();
});

test('auth reset and permission loss clear settings work before old responses can revive it', async () => {
    for (const reset of ['reset', '401', '403']) {
        const h = harness();
        const token = h.state.capture();
        h.submit({ download_dir: '/private' });
        await tick();
        if (reset === 'reset') h.mutations.reset();
        else { h.requests[0].resolve({ status: Number(reset), body: {} }); await tick(); }
        h.requests[0].resolve(h.reply(h.requests[0], 'committed', '2', { download_dir: '/private' }));
        await tick();
        assert.equal(h.state.selectPreferences(), null);
        assert.equal(h.mutations.pending().length, 0);
        if (reset !== '403') assert.equal(h.state.acceptPreferences(h.snapshot('3'), token), false);
        if (reset === '401') assert.equal(h.authLoss(), 1);
        h.mutations.reset();
    }
});

test('settings saves keep unrelated entry domains usable and never assume another scope', async () => {
    const h = harness();
    h.state.acceptDownload({ id: 'entry', favorite: false, favorite_revision: '0' });
    h.submit({ theme: 'dark' });
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'entry', value: true }).accepted, true);
    assert.equal(h.mutations.submit({ kind: 'preference.set', targetId: 'another-user', value: h.values() }).reason, 'unavailable');
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].url, '/api/favorite/entry');
    h.mutations.reset();
});

test('five second explanation and timeout never apply sensitive settings or announce confirmation', async () => {
    const h = harness();
    const first = h.submit({ download_dir: '/private' });
    await tick();
    h.advance(5000);
    assert.equal(h.mutations.status(first.intentId).delayed, true);
    assert.match(h.mutations.status(first.intentId).message, /Still waiting/);
    h.advance(25000);
    assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
    assert.equal(h.state.selectPreferences().values.download_dir, 'original');
    assert.doesNotMatch(JSON.stringify(h.events), /\/private|api\/preferences|download_dir/);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    h.mutations.reset();
});

test('unsupported protocol and incomplete forms cannot manufacture settings revisions or writes', async () => {
    const h = harness();
    const incomplete = h.values();
    delete incomplete.theme;
    assert.equal(h.mutations.submit({ kind: 'preference.set', targetId: 'installation', value: incomplete }).reason, 'validation');
    h.mutations.setCapabilities({ ...h.capabilities, actions: [] });
    assert.equal(h.submit({ theme: 'dark' }).reason, 'unsupported');
    assert.equal(h.state.acceptPreferences({ values: h.values() }), true);
    assert.equal(h.state.selectPreferences().preferences_revision, '1');
    await tick();
    assert.equal(h.requests.length, 0);
    h.mutations.reset();
});
