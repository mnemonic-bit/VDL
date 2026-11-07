const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const source = app.slice(app.indexOf('let libraryStorageSnapshot ='), app.indexOf('const storageAccountChannel ='));
const coordinator = app.slice(app.indexOf('function coordinateRefresh('), app.indexOf('function updateCollectionError('));

function harness(fetch) {
    const elements = new Map();
    const context = vm.createContext({
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, open: false });
                return elements.get(id);
            },
        },
        apiFetch: fetch,
        collectionRefreshes: new Map(),
        setTimeout: callback => callback(),
        Date,
    });
    vm.runInContext(coordinator + source, context);
    return { context, elements, label: () => elements.get('libraryStorageLabel')?.textContent };
}

const ready = (total_bytes = 30100000) => ({
    total_bytes, measured_at: '2026-11-06T12:00:00+00:00',
    next_refresh_at: '2026-11-07T12:00:00+00:00', state: 'ready',
});

test('decimal storage labels preserve exact ties, promotion, zero, and large values', () => {
    const { context } = harness();
    for (const [bytes, expected] of [
        [0, '0 B'], [999, '999 B'], [1000, '1.0 k'], [1050, '1.1 k'],
        [28400, '28.4 k'], [30100000, '30.1 M'], [999949, '999.9 k'],
        [999950, '1.0 M'], [999950000, '1.0 G'], [1e9, '1.0 G'],
        [1e12, '1.0 T'], [1e15, '1.0 P'], [1e18, '1.0 E'],
        [9223372036854776000, '9.2 E'],
    ]) assert.equal(context.formatVideoStorage(bytes), expected, `${bytes} bytes`);
    for (const invalid of [null, undefined, '1000', -1, NaN, Infinity, 1.5, {}, true]) {
        assert.equal(context.formatVideoStorage(invalid), null);
    }
});

test('malformed data never becomes a successful zero-byte snapshot', () => {
    const { context } = harness();
    for (const invalid of [
        null, {}, { ...ready(), state: 'unknown' }, { ...ready(), total_bytes: null },
        { ...ready(), total_bytes: -1 }, { ...ready(), total_bytes: '0' },
        { ...ready(), measured_at: 'yesterday' },
        { ...ready(), measured_at: null },
        { ...ready(), next_refresh_at: '2026-11-05T12:00:00Z' },
        { ...ready(), state: 'calculating' },
    ]) assert.equal(context.parseLibraryStorage(invalid), null);
    assert.equal(context.parseLibraryStorage(ready(0)).total_bytes, 0);
});

test('temporary or malformed responses preserve the last known measurement as stale and recover', async () => {
    let reply = ready();
    const client = harness(async () => {
        if (reply instanceof Error) throw reply;
        return { ok: true, json: async () => reply };
    });
    await client.context.fetchLibraryStorage();
    assert.equal(client.label(), 'Videos 30.1 M');
    const detail = client.elements.get('libraryStorageUpdated').textContent;
    for (const failure of [new Error('Offline'), {}, { ...ready(), total_bytes: -1 }]) {
        reply = failure;
        await client.context.fetchLibraryStorage();
        assert.equal(client.label(), 'Videos 30.1 M (stale)');
        assert.ok(client.elements.get('libraryStorageUpdated').textContent.startsWith(detail));
    }
    reply = ready(0);
    await client.context.fetchLibraryStorage();
    assert.equal(client.label(), 'Videos 0 B');
    client.context.clearLibraryStorage();
    reply = new Error('Offline');
    await client.context.fetchLibraryStorage();
    assert.equal(client.label(), 'Videos unavailable');
});

test('a cleared account cannot be repopulated by an old in-flight response', async () => {
    let release;
    const client = harness(() => new Promise(resolve => { release = resolve; }));
    const pending = client.context.fetchLibraryStorage();
    client.context.clearLibraryStorage();
    release({ ok: true, json: async () => ready() });
    await pending;
    assert.equal(client.label(), 'Videos calculating…');
});

test('authorization failures discard the last known account measurement', async () => {
    for (const status of [401, 403]) {
        let authorized = true;
        const client = harness(async () => {
            if (!authorized && status === 401) throw Object.assign(new Error('Session ended'), { status });
            return { ok: authorized, status, json: async () => ready() };
        });
        await client.context.fetchLibraryStorage();
        assert.equal(client.label(), 'Videos 30.1 M');
        authorized = false;
        await client.context.fetchLibraryStorage();
        assert.equal(client.label(), 'Videos unavailable');
    }
});

test('concurrent hints share one request and one reconciliation', async () => {
    const releases = [];
    let active = 0;
    let maxActive = 0;
    const client = harness(() => new Promise(resolve => {
        active += 1;
        maxActive = Math.max(active, maxActive);
        releases.push(() => {
            active -= 1;
            resolve({ ok: true, json: async () => ready() });
        });
    }));
    const first = client.context.fetchLibraryStorage();
    const second = client.context.fetchLibraryStorage();
    client.context.fetchLibraryStorage();
    assert.equal(first, second);
    assert.equal(releases.length, 1);
    releases.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 1);
    releases.shift()();
    await first;
    assert.equal(maxActive, 1);
    assert.equal(client.label(), 'Videos 30.1 M');
});
