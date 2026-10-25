const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

for (const mode of ['native', 'unavailable', 'rejected']) {
    test(`Current Downloads copies the source URL when clipboard API is ${mode}`, async ({ page }) => {
        const url = 'https://fixture.invalid/watch?v=active&title=Tom%27s';
        await seed(page, { id: 'copy-active', status: 'downloading', progress: '25%', url });
        await refresh(page);
        await openCurrent(page);
        await page.evaluate(async mode => {
            window.__testClipboard = navigator.clipboard;
            await window.__testClipboard.writeText('');
            if (mode !== 'native') {
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: mode === 'unavailable' ? undefined : {
                        writeText: () => Promise.reject(new Error('Clipboard access denied')),
                    },
                });
            }
        }, mode);

        const row = page.locator('[data-row-id="copy-active"]');
        await row.locator('.kebab-btn').click();
        await row.getByRole('button', { name: 'Copy URL', exact: true }).click();
        const copiedButton = row.getByRole('button', { name: 'Copied', exact: true });
        await expect(copiedButton).toBeVisible();
        await expect(copiedButton).toBeFocused();
        expect(await page.evaluate(() => window.__testClipboard.readText())).toBe(url);
    });
}

for (const failure of ['false', 'exception']) {
    test(`Current Downloads reports a failed copy when the fallback returns ${failure}`, async ({ page }) => {
        await seed(page, { id: 'copy-failed', status: 'downloading', progress: '25%' });
        await refresh(page);
        await openCurrent(page);
        await page.evaluate(async failure => {
            window.__testClipboard = navigator.clipboard;
            await window.__testClipboard.writeText('previous clipboard contents');
            Object.defineProperty(navigator, 'clipboard', { value: undefined });
            document.execCommand = () => {
                if (failure === 'exception') throw new Error('Copy blocked');
                return false;
            };
        }, failure);

        const row = page.locator('[data-row-id="copy-failed"]');
        await row.locator('.kebab-btn').click();
        const copyButton = row.getByRole('button', { name: 'Copy URL', exact: true });
        await copyButton.click();
        await expect(page.locator('#currentDrawerError')).toBeVisible();
        await expect(page.locator('#currentDrawerError')).toContainText('Could not copy the URL');
        await expect(copyButton).toBeVisible();
        await expect(copyButton).toBeFocused();
        await expect(row.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => window.__testClipboard.readText())).toBe('previous clipboard contents');
    });
}

test('Library Info copies the URL with the clipboard fallback', async ({ page }) => {
    const url = 'https://fixture.invalid/library-source';
    await seed(page, { id: 'copy-library', status: 'finished', url });
    await refresh(page);
    await page.evaluate(async () => {
        window.__testClipboard = navigator.clipboard;
        await window.__testClipboard.writeText('');
        Object.defineProperty(navigator, 'clipboard', { value: undefined });
    });

    const row = page.locator('[data-row-id="copy-library"]');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await row.getByRole('button', { name: 'Copy original URL', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__testClipboard.readText())).toBe(url);
});
