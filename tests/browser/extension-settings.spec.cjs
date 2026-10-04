const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

const companionHeaders = {
    Origin: 'moz-extension://01234567-89ab-cdef-0123-456789abcdef',
    'X-VDL-Companion-Protocol': '1',
    'X-VDL-Companion-Version': '1.0.2',
};

async function pairCompanion(page) {
    const origin = await page.evaluate(() => window.location.origin);
    const codeResponse = await page.request.post('/api/extension/pairing-codes');
    expect(codeResponse.ok()).toBeTruthy();
    const { code } = await codeResponse.json();
    const pairResponse = await page.request.post('/api/extension/pair', {
        headers: companionHeaders,
        data: {
            code,
            origin,
            device_label: 'Firefox browser test',
            extension_version: '1.0.2',
            protocol_version: 1,
        },
    });
    expect(pairResponse.ok()).toBeTruthy();
    return (await pairResponse.json()).token;
}

test('Browser Extension settings allow operator-approved private HTTP pairing', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Browser Extension' }).click();
    const section = page.locator('#settings-browser-extension');
    await expect(section).toBeVisible();
    await expect(section.getByText('Cookies can grant the same website access')).toBeVisible();
    await expect(page.locator('#extensionCreatePairing')).toBeEnabled();
    await expect(page.locator('#extensionHttpsStatus')).toContainText('private HTTP');
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'http:', hostname: '192.168.1.20',
    }, false))).toBe(false);
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'http:', hostname: '192.168.1.20',
    }, true))).toBe(true);
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'http:', hostname: '100.96.0.2',
    }, true))).toBe(true);
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'https:', hostname: 'vdl.example',
    }))).toBe(true);
    const packageLink = page.locator('#extensionInstallLink');
    await expect(packageLink).toHaveAttribute(
        'href', '/browser-extension/vdl-companion-firefox.xpi?download=1',
    );
    await expect(packageLink).toHaveAttribute('download', 'vdl-companion-firefox.xpi');
    await expect(packageLink).toHaveText('Download unsigned XPI');
    await expect(page.locator('#extensionInstallHint')).toContainText('not Mozilla-signed');
    const downloadPromise = page.waitForEvent('download');
    await packageLink.click();
    const packageDownload = await downloadPromise;
    expect(packageDownload.suggestedFilename()).toBe('vdl-companion-firefox.xpi');
    await expect(page.locator('#extensionStatus')).toContainText('Firefox Release cannot install it');
    await packageDownload.cancel();
    await expect(page.locator('#extensionNoConnections')).toBeVisible();
    await page.locator('#extensionCreatePairing').click();
    const pairingDialog = page.getByRole('dialog', { name: 'Pair Firefox with VDL' });
    await expect(pairingDialog).toBeVisible();
    await expect(page.locator('.extension-pairing-item textarea')).toHaveCount(0);
    await expect(page.locator('#extensionPairingString')).toHaveValue(/^vdl-pair-v1:/);
    await expect(pairingDialog.getByText(/^[45]:\d{2} remaining$/)).toBeVisible();
    await expect(page.locator('#extensionPairingString')).toBeHidden();
    await expect(page.locator('#extensionCopyPairing')).toBeFocused();
    await page.setViewportSize({ width: 375, height: 700 });
    expect(await pairingDialog.evaluate(element => (
        element.scrollWidth <= element.clientWidth
    ))).toBeTruthy();
    await pairingDialog.getByRole('button', { name: 'Copy pairing string' }).click();
    await expect(page.locator('#extensionCopyPairing')).toHaveText('Copied');
    await expect(page.locator('#extensionPairingFeedback')).toHaveText('Copied. Continue in VDL Companion.');
    await pairingDialog.getByText('Show pairing string').click();
    await expect(page.locator('#extensionPairingString')).toBeVisible();
    await pairingDialog.getByRole('button', { name: 'Invalidate pairing string' }).click();
    await expect(pairingDialog).toBeHidden();
    await expect(page.locator('#extensionStatus')).toHaveText('Pairing string invalidated.');
});

test('authenticated stopped rows require a fresh Firefox handoff', async ({ page }) => {
    await seed(page, {
        id: 'firefox1',
        status: 'cancelled',
        title: 'Signed-in fixture',
        url: 'https://video.example/watch/1',
        browser_authenticated: true,
    });
    await refresh(page);
    await openCurrent(page);
    const row = page.locator('[data-row-id="firefox1"]');
    await expect(row.getByText('Firefox session')).toBeVisible();
    await expect(row.getByText('Re-send from Firefox')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Continue' })).toHaveCount(0);
});

test('Firefox companion downloads reconcile while the VDL tab has no animation frames', async ({ page }) => {
    const token = await pairCompanion(page);
    await page.request.post('/__test__/hold-downloads');
    try {
        await page.evaluate(() => {
            window.requestAnimationFrame = () => 1;
        });
        const response = await page.request.post('/api/extension/downloads', {
            headers: {
                ...companionHeaders,
                Authorization: `Bearer ${token}`,
            },
            data: {
                schema: 1,
                request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                page_url: 'https://video.example/watch/live-extension',
                captured_at: Math.floor(Date.now() / 1000),
                cookies: [],
            },
        });
        expect(response.status()).toBe(201);
        const { id } = await response.json();

        await expect(page.locator('#currentBadge')).toHaveText('1');
        await openCurrent(page);
        await expect(page.locator(`#activeList [data-row-id="${id}"]`)).toBeVisible();
    } finally {
        await page.request.post('/__test__/release-downloads');
    }
});
