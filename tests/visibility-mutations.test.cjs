const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const tick = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const security = (visibility = 'public', revision = '0', manage = true) => ({
    id: 'entry', visibility, visibility_revision: revision, can_manage_visibility: manage, can_delete: true,
    permissions: { tags: true, favorite: true, rename: true, visibility: manage },
});
function harness(options = {}) {
    const context = vm.createContext({ setTimeout, clearTimeout, Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    state.acceptDownload({ ...security(), favorite: false, favorite_revision: '0', tags: [], tag_items: [], tags_revision: '0', tag_identity_version: context.VDL.tagIdentity.version });
    const timers = new Set();
    const requests = [];
    let serial = 0;
    const mutations = context.VDL.createMutations({
        state, now: () => 1800000000000, random: () => (++serial).toString(16).padStart(32, '0'),
        capabilities: { mutation_protocol: 1, actions: ['visibility.set', 'favorite.set', 'tag.add'], tag_identity_version: context.VDL.tagIdentity.version },
        setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout(callback) { timers.delete(callback); },
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })); },
        ...options,
    });
    function reply(request, snapshot = security('private', '1'), outcome = 'committed', receiptRevision = snapshot.visibility_revision) {
        return { status: outcome === 'committed' ? 200 : outcome === 'conflicted' ? 409 : 400,
            body: { ...snapshot, mutation: { id: request.body.client_mutation_id, domain: 'visibility', outcome, revision: receiptRevision } } };
    }
    return { context, state, mutations, requests, reply, timers,
        submit: value => mutations.submit({ kind: 'visibility.set', targetId: 'entry', value }) };
}

test('visibility intent retains confirmed security and explicit request synchronously', async () => {
    const h = harness();
    const result = h.submit('private');
    assert.equal(result.accepted, true);
    assert.equal(h.requests.length, 0);
    const model = h.state.selectDownload('entry');
    assert.equal(model.visibility, 'public');
    assert.equal(model.can_manage_visibility, true);
    assert.equal(model.visibility_intents[0].value, 'private');
    assert.equal(model.tag_chips.length, 0);
    await tick();
    assert.equal(h.requests[0].url, '/api/visibility/entry');
    assert.equal(h.requests[0].body.expected_revision, '0');
});
test('duplicates share attempt and contradictory visibility is guarded', async () => {
    const h = harness();
    const first = h.submit('private');
    assert.equal(h.submit('private').intentId, first.intentId);
    assert.equal(h.submit('public').reason, 'unresolved');
    await tick();
    assert.equal(h.requests.length, 1);
});
test('canonical acknowledgement confirms directly without a read', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].resolve(h.reply(h.requests[0]));
    await tick();
    assert.equal(h.state.selectDownload('entry').visibility, 'private');
    assert.equal(h.mutations.status(result.intentId), null);
    assert.equal(h.requests.length, 1);
});
test('pending visibility grants never replace private confirmed state', async () => {
    const h = harness();
    h.state.acceptDownload(security('private', '1'));
    h.submit('public');
    assert.equal(h.state.selectDownload('entry').visibility, 'private');
});
test('tags and favorites dispatch independently of visibility', async () => {
    const h = harness();
    h.submit('private');
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'entry', value: true }).accepted, true);
    assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'entry', value: 'topic' }).accepted, true);
    await tick();
    assert.equal(h.requests.length, 3);
});
test('old snapshots preserve newer visibility and security permissions together', () => {
    const h = harness();
    h.state.acceptDownload(security('private', '2', false));
    h.state.acceptDownload(security('public', '1'));
    const model = h.state.selectDownload('entry');
    assert.equal(model.visibility, 'private');
    assert.equal(model.can_manage_visibility, false);
    assert.equal(model.permissions.visibility, false);
});
test('unversioned callbacks cannot replace confirmed security', () => {
    const h = harness();
    h.state.acceptDownload(security('private', '1', false));
    h.state.acceptDownload({ id: 'entry', visibility: 'public', can_manage_visibility: true, permissions: { visibility: true } });
    assert.equal(h.state.selectDownload('entry').visibility, 'private');
    assert.equal(h.state.selectDownload('entry').can_manage_visibility, false);
});
test('equal-revision visibility mismatch is rejected and revoked permissions cannot escalate', () => {
    const h = harness();
    assert.equal(h.state.acceptDownload(security('private', '0')), false);
    h.state.acceptDownload(security('public', '0', false));
    h.state.acceptDownload(security('public', '0', true));
    assert.equal(h.state.selectDownload('entry').can_manage_visibility, false);
});
test('older acknowledgement settles request without overwriting newer security', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.state.acceptDownload(security('public', '2', false));
    h.requests[0].resolve(h.reply(h.requests[0]));
    await tick();
    assert.equal(h.mutations.status(result.intentId), null);
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
    assert.equal(h.state.selectDownload('entry').can_manage_visibility, false);
});
test('receipt can carry newer authorized security than original committed revision', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].resolve(h.reply(h.requests[0], security('public', '2', false), 'committed', '1'));
    await tick();
    assert.equal(h.mutations.status(result.intentId), null);
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
    assert.equal(h.state.selectDownload('entry').permissions.visibility, false);
});
test('malformed security acknowledgement remains unknown', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    const response = h.reply(h.requests[0]);
    delete response.body.can_manage_visibility;
    h.requests[0].resolve(response);
    await tick();
    assert.equal(h.mutations.status(result.intentId).status, 'unconfirmed');
    assert.match(h.mutations.status(result.intentId).message, /Visibility change not confirmed/);
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
});
test('conflict retains requested value and requires deliberate current-state review', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].resolve(h.reply(h.requests[0], security('public', '2'), 'conflicted'));
    await tick();
    assert.equal(h.mutations.status(result.intentId).status, 'conflicted');
    assert.equal(h.mutations.retry(result.intentId).reason, 'review_required');
    assert.equal(h.submit('private').reason, 'unresolved');
    assert.equal(h.mutations.resolve(result.intentId), true);
    h.submit('private');
    await tick();
    assert.equal(h.requests[1].body.expected_revision, '2');
});
test('unknown response replay preserves identical request and mutation id', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    const original = h.requests[0];
    original.reject(new Error('lost response'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    const recovery = h.mutations.recover(result.intentId, { replay: true });
    await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    await recovery;
    assert.deepEqual(h.requests[3].body, original.body);
    assert.equal(h.requests[3].url, original.url);
});
for (const mode of ['access fence', 'authentication reset']) test(`${mode} rejects late visibility acknowledgement`, async () => {
    const h = harness();
    h.submit('private');
    await tick();
    if (mode === 'access fence') h.mutations.fence('entry');
    else h.mutations.reset();
    h.requests[0].resolve(h.reply(h.requests[0]));
    await tick();
    assert.equal(h.state.selectDownload('entry'), null);
    assert.equal(h.mutations.pending().length, 0);
});
test('current permission denial prevents visibility submission', () => {
    const h = harness();
    h.state.acceptDownload(security('public', '1', false));
    assert.equal(h.submit('private').reason, 'unavailable');
    assert.equal(h.requests.length, 0);
});
test('unsupported capability never dispatches a protocol write', () => {
    const h = harness({ capabilities: { mutation_protocol: 1, actions: ['favorite.set'] } });
    assert.equal(h.submit('private').reason, 'unsupported');
    assert.equal(h.requests.length, 0);
});

test('expired absence requires a successful authorized read before explicit resolution', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].reject(new Error('lost response'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } });
    await tick();
    assert.match(h.requests[2].url, /editable-state$/);
    h.requests[2].resolve({ status: 500, body: {} });
    await tick();
    assert.equal(h.mutations.resolve(result.intentId), false);
    const recovery = h.mutations.recover(result.intentId);
    await tick();
    h.requests[3].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } });
    await tick();
    h.requests[4].resolve({ status: 200, body: security() });
    await tick();
    await recovery;
    assert.equal(h.mutations.status(result.intentId).canResolve, true);
    assert.equal(h.mutations.resolve(result.intentId), true);
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
});
test('an expired state read from an old authentication epoch cannot release a new intent', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].reject(new Error('lost response'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } });
    await tick();
    h.mutations.reset();
    h.state.acceptDownload(security());
    const next = h.submit('private');
    await tick();
    h.requests[2].resolve({ status: 200, body: security() });
    await tick();
    assert.equal(h.mutations.status(result.intentId), null);
    assert.equal(h.mutations.status(next.intentId).status, 'sending');
});
test('rejected request retains current security and requested value without a retry write', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].resolve(h.reply(h.requests[0], security(), 'rejected'));
    await tick();
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
    assert.equal(h.mutations.status(result.intentId).value, 'private');
    assert.equal(h.mutations.status(result.intentId).status, 'rejected');
    assert.equal(h.requests.length, 1);
});
test('denied recovery fences private pending state and cannot be restored by original response', async () => {
    const h = harness();
    h.submit('private');
    await tick();
    const original = h.requests[0];
    // A request timeout leaves the original response able to arrive later.
    for (const callback of [...h.timers]) callback();
    await tick();
    h.requests[1].resolve({ status: 403, body: { error: 'Visibility access revoked' } });
    await tick();
    original.resolve(h.reply(original));
    await tick();
    assert.equal(h.state.selectDownload('entry'), null);
    assert.equal(h.mutations.pending().length, 0);
});

test('visibility security merging preserves rename permission when worker finishes', () => {
    const h = harness();
    h.state.acceptDownload({ ...security(), status: 'starting', permissions: { tags: true, favorite: true, rename: false, visibility: true } });
    h.state.acceptDownload({ ...security(), status: 'finished' });
    assert.equal(h.state.selectDownload('entry').permissions.rename, true);
});
test('malformed equal-revision expiry snapshot cannot permit resolution', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].reject(new Error('lost response'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } });
    await tick();
    h.requests[2].resolve({ status: 200, body: security('private', '0') });
    await tick();
    assert.equal(h.mutations.resolve(result.intentId), false);
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
});

test('legacy visibility acknowledgement sequences old reads while preserving existing authority', () => {
    const h = harness();
    h.mutations.reset();
    h.state.acceptDownload({ id: 'entry', visibility: 'public', can_manage_visibility: false, can_delete: true });
    const before = h.state.capture();
    assert.equal(h.state.writer.acceptLegacyVisibility({ id: 'entry', visibility: 'private', changed: true }, before), true);
    h.state.acceptDownload({ id: 'entry', visibility: 'public', can_manage_visibility: true, can_delete: true }, before);
    assert.equal(h.state.selectDownload('entry').visibility, 'private');
    assert.equal(h.state.selectDownload('entry').can_manage_visibility, false);
    assert.equal(h.state.selectDownload('entry').visibility_revision, undefined);
    h.state.acceptDownload({ id: 'entry', visibility: 'public', can_manage_visibility: false, can_delete: true }, h.state.capture());
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
});
test('legacy visibility writer cannot bypass a negotiated revision or an access fence', () => {
    const h = harness();
    const context = h.state.capture();
    assert.equal(h.state.writer.acceptLegacyVisibility({ id: 'entry', visibility: 'private', changed: true }, context), false);
    h.mutations.fence('entry');
    assert.equal(h.state.writer.acceptLegacyVisibility({ id: 'entry', visibility: 'private', changed: true }, context), false);
});

test('documented quota refusal is definite without inventing canonical security or receipt recovery', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].resolve({ status: 429, body: { error: 'Too many mutations; wait before submitting more', code: 'mutation_limit' } });
    await tick();
    const status = h.mutations.status(result.intentId);
    assert.equal(status.status, 'rejected');
    assert.equal(status.value, 'private');
    assert.match(status.message, /Too many mutations/);
    assert.equal(h.state.selectDownload('entry').visibility, 'public');
    assert.equal(h.state.selectDownload('entry').visibility_revision, '0');
    assert.equal(h.requests.length, 1);
    assert.equal(h.mutations.resolve(result.intentId), true);
    assert.equal(h.submit('private').accepted, true);
    await tick();
    assert.notEqual(h.requests[1].body.client_mutation_id, h.requests[0].body.client_mutation_id);
});
test('unrecognized quota-shaped response remains unknown', async () => {
    const h = harness();
    const result = h.submit('private');
    await tick();
    h.requests[0].resolve({ status: 429, body: { error: 'An intermediary timed out', code: 'other_limit' } });
    await tick();
    assert.equal(h.mutations.status(result.intentId).status, 'unconfirmed');
});
test('visibility diagnostics count receipt and current-state reconciliation without request content', async () => {
    const events = [];
    const h = harness({ onEvent: event => events.push(event) });
    const result = h.submit('private');
    await tick();
    h.requests[0].reject(new Error('lost response'));
    await tick();
    assert.equal(events.filter(event => event.outcome === 'reconciliation').length, 1);
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    const recovery = h.mutations.recover(result.intentId);
    await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    h.requests[3].resolve({ status: 200, body: security() });
    await tick();
    await recovery;
    assert.equal(events.filter(event => event.outcome === 'reconciliation').length, 3);
    assert.ok(events.filter(event => event.outcome === 'reconciliation').every(event => event.action === 'visibility.set'));
    assert.equal(JSON.stringify(events).includes('entry'), false);
    assert.equal(JSON.stringify(events).includes('private'), false);
});

function availabilityAdapter(h, snapshot) {
    Object.assign(h.context, {
        tagState: h.state, checkingTagAvailability: new Set(), unavailableTagIds: new Set(),
        visibilityMutationMetrics: { reconciliationReads: 0 }, mutationMetrics: { reconciliationReads: 0 },
        tagSessionEpoch: 0, visibilityIntent: () => null,
        apiFetch: async () => ({ status: 200, ok: true, json: async () => snapshot }),
        tagMutations: h.mutations,
    });
    const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
    const source = app.slice(app.indexOf('async function checkTagAvailability('), app.indexOf('function checkMissingTagTargets('));
    vm.runInContext(source, h.context);
    return () => h.context.checkTagAvailability(snapshot.id);
}
test('targeted availability before collection cannot block fresh tags, security, or progress', async () => {
    const h = harness();
    const identity = h.context.VDL.tagIdentity.version;
    const targeted = { ...security(), filename: '/owned/media.mp4', display_filename: null, rename_revision: '1',
        tags: [], tag_items: [], tags_revision: '0', tag_identity_version: identity };
    h.mutations.reset();
    await availabilityAdapter(h, targeted)();
    assert.equal(h.state.selectDownload('entry').filename, 'media.mp4');
    assert.equal(h.state.acceptDownload({ ...targeted, ...security('private', '1'), filename: 'media.mp4',
        tags: ['Music Videos', 'Tutorial'], tag_items: [{ key: 'music videos', name: 'Music Videos' }, { key: 'tutorial', name: 'Tutorial' }],
        tags_revision: '2', progress: '100%', status: 'finished' }), true);
    const model = h.state.selectDownload('entry');
    assert.equal(model.tags_revision, '2');
    assert.equal(model.tags.join(','), 'Music Videos,Tutorial');
    assert.equal(model.visibility, 'private');
    assert.equal(model.progress, '100%');
});
for (const filename of ['media.mp4', '/owned/media.mp4']) test(`targeted availability preserves known filename representation ${filename}`, async () => {
    const h = harness();
    const row = { ...security(), filename, display_filename: null, rename_revision: '1' };
    h.state.acceptDownload(row);
    await availabilityAdapter(h, { ...row, filename: '/owned/media.mp4' })();
    assert.equal(h.state.selectDownload('entry').filename, filename);
});

test('targeted availability first retains the public custom filename for collection reconciliation', async () => {
    const h = harness();
    const targeted = { ...security(), filename: '/owned/physical-name.mp4', display_filename: 'custom-name.mp4', rename_revision: '1' };
    h.mutations.reset();
    await availabilityAdapter(h, targeted)();
    assert.equal(h.state.selectDownload('entry').filename, 'custom-name.mp4');
    assert.equal(h.state.acceptDownload({ ...targeted, ...security('private', '1'), filename: 'custom-name.mp4', status: 'finished' }), true);
    assert.equal(h.state.selectDownload('entry').visibility, 'private');
    assert.equal(h.state.selectDownload('entry').filename, 'custom-name.mp4');
});
