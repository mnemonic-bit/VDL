const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(enabled = true, overrides = {}) {
    const context = vm.createContext({ Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    for (const scope of ['history', 'library']) state.acceptBulkPreview(scope, { scope_id: `${scope}-scope`, revision: '0' });
    state.acceptDownload({ id: 'video-a', title: 'Confirmed title', filename: 'a.mp4', status: 'finished' });
    let now = 1800000000000;
    let random = 0;
    const timers = new Map();
    const requests = [];
    const events = [];
    const mutations = context.VDL.createMutations({ state, now: () => now, random: () => (++random).toString(16).padStart(32, '0'),
        capabilities: { mutation_protocol: 1, bulk_clear: enabled ? 1 : 0, actions: ['history.clear', 'library.clear'], server_time: now },
        setTimeout(callback, delay) { const id = {}; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        onEvent(event) { events.push(plain(event)); },
        ...overrides,
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...plain(request), resolve, reject })); },
    });
    const submit = (scope = 'history', value = null) => mutations.submit({ kind: `${scope}.clear`, targetId: `bulk:${scope}`, value: value || { scope_id: `${scope}-scope`, revision: '0', entries: 2 } });
    function ack(request, outcome = 'committed', overrides = {}) {
        const scope = request.url.includes('library') ? 'library' : 'history';
        return { status: ['rejected', 'conflicted'].includes(outcome) ? 409 : 200, body: { scope, scope_id: request.body.scope_id, operation_id: request.body.scope_id, revision: '1', total: 2, removed: 2, removed_ids: scope === 'history' ? ['attempt-a', 'attempt-b'] : ['video-a', 'video-b'], files_deleted: scope === 'library' ? 1 : 0, retained: 0, failed: 0, pending: 0,
            mutation: { id: request.body.client_mutation_id, entity_id: scope, domain: 'bulk-clear', action: `${scope}.clear`, outcome, revision: '1' }, ...overrides } };
    }
    const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
    return { state, mutations, requests, events, submit, ack, advance };
}

for (const scope of ['history', 'library']) test(`${scope} clear retains confirmed state and reports pending before transport`, async () => {
    const h = harness(); const result = h.submit(scope);
    assert.equal(result.accepted, true); assert.equal(h.requests.length, 0);
    const pending = h.state.selectDownload(`bulk:${scope}`).bulk_intents[0];
    assert.equal(pending.status, 'sending'); assert.equal(pending.kind, `${scope}.clear`);
    assert.equal(h.state.selectDownload('video-a').filename, 'a.mp4');
    await tick(); assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, scope === 'history' ? '/api/clear' : '/api/library/clear');
    assert.deepEqual(h.requests[0].body, { scope_id: `${scope}-scope`, expected_revision: '0', client_mutation_id: h.requests[0].body.client_mutation_id });
    h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.state.selectDownload(`bulk:${scope}`).bulk_revision, '1');
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
    assert.equal(h.requests.length, 1);
});

test('captured preview is immutable; duplicate clear guards scope while history and library stay independent', async () => {
    const h = harness(); const value = { scope_id: 'history-scope', revision: '0', entries: 2 };
    const first = h.submit('history', value); value.scope_id = 'changed';
    assert.equal(h.submit().intentId, first.intentId);
    assert.equal(h.submit('history', value).accepted, false);
    assert.equal(h.submit('library').accepted, true);
    await tick(); assert.equal(h.requests.length, 2); assert.equal(h.requests[0].body.scope_id, 'history-scope');
});

test('matching collection state never confirms an unknown clear or permits a fresh destructive operation', async () => {
    const h = harness(); const result = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.state.acceptDownload({ id: 'bulk:history', bulk_scope: 'history-scope', bulk_revision: '9' });
    assert.equal(h.mutations.status(result.intentId).status, 'unconfirmed');
    assert.equal(h.mutations.resolve(result.intentId), false);
    assert.equal(h.submit().intentId, result.intentId);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('a lost response confirms through its authorized receipt without automatically replaying the clear', async () => {
    const h = harness(); const result = h.submit(); await tick(); const request = h.requests[0]; request.reject(new Error('lost')); await tick();
    assert.match(h.requests[1].url, /^\/api\/mutations\//);
    h.requests[1].resolve(h.ack(request)); await tick();
    assert.equal(h.mutations.status(result.intentId), null);
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('deliberate recovery reuses the exact mutation, scope and expected revision', async () => {
    const h = harness(); const result = h.submit(); await tick(); const original = h.requests[0]; original.reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.state.acceptDownload({ id: 'bulk:history', bulk_scope: 'history-scope', bulk_revision: '4' });
    const recovering = h.mutations.recover(result.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await recovering; await tick();
    assert.deepEqual(h.requests[3].body, original.body);
    h.requests[3].resolve(h.ack(original)); await tick();
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.state.selectDownload('bulk:history').bulk_revision, '4');
});

test('accepted partial clear preserves recovery and distinguishes accepted effects from completion', async () => {
    const h = harness(); const result = h.submit('library'); await tick(); const original = h.requests[0];
    original.resolve(h.ack(original, 'accepted', { removed: 1, removed_ids: ['video-a'], pending: 1 })); await tick();
    const pending = h.mutations.status(result.intentId);
    assert.equal(pending.status, 'unconfirmed'); assert.equal(pending.bulkResult.pending, 1);
    assert.match(pending.message, /accepted: 1 items removed, 1 files deleted, 0 retained, 0 failed, 1 pending/); assert.equal(h.mutations.resolve(result.intentId), false);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    assert.equal(h.requests.length, 1);
    const recovered = h.mutations.recover(result.intentId); await tick();
    const response = h.ack(original); response.body.revision = response.body.mutation.revision = '2';
    h.requests[1].resolve(response); await recovered; await tick();
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.events.filter(event => event.outcome === 'accepted').length, 1);
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('terminal partial failure reports retained and failed targets without claiming their removal', async () => {
    const h = harness(); h.submit('library'); await tick(); const original = h.requests[0];
    original.resolve(h.ack(original, 'committed', { removed: 0, removed_ids: [], files_deleted: 0, retained: 1, failed: 1 })); await tick();
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.state.selectDownload('video-a').filename, 'a.mp4');
    assert.equal(h.events.at(-1).outcome, 'confirmed');
});

test('lower progress revisions and a result forgetting prior removals cannot regress accepted bulk results', async () => {
    for (const lower of [true, false]) {
        const h = harness(); const result = h.submit('library'); await tick(); const original = h.requests[0];
        const accepted = h.ack(original, 'accepted', { removed: 1, removed_ids: ['video-a'], pending: 1 });
        accepted.body.revision = accepted.body.mutation.revision = '3'; original.resolve(accepted); await tick();
        const recovered = h.mutations.recover(result.intentId); await tick();
        const later = h.ack(original, 'accepted', { removed: 1, removed_ids: lower ? ['video-a'] : ['video-b'], pending: 1 });
        later.body.revision = later.body.mutation.revision = lower ? '2' : '4'; h.requests[1].resolve(later); await recovered; await tick();
        assert.deepEqual(plain(h.mutations.status(result.intentId).bulkResult.removed_ids), ['video-a']);
        assert.equal(h.state.selectDownload('bulk:library').bulk_revision, '3');
    }
});

test('strict acknowledgement correlation rejects changed operation, scope, domain, action, revision, counts and identities', async () => {
    const corruptions = [
        body => body.mutation.id = 'other', body => body.mutation.domain = 'other', body => body.mutation.action = 'entry.remove', body => body.mutation.entity_id = 'library',
        body => body.scope_id = 'other', body => body.operation_id = 'other', body => body.scope = 'library', body => body.revision = '2', body => body.revision = body.mutation.revision = 1,
        body => body.removed = 3, body => body.removed_ids = ['a', 'a'], body => body.total = 9, body => body.failed = -1, body => body.pending = 1, body => body.mutation.outcome = 'unrecognized',
    ];
    for (const corrupt of corruptions) {
        const h = harness(); const result = h.submit(); await tick(); const response = h.ack(h.requests[0]); corrupt(response.body); h.requests[0].resolve(response); await tick();
        assert.equal(h.mutations.status(result.intentId).status, 'unconfirmed');
        assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
        assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    }
});

for (const outcome of ['conflicted', 'rejected']) test(`${outcome} requires explicit review before a new clear`, async () => {
    const h = harness(); const result = h.submit(); await tick(); h.requests[0].resolve(h.ack(h.requests[0], outcome)); await tick();
    assert.equal(h.mutations.status(result.intentId).status, outcome);
    assert.equal(h.mutations.retry(result.intentId).reason, 'review_required');
    assert.equal(h.submit().accepted, false);
    assert.equal(h.mutations.resolve(result.intentId), true);
    assert.equal(h.state.selectDownload('video-a').filename, 'a.mp4');
});

test('five seconds supplies an explanation and timeout leaves the original scope unresolved', async () => {
    const h = harness(); const result = h.submit(); await tick(); h.advance(5000);
    assert.match(h.mutations.status(result.intentId).message, /Still waiting.*history clear/);
    h.advance(25000); await tick();
    assert.match(h.mutations.status(result.intentId).message, /Clear request not confirmed/);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('serialized expired absence requires an authorized state check before explicit resolution without deletion claims or new writes', async () => {
    const h = harness(); const result = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick(); h.advance(86401000);
    const recovered = h.mutations.recover(result.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    assert.equal(h.mutations.status(result.intentId).canResolve, false);
    assert.equal(h.mutations.resolve(result.intentId), false);
    assert.match(h.requests[3].url, /^\/api\/history\?/);
    h.requests[3].resolve({ status: 200, body: { items: [], total: 0, page: 1, page_size: 20 } }); await recovered; await tick();
    assert.equal(h.requests.length, 4); assert.equal(h.mutations.status(result.intentId).canResolve, true);
    assert.equal(h.mutations.resolve(result.intentId), true);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    assert.equal(h.state.selectDownload('video-a').filename, 'a.mp4');
});

test('authentication reset and access loss fence late bulk acknowledgements and clear captured scopes', async () => {
    for (const mode of ['reset', 'access']) {
        const h = harness(); const result = h.submit(); await tick(); const original = h.requests[0];
        if (mode === 'reset') h.mutations.reset(); else h.mutations.fence('bulk:history');
        original.resolve(h.ack(original)); await tick();
        assert.equal(h.mutations.status(result.intentId), null);
        assert.equal(h.state.selectDownload('bulk:history'), null);
        assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    }
});

test('store rejects older progress within a scope and obsolete callbacks after an explicitly installed new preview', () => {
    const h = harness();
    assert.equal(h.state.acceptDownload({ id: 'bulk:library', bulk_scope: 'library-scope', bulk_revision: '4' }), true);
    assert.equal(h.state.acceptDownload({ id: 'bulk:library', bulk_scope: 'library-scope', bulk_revision: '2' }), false);
    assert.equal(h.state.acceptDownload({ id: 'bulk:library', bulk_scope: 'other-scope', bulk_revision: '9' }), false);
    assert.equal(h.state.acceptBulkPreview('library', { scope_id: 'new-scope', revision: '0' }), true);
    assert.equal(h.state.acceptDownload({ id: 'bulk:library', bulk_scope: 'library-scope', bulk_revision: '20' }), false);
    assert.equal(h.state.selectDownload('bulk:library').bulk_scope, 'new-scope');
});

test('new adapter requires explicit capability, bound preview, canonical revision and valid scope identity', () => {
    const unsupported = harness(false); assert.equal(unsupported.submit().reason, 'unsupported');
    const h = harness(); assert.equal(h.submit('history', { scope_id: '', revision: '0', entries: 2 }).reason, 'validation');
    assert.equal(h.submit('history', { scope_id: 'history-scope', revision: 0, entries: 2 }).reason, 'validation');
    assert.equal(h.submit('history', { scope_id: 'history-scope', revision: '0', entries: 0 }).reason, 'validation');
    assert.equal(h.mutations.submit({ kind: 'history.clear', targetId: 'bulk:library', value: { scope_id: 'library-scope', revision: '0', entries: 2 } }).reason, 'unavailable');
    assert.equal(h.requests.length, 0);
});


test('a later authorized preview restores an access-fenced bulk scope without accepting callbacks from its former scope', () => {
    const h = harness();
    h.mutations.fence('bulk:library');
    assert.equal(h.state.selectDownload('bulk:library'), null);
    assert.equal(h.state.acceptBulkPreview('library', { scope_id: 'regained-scope', revision: '0' }), true);
    assert.equal(h.state.acceptDownload({ id: 'bulk:library', bulk_scope: 'library-scope', bulk_revision: '50' }), false);
    assert.equal(h.state.selectDownload('bulk:library').bulk_scope, 'regained-scope');
});

test('an explicit new preview cannot replace the frozen scope of a pending clear', async () => {
    const h = harness(); h.submit();
    assert.equal(h.state.acceptBulkPreview('history', { scope_id: 'replacement', revision: '0' }), false);
    assert.equal(h.state.selectDownload('bulk:history').bulk_scope, 'history-scope');
    await tick(); assert.equal(h.requests[0].body.scope_id, 'history-scope');
});

test('equal-revision progress with contradictory counts retains its earlier authorized results', async () => {
    const h = harness(); const submitted = h.submit('library'); await tick(); const original = h.requests[0];
    original.resolve(h.ack(original, 'accepted', { removed: 1, removed_ids: ['video-a'], pending: 1 })); await tick();
    const checked = h.mutations.recover(submitted.intentId); await tick();
    h.requests[1].resolve(h.ack(original, 'accepted', { removed: 1, removed_ids: ['video-a'], files_deleted: 2, pending: 1 })); await checked; await tick();
    assert.equal(h.mutations.status(submitted.intentId).bulkResult.files_deleted, 1);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
});


for (const mode of ['failure', 'malformed', 'reset', '403']) test(`expired bulk current-state ${mode} cannot release an unknown destructive intent`, async () => {
    let installed = 0;
    const h = harness(true, { onBulkCurrentState() { installed++; return true; } });
    const entry = h.submit('library'); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick(); h.advance(86401000);
    const checked = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    assert.equal(h.requests[3].url, '/api/library?include_order=true');
    assert.equal(h.mutations.status(entry.intentId).canResolve, false);
    if (mode === 'reset') h.mutations.reset();
    h.requests[3].resolve(mode === 'failure' ? { status: 503, body: { error: 'Unavailable' } } : mode === 'malformed' ? { status: 200, body: { items: [], order: {} } } : mode === '403' ? { status: 403, body: { error: 'Forbidden' } } : { status: 200, body: { items: [], order: { kind: 'library' } } });
    await checked; await tick();
    assert.equal(installed, 0);
    if (mode === 'reset' || mode === '403') assert.equal(h.mutations.status(entry.intentId), null);
    else { assert.equal(h.mutations.status(entry.intentId).canResolve, false); assert.equal(h.mutations.resolve(entry.intentId), false); }
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('authorized expiry snapshot uses the trusted current view and requires view acceptance before explicit resolution', async () => {
    let accepted = false;
    let received;
    const h = harness(true, { currentBulkView: () => ({ page: 2, filter: 'one & two' }), onBulkCurrentState(value) { received = plain(value); return accepted; } });
    const entry = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick(); h.advance(86401000);
    let checked = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    assert.equal(h.requests[3].url, '/api/history?page=2&page_size=20&filter=one%20%26%20two');
    h.requests[3].resolve({ status: 200, body: { items: [], total: 0, page: 1, page_size: 20 } }); await checked; await tick();
    assert.equal(h.mutations.status(entry.intentId).canResolve, false);
    assert.equal(received.scope, 'history');
    accepted = true; checked = h.mutations.recover(entry.intentId); await tick();
    h.requests[4].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests[5].resolve({ status: 200, body: { items: [], total: 0, page: 1, page_size: 20 } }); await checked; await tick();
    assert.equal(h.mutations.status(entry.intentId).canResolve, true);
    assert.equal(h.mutations.resolve(entry.intentId), true);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
});


test('view changes after a valid expiry snapshot require a new check before release', async () => {
    let currentView = true;
    const h = harness(true, { canResolveBulkState: () => currentView });
    const entry = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick(); h.advance(86401000);
    const checked = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests[3].resolve({ status: 200, body: { items: [], total: 0, page: 1, page_size: 20 } }); await checked; await tick();
    assert.equal(h.mutations.status(entry.intentId).canResolve, true);
    currentView = false;
    assert.equal(h.mutations.resolve(entry.intentId), false);
    assert.equal(h.mutations.status(entry.intentId).canResolve, false);
    assert.match(h.mutations.status(entry.intentId).message, /view changed/);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});
