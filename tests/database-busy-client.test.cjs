const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
const source = app.slice(app.indexOf('function showServerStatus('), app.indexOf('function hideActionError()'));

function harness(replies, { onDelay = () => {} } = {}) {
    const delays = [];
    const requests = [];
    const redirects = [];
    const elements = new Map();
    const context = vm.createContext({
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, {
                    hidden: true,
                    classList: { add() {}, remove() {} },
                });
                return elements.get(id);
            },
        },
        window: { location: { assign: url => redirects.push(url) } },
        fetch: async (url, options) => {
            requests.push({ url, options });
            const reply = replies.shift();
            if (reply instanceof Error) throw reply;
            assert.ok(reply, 'unexpected additional request');
            return reply;
        },
        setTimeout: (callback, delay) => { delays.push(delay); onDelay(); callback(); },
        Date,
    });
    vm.runInContext(source, context);
    return { apiFetch: context.apiFetch, delays, requests, redirects, elements };
}

function busy(retryAfter = '1') {
    return new Response(JSON.stringify({
        code: 'database_busy', retryable: true, error: 'The database is busy. Try again shortly.',
    }), { status: 503, headers: { 'Retry-After': retryAfter } });
}

test('safe reads recover from temporary database contention using Retry-After', async () => {
    const client = harness([busy(), new Response('[]')]);
    assert.equal((await client.apiFetch('/api/current-downloads')).status, 200);
    assert.equal(client.requests.length, 2);
    assert.deepEqual(client.delays, [1000]);
    assert.equal(client.elements.get('serverStatus').hidden, true);
});

test('exhausted lock recovery rejects a useful error instead of returning collection-shaped failure data', async () => {
    const client = harness([busy(), busy(), busy()]);
    await assert.rejects(client.apiFetch('/api/library'), /database is busy/i);
    assert.equal(client.requests.length, 3);
    assert.deepEqual(client.delays, [1000, 1000]);
    assert.equal(client.elements.get('serverStatus').hidden, false);
});

test('retry delays are bounded even when the server suggests a long wait', async () => {
    const client = harness([busy('120'), new Response('[]')]);
    await client.apiFetch('/api/library', { method: 'get' });
    assert.equal(client.requests.length, 2);
    assert.deepEqual(client.delays, [2000]);
});

test('mutation requests are never replayed after a database busy response', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
        const options = { method, body: '{"id":"video"}' };
        const client = harness([busy()]);
        assert.equal((await client.apiFetch('/api/action', options)).status, 503);
        assert.equal(client.requests.length, 1);
        assert.equal(client.requests[0].options, options);
        assert.deepEqual(client.delays, []);
    }
});

test('unrelated server errors remain available to callers without database recovery', async () => {
    for (const status of [404, 503]) {
        const client = harness([new Response(JSON.stringify({ error: 'Unavailable' }), { status })]);
        const response = await client.apiFetch('/api/library');
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error: 'Unavailable' });
        assert.equal(client.requests.length, 1);
        assert.deepEqual(client.delays, []);
    }
});

test('expired sessions still redirect to login without retrying authentication failures', async () => {
    const client = harness([busy('0'), new Response('{}', { status: 401 })]);
    await assert.rejects(client.apiFetch('/api/current-downloads'), /session has ended/);
    assert.deepEqual(client.redirects, ['/login']);
    assert.equal(client.requests.length, 2);
});

test('cancelled reads are never retried and do not show a server outage', async () => {
    const abort = new Error('Cancelled');
    abort.name = 'AbortError';
    const client = harness([abort]);
    await assert.rejects(client.apiFetch('/api/library'), { name: 'AbortError' });
    assert.equal(client.requests.length, 1);
    assert.deepEqual(client.delays, []);
    assert.notEqual(client.elements.get('serverStatus')?.hidden, false);
});

test('reads cancelled during the retry wait are not replayed', async () => {
    const controller = new AbortController();
    const client = harness([busy()], { onDelay: () => controller.abort() });
    await assert.rejects(client.apiFetch('/api/library', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(client.requests.length, 1);
    assert.notEqual(client.elements.get('serverStatus')?.hidden, false);
});


test('successful unrelated reads preserve health failure until health itself recovers', async () => {
    const client = harness([new Error('Health unavailable'), new Response('[]'), new Response('{}')]);
    await assert.rejects(client.apiFetch('/api/health'), /Health unavailable/);
    await client.apiFetch('/api/current-downloads');
    assert.equal(client.elements.get('serverStatus').hidden, false);
    await client.apiFetch('/api/health');
    assert.equal(client.elements.get('serverStatus').hidden, true);
});


test('ordinary request failures recover when another API request succeeds', async () => {
    const client = harness([new Error('Connection interrupted'), new Response('[]')]);
    await assert.rejects(client.apiFetch('/api/history?page=2'), /Connection interrupted/);
    await client.apiFetch('/api/history?page=1');
    assert.equal(client.elements.get('serverStatus').hidden, true);
});
