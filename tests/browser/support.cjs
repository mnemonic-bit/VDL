const { expect } = require('@playwright/test');

async function reset(page) {
    await page.request.post('/login', {
        form: { username: 'admin', password: 'browser-test-password' },
    });
    await page.request.post('/__test__/reset');
    await page.goto('/');
    await expect(page.locator('#prefDir')).not.toHaveValue('');
}

async function seed(page, row) {
    const response = await page.request.post('/__test__/row', { data: { ...(row.status === 'finished' ? { file: true, name: `${row.id}.mp4` } : {}), ...row } });
    expect(response.ok()).toBeTruthy();
    return response.json();
}

async function refresh(page) {
    await page.evaluate(() => fetchHistory());
}

async function holdNativeMedia(page) {
    // Synthetic media harnesses own their events. Decoding the dummy fixture
    // bytes alongside them would introduce unrelated native source errors.
    await page.route('**/api/file/**', () => {});
}

async function switchAccount(page, username, password) {
    // API-only logout leaves the old Library running: its pending reads can
    // redirect to sign-in or clear the next session. Unload it before login.
    await page.locator('#accountMenuButton').click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();

    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const signedIn = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/login'
        && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await signedIn).status()).toBe(302);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#currentUsername')).toHaveText(username);
    await expect(page.locator('#endlessPlaybackButton')).toBeVisible();
}

async function openCurrent(page) {
    const drawer = page.locator('#currentDownloadsDrawer');
    if (!(await drawer.isVisible())) {
        await page.locator('#currentDownloadsButton').click();
    }
    await expect(drawer).toBeVisible();
}

async function closeCurrent(page) {
    const drawer = page.locator('#currentDownloadsDrawer');
    if (await drawer.isVisible()) {
        await drawer.getByRole('button', { name: 'Close current downloads' }).click();
    }
    await expect(drawer).toBeHidden();
}

async function openNewDownload(page) {
    const dialog = page.locator('#newDownloadDialog');
    if (!(await dialog.isVisible())) {
        await page.locator('.app-title').click();
        // Exercise the shortcut without pasting over saved drafts in helpers.
        // download-entry.spec.cjs covers native clipboard paste separately.
        await page.locator('body').dispatchEvent('keydown', { key: 'v', ctrlKey: true });
    }
    await expect(dialog).toBeVisible();
}

async function openSettings(page) {
    const settings = page.locator('#settingsPage');
    if (!(await settings.isVisible())) {
        await page.locator('#accountMenuButton').click();
        await page.locator('#settingsButton').click();
    }
    await expect(settings).toBeVisible();
}

module.exports = {
    reset,
    seed,
    refresh,
    holdNativeMedia,
    switchAccount,
    openCurrent,
    closeCurrent,
    openNewDownload,
    openSettings,
};
