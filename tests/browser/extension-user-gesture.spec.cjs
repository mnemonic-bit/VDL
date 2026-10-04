const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const extensionSource = relativePath => fs.readFileSync(
    path.join(__dirname, '..', '..', 'browser-extension', 'src', relativePath),
    'utf8',
);

test('pairing requests VDL access directly from the submit gesture', async ({ page }) => {
    await page.setContent(`
        <form id="pairForm">
            <textarea id="pairingString"></textarea>
            <input id="deviceLabel" value="Firefox">
            <p id="originPreview" hidden></p>
            <button type="submit">Pair</button>
        </form>
        <p id="status"></p>
    `);
    await page.evaluate(() => {
        window.__userInput = false;
        window.__extensionState = {};
        window.__messageListener = null;
        Object.defineProperty(window.crypto, 'randomUUID', {
            value: () => '00000000-0000-4000-8000-000000000000',
        });
        window.browser = {
            runtime: {
                getManifest: () => ({version: '1.0.3'}),
                onInstalled: {addListener: () => {}},
                onMessage: {addListener: listener => { window.__messageListener = listener; }},
                sendMessage: message => {
                    window.__userInput = false;
                    return Promise.resolve(window.__messageListener(message));
                },
                getURL: value => value,
                openOptionsPage: async () => {},
            },
            storage: {local: {
                get: async key => key === 'connection' && window.__extensionState.connection
                    ? {connection: window.__extensionState.connection} : {},
                set: async values => Object.assign(window.__extensionState, values),
                remove: async () => {},
            }},
            permissions: {
                contains: async ({origins}) => origins.every(
                    origin => window.__extensionState.permission === origin
                ),
                request: ({origins}) => {
                    if (!window.__userInput) {
                        throw new Error('permissions.request may only be called from a user input handler');
                    }
                    window.__extensionState.permission = origins[0];
                    return Promise.resolve(true);
                },
            },
            tabs: {create: async () => {}},
            action: {
                setBadgeText: async () => {},
                setBadgeBackgroundColor: async () => {},
                setTitle: async () => {},
                onClicked: {addListener: listener => { window.__actionListener = listener; }},
            },
            cookies: {getAll: async () => []},
        };
        window.fetch = async url => ({
            ok: true,
            status: 201,
            headers: {get: () => null},
            body: null,
            text: async () => JSON.stringify(url.endsWith('/pair') ? {
                    token: 'test-token',
                    connection_id: 'test-connection',
                    user: {username: 'admin'},
                } : {action: 'started'}),
        });
    });
    await page.addScriptTag({content: extensionSource('background.js')});
    await page.addScriptTag({content: extensionSource('onboarding.js')});

    const encoded = Buffer.from(JSON.stringify({
        code: `VDL1-${'A'.repeat(22)}`,
        origin: 'http://100.96.0.2:5000',
    })).toString('base64url');
    await page.evaluate(pairingString => {
        document.getElementById('pairingString').value = pairingString;
        window.__userInput = true;
        document.getElementById('pairForm').dispatchEvent(
            new Event('submit', {bubbles: true, cancelable: true}),
        );
        window.__userInput = false;
    }, `vdl-pair-v1:${encoded}`);

    await expect(page.locator('#status')).toHaveText(
        'Paired with http://100.96.0.2:5000 as admin.',
    );
    expect(await page.evaluate(() => window.__extensionState.connection.origin))
        .toBe('http://100.96.0.2:5000');
});

test('expired pairing strings explain where to create a replacement', async ({ page }) => {
    await page.setContent(`
        <form id="pairForm">
            <textarea id="pairingString"></textarea>
            <input id="deviceLabel" value="Firefox">
            <p id="originPreview" hidden></p>
            <button type="submit">Pair</button>
        </form>
        <p id="status"></p>
    `);
    await page.addScriptTag({content: extensionSource('onboarding.js')});

    const code = Buffer.alloc(16);
    code[0] = 2;
    code.writeUInt32BE(Math.floor(Date.now() / 1000) - 11 * 60, 1);
    code.fill(7, 5);
    const encoded = Buffer.from(JSON.stringify({
        code: `VDL1-${code.toString('base64url')}`,
        origin: 'http://100.96.0.2:5000',
    })).toString('base64url');
    await page.locator('#pairingString').fill(`vdl-pair-v1:${encoded}`);

    await expect(page.locator('#status')).toHaveText(
        'This pairing string expired 6 minutes ago. In VDL, open Settings → Browser Extension, choose Create pairing string, and paste the new string here.',
    );
    await expect(page.locator('#originPreview')).toContainText('http://100.96.0.2:5000');
});

test('toolbar requests page access directly from the toolbar gesture', async ({ page }) => {
    await page.setContent('<p>extension background harness</p>');
    await page.evaluate(() => {
        window.__userInput = false;
        window.__extensionState = {connection: {
            origin: 'http://100.96.0.2:5000',
            token: 'test-token',
            connectionId: 'test-connection',
            username: 'admin',
        }};
        Object.defineProperty(window.crypto, 'randomUUID', {
            value: () => '00000000-0000-4000-8000-000000000000',
        });
        window.browser = {
            runtime: {
                getManifest: () => ({version: '1.0.3'}),
                onInstalled: {addListener: () => {}},
                onMessage: {addListener: () => {}},
                getURL: value => value,
                openOptionsPage: async () => {},
            },
            storage: {local: {
                get: async key => key === 'connection'
                    ? {connection: window.__extensionState.connection} : {},
                set: async values => Object.assign(window.__extensionState, values),
                remove: async () => {},
            }},
            permissions: {
                contains: async ({origins}) => origins.every(
                    origin => window.__extensionState.permission === origin
                ),
                request: ({origins}) => {
                    if (!window.__userInput) {
                        throw new Error('permissions.request may only be called from a user input handler');
                    }
                    window.__extensionState.permission = origins[0];
                    return Promise.resolve(true);
                },
            },
            tabs: {create: async () => {}},
            action: {
                setBadgeText: async () => {},
                setBadgeBackgroundColor: async () => {},
                setTitle: async () => {},
                onClicked: {addListener: listener => { window.__actionListener = listener; }},
            },
            cookies: {getAll: async () => []},
        };
        window.fetch = async url => ({
            ok: true,
            status: 201,
            headers: {get: () => null},
            body: null,
            text: async () => JSON.stringify(
                url.endsWith('/downloads') ? {action: 'started'} : {}
            ),
        });
    });
    await page.addScriptTag({content: extensionSource('background.js')});

    await page.evaluate(() => {
        window.__userInput = true;
        window.__actionListener({
            url: 'https://video.example/watch/1',
            incognito: false,
            cookieStoreId: 'firefox-default',
        });
        window.__userInput = false;
    });

    await expect.poll(() => page.evaluate(
        () => JSON.stringify(window.__extensionState)
    )).toContain('lastSuccessfulContact');
    expect(await page.evaluate(() => window.__extensionState.lastError || null))
        .toBeNull();
});
