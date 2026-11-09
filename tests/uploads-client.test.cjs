const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const uploadId = '0123456789abcdef0123456789abcdef';
function harness() {
    const context = vm.createContext({ Uint8Array, crypto: require('node:crypto').webcrypto });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    let now = 1800000000000, random = 0;
    const requests = [], events = [], timers = new Map();
    const mutations = context.VDL.createMutations({ state, now: () => now,
        random: () => (++random).toString(16).padStart(32, '0'),
        capabilities: { upload_recovery: 1, mutation_protocol: 1, actions: ['upload.register', 'upload.cancel', 'favorite.set', 'rename.set'], server_time: now },
        setTimeout(callback, delay) { const id = {}; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        onEvent: event => events.push(plain(event)),
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...plain(request), resolve, reject })); },
    });
    function submit(kind = 'upload.register', id = uploadId, value = kind === 'upload.register' ? { filename: 'File.mp4', filesize: 64 } : {}) {
        if (!state.isAvailable(id)) state.acceptDownload({ id, upload_revision: '0', upload: null });
        return mutations.submit({ kind, targetId: id, value });
    }
    function upload(fields = {}) { return { id: uploadId, phase: 'registered', revision: '1', attempt_id: 'attempt-a', download_status: 'starting', downloaded_bytes: 0, total_bytes: 64, cancel_requested: false, ...fields }; }
    function ack(request, fields = {}) {
        const canonical = upload(fields);
        return { status: 202, body: { id: request.body.id || uploadId, upload: canonical,
            mutation: { id: request.body.client_mutation_id, domain: 'upload', outcome: 'accepted', revision: canonical.revision } } };
    }
    const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
    return { state, mutations, requests, events, submit, ack, upload, advance };
}
test('registration has synchronous status-only intent and canonical identity without collection reads', async () => {
    const h = harness(), entry = h.submit();
    const model = h.state.selectDownload(uploadId);
    assert.equal(model.upload_intents[0].status, 'sending');
    assert.equal(model.tag_chips.length, 0);
    assert.equal(model.upload, null);
    assert.equal(model.filename, undefined);
    assert.equal(h.requests.length, 0);
    await tick();
    const request = h.requests[0];
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/upload');
    assert.equal(request.body.id, uploadId); assert.equal(request.body.filesize, 64);
    assert.equal(Object.hasOwn(request.body, 'expected_revision'), false);
    request.resolve(h.ack(request)); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload(uploadId).upload.attempt_id, 'attempt-a');
    assert.equal(h.requests.length, 1);
});
test('duplicate registration is guarded and immutable capture cannot bind another file', async () => {
    const h = harness(), value = { filename: 'Captured.mp4', filesize: 64 };
    const first = h.submit('upload.register', uploadId, value);
    assert.equal(h.submit('upload.register', uploadId, value).intentId, first.intentId);
    value.filename = 'Changed.mp4';
    assert.equal(h.submit('upload.register', uploadId, value).accepted, false);
    assert.equal(h.submit('upload.cancel').accepted, false);
    await tick(); assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.filename, 'Captured.mp4');
});
test('file metadata validation rejects empty, oversized numeric and unsafe resource identities without writes', async () => {
    for (const [id, value] of [[uploadId, { filename: '', filesize: 1 }], [uploadId, { filename: 'empty.mp4', filesize: 0 }], [uploadId, { filename: 'large.mp4', filesize: Number.MAX_SAFE_INTEGER + 1 }], ['../file', { filename: 'file.mp4', filesize: 1 }], [uploadId, { filename: 'file.mp4', filesize: 1, url: 'arbitrary' }]]) {
        const h = harness();
        assert.equal(h.submit('upload.register', id, value).accepted, false);
        await tick(); assert.equal(h.requests.length, 0);
    }
});
test('recovery capability is separate from raw upload transport support', async () => {
    const h = harness();
    h.mutations.setCapabilities({ mutation_protocol: 1, actions: ['upload.register', 'upload.cancel'] });
    assert.equal(h.submit().accepted, false);
    await tick(); assert.equal(h.requests.length, 0);
});
test('registration lost response permits receipt checking and explicit exact replay without byte transport', async () => {
    const h = harness(), entry = h.submit(); await tick();
    const original = h.requests[0]; original.reject(new Error('lost response')); await tick();
    assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    const recovery = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await recovery; await tick();
    assert.deepEqual(h.requests[3].body, original.body);
    assert.equal(h.requests[3].url, original.url);
    h.requests[3].resolve(h.ack(original)); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 0);
});
test('malformed acknowledgement cannot establish a registration outcome', async () => {
    for (const field of ['id', 'mutation', 'revision', 'phase', 'attempt', 'bytes', 'status']) {
        const h = harness(), entry = h.submit(); await tick(); const reply = h.ack(h.requests[0]);
        if (field === 'id') reply.body.id = 'other';
        if (field === 'mutation') reply.body.mutation.id = 'other';
        if (field === 'revision') reply.body.upload.revision = 1;
        if (field === 'phase') reply.body.upload.phase = 'finished';
        if (field === 'attempt') reply.body.upload.attempt_id = '';
        if (field === 'bytes') reply.body.upload.downloaded_bytes = 100;
        if (field === 'status') { reply.body.upload.phase = 'published'; reply.body.upload.download_status = 'downloading'; }
        h.requests[0].resolve(reply); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed', field);
    }
});
test('cancellation delivery is separate from cleanup and a published result wins the race', async () => {
    const h = harness(); h.submit(); await tick(); h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    const cancel = h.submit('upload.cancel');
    assert.equal(h.state.selectDownload(uploadId).upload.phase, 'registered');
    assert.equal(h.state.selectDownload(uploadId).upload_intents[0].kind, 'upload.cancel');
    await tick(); assert.equal(h.requests[1].url, `/api/upload/${uploadId}/cancel`);
    h.requests[1].resolve(h.ack(h.requests[1], { phase: 'processing', revision: '3', download_status: 'downloading', downloaded_bytes: 64, cancel_requested: true })); await tick();
    assert.equal(h.mutations.status(cancel.intentId), null);
    assert.equal(h.state.selectDownload(uploadId).upload.phase, 'processing');
    assert.equal(h.state.selectDownload(uploadId).upload.cancel_requested, true);
    h.state.acceptDownload({ id: uploadId, upload_revision: '4', upload: h.upload({ phase: 'published', revision: '4', download_status: 'finished', downloaded_bytes: 64 }) });
    assert.equal(h.state.selectDownload(uploadId).upload.phase, 'published');
});
test('newer upload snapshot survives older registration acknowledgement and same-phase byte regressions', async () => {
    const h = harness(); h.submit(); await tick();
    h.state.acceptDownload({ id: uploadId, upload_revision: '3', upload: h.upload({ phase: 'processing', revision: '3', download_status: 'downloading', downloaded_bytes: 64 }) });
    h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    assert.equal(h.state.selectDownload(uploadId).upload.phase, 'processing');
    assert.equal(h.state.selectDownload(uploadId).upload_revision, '3');
    h.state.acceptDownload({ id: uploadId, upload_revision: '4', upload: h.upload({ phase: 'processing', revision: '4', download_status: 'downloading', downloaded_bytes: 32 }) });
    assert.equal(h.state.selectDownload(uploadId).upload.downloaded_bytes, 64);
});
test('published upload rejects stale worker snapshot without blocking canonical rename acknowledgement', async () => {
    const h = harness();
    h.state.acceptDownload({ id: uploadId, upload_revision: '4', upload: h.upload({ phase: 'published', revision: '4', download_status: 'finished', downloaded_bytes: 64 }), status: 'finished', filename: '/media/file.mp4', display_filename: 'file.mp4', rename_revision: '0' });
    const rename = h.mutations.submit({ kind: 'rename.set', targetId: uploadId, value: 'renamed' }); await tick();
    const request = h.requests[0];
    request.resolve({ status: 200, body: { id: uploadId, filename: '/media/renamed.mp4', display_filename: 'renamed.mp4', rename_revision: '1', mutation: { id: request.body.client_mutation_id, domain: 'rename', outcome: 'committed', revision: '1' } } }); await tick();
    assert.equal(h.mutations.status(rename.intentId), null);
    assert.equal(h.state.selectDownload(uploadId).filename, '/media/renamed.mp4');
    h.state.acceptDownload({ id: uploadId, upload_revision: '2', upload: h.upload({ phase: 'transferring', revision: '2', download_status: 'downloading', downloaded_bytes: 32 }), filename: null, status: 'downloading' });
    assert.equal(h.state.selectDownload(uploadId).filename, '/media/renamed.mp4');
    assert.equal(h.state.selectDownload(uploadId).status, 'finished');
});
test('ordinary matching state never releases unknown registration or cancellation', async () => {
    const h = harness(), entry = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.state.acceptDownload({ id: uploadId, upload_revision: '4', upload: h.upload({ revision: '4', phase: 'cancelled', download_status: 'cancelled' }) });
    assert.equal(h.mutations.resolve(entry.intentId), false);
    assert.equal(h.submit('upload.cancel').accepted, false);
});
test('expired absent attempts resolve only after serialized finality and never replay', async () => {
    const h = harness(), entry = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.advance(86401000);
    const recovery = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await recovery;
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(h.mutations.resolve(entry.intentId), true);
});
test('account reset fences old replies and prevents old queued request dispatch', async () => {
    const h = harness(); h.submit(); await tick();
    const original = h.requests[0];
    h.mutations.reset();
    original.resolve(h.ack(original)); await tick();
    assert.equal(h.state.selectDownload(uploadId), null);
    assert.equal(h.mutations.pending().length, 0);
    const second = h.submit(); h.mutations.reset(); await tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.mutations.status(second.intentId), null);
});
test('unauthorized recovery fences the upload and cannot expose cached private status', async () => {
    const h = harness(), entry = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 403, body: { error: 'Upload unavailable' } }); await tick();
    assert.equal(h.state.selectDownload(uploadId), null);
    assert.equal(h.mutations.status(entry.intentId), null);
});
test('independent files and metadata remain usable while another registration is unknown', async () => {
    const h = harness(); h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    const otherId = 'fedcba9876543210fedcba9876543210';
    assert.equal(h.submit('upload.register', otherId).accepted, true);
    h.state.acceptDownload({ id: uploadId, favorite: false, favorite_revision: '0' });
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: uploadId, value: true }).accepted, true);
    await tick();
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 3);
    assert.equal(h.state.selectDownload(uploadId).favorite, true);
});
test('published upload acknowledgement merges playable canonical metadata and unrelated domains', async () => {
    const h = harness(); h.submit(); await tick();
    const request = h.requests[0], reply = h.ack(request, { phase: 'published', revision: '4', download_status: 'finished', downloaded_bytes: 64 });
    reply.body.download = { id: uploadId, source_type: 'upload', status: 'finished', filename: 'file.mp4', display_filename: null, rename_revision: '0', favorite: false, favorite_revision: '0', filesize: 64 };
    request.resolve(reply); await tick();
    const model = h.state.selectDownload(uploadId);
    assert.equal(model.upload.phase, 'published');
    assert.equal(model.filename, 'file.mp4'); assert.equal(model.status, 'finished');
    assert.equal(model.favorite_revision, '0');
    assert.equal(h.requests.length, 1);
});
test('malformed refusal, wrong publication target and changed upload attempt remain unknown', async () => {
    for (const field of ['rejected-missing-revision', 'rejected-wrong-revision', 'rejected-wrong-target', 'published-wrong-target', 'changed-attempt']) {
        const h = harness(), entry = h.submit(); await tick(); const request = h.requests[0];
        const reply = h.ack(request);
        if (field.startsWith('rejected-')) { reply.status = 409; reply.body.mutation.outcome = 'rejected'; }
        if (field === 'rejected-missing-revision') delete reply.body.mutation.revision;
        if (field === 'rejected-wrong-revision') reply.body.mutation.revision = '2';
        if (field === 'rejected-wrong-target') reply.body.upload.id = 'another-file';
        if (field === 'published-wrong-target') { reply.body.upload.phase = 'published'; reply.body.upload.download_status = 'finished'; reply.body.download = { id: 'another-file', status: 'finished', filename: 'other.mp4' }; }
        if (field === 'changed-attempt') h.state.acceptDownload({ id: uploadId, upload_revision: '1', upload: h.upload({ attempt_id: 'accepted-other-attempt' }) });
        request.resolve(reply); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed', field);
    }
});
test('upload wait becomes explanatory at five seconds without retransmitting and resets cleanly', async () => {
    const h = harness(), entry = h.submit(); await tick(); h.advance(5000);
    const intent = h.mutations.status(entry.intentId);
    assert.equal(intent.delayed, true); assert.match(intent.message, /Still waiting for upload registration confirmation/);
    assert.equal(h.requests.length, 1);
    h.mutations.reset(); h.advance(30000); await tick(); assert.equal(h.requests.length, 1);
});
test('ambiguous filesystem cleanup state remains explicit in canonical upload snapshots', async () => {
    const h = harness(); h.submit(); await tick();
    h.requests[0].resolve(h.ack(h.requests[0], { phase: 'failed', revision: '4', download_status: 'interrupted', recovery_required: true })); await tick();
    assert.equal(h.state.selectDownload(uploadId).upload.recovery_required, true);
});
test('typed upload write unavailability fences pending registration and cancellation', async () => {
    for (const kind of ['upload.register', 'upload.cancel']) {
        for (const error of ['Upload unavailable', 'Unknown upload id']) {
            const h = harness();
            if (kind === 'upload.cancel') { h.submit(); await tick(); h.requests[0].resolve(h.ack(h.requests[0])); await tick(); }
            const entry = h.submit(kind); await tick();
            const request = h.requests.at(-1);
            request.resolve({ status: 404, body: { error } }); await tick();
            assert.equal(h.state.selectDownload(uploadId), null, `${kind}: ${error}`);
            assert.equal(h.mutations.status(entry.intentId), null);
            assert.equal(h.mutations.pending().length, 0);
            assert.equal(h.requests.some(item => item.method === 'GET'), false);
        }
    }
});
test('missing receipt and untyped write 404 remain ambiguous without fencing a registration', async () => {
    for (const error of ['Mutation unavailable', 'Not found']) {
        const h = harness(), entry = h.submit(); await tick();
        h.requests[0].resolve({ status: 404, body: { error } }); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
        assert.equal(h.state.isAvailable(uploadId), true);
        h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
        assert.equal(h.state.isAvailable(uploadId), true);
        assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    }
});
test('equal-revision upload status bytes advance and older checks cannot rewind them', () => {
    const h = harness();
    const snapshot = bytes => ({ id: uploadId, upload_revision: '2', upload: h.upload({ phase: 'transferring', revision: '2', download_status: 'downloading', downloaded_bytes: bytes }) });
    h.state.acceptDownload(snapshot(16));
    h.state.acceptDownload(snapshot(32));
    assert.equal(h.state.selectDownload(uploadId).upload.downloaded_bytes, 32);
    h.state.acceptDownload(snapshot(16));
    assert.equal(h.state.selectDownload(uploadId).upload.downloaded_bytes, 32);
    h.state.acceptDownload(snapshot(64));
    assert.equal(h.state.selectDownload(uploadId).upload.downloaded_bytes, 64);
    h.state.acceptDownload(snapshot(32));
    assert.equal(h.state.selectDownload(uploadId).upload.downloaded_bytes, 64);
    assert.equal(h.state.selectDownload(uploadId).upload.phase, 'transferring');
});
test('cancellation adopts legacy canonical eight-character upload identities while registration requires new IDs', async () => {
    const h = harness(), legacyId = '0123abcd';
    h.state.acceptDownload({ id: legacyId, upload_revision: '1', upload: h.upload({ id: legacyId }) });
    const entry = h.submit('upload.cancel', legacyId);
    assert.equal(entry.accepted, true);
    await tick();
    assert.equal(h.requests[0].url, `/api/upload/${legacyId}/cancel`);
    assert.equal(h.requests[0].method, 'POST');
    const canonical = h.upload({ id: legacyId, phase: 'cancelled', revision: '2', download_status: 'cancelled', cancel_requested: true });
    h.requests[0].resolve({ status: 200, body: { id: legacyId, upload: canonical, mutation: { id: h.requests[0].body.client_mutation_id, domain: 'upload', outcome: 'accepted', revision: '2' } } });
    await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload(legacyId).upload.phase, 'cancelled');
    const registration = harness();
    assert.equal(registration.submit('upload.register', legacyId).accepted, false);
    await tick(); assert.equal(registration.requests.length, 0);
});
test('cancellation cannot manufacture authority from an arbitrary target or local registration placeholder', async () => {
    for (const id of ['0123abcd', uploadId, 'unrecognized-resource']) {
        const h = harness();
        h.state.acceptDownload({ id, upload_revision: '0', upload: null });
        assert.equal(h.mutations.submit({ kind: 'upload.cancel', targetId: id, value: {} }).accepted, false);
        await tick(); assert.equal(h.requests.length, 0);
    }
    const h = harness();
    h.state.acceptDownload({ id: uploadId, upload_revision: '1', upload: h.upload() });
    assert.equal(h.mutations.submit({ kind: 'upload.cancel', targetId: 'another-target', value: {} }).accepted, false);
    await tick(); assert.equal(h.requests.length, 0);
});
