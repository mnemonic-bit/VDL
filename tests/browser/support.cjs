const { expect } = require('@playwright/test');

async function reset(page) {
    await page.request.post('/__test__/reset');
    await page.goto('/');
    await expect(page.locator('#prefDir')).not.toHaveValue('');
}

async function seed(page, row) {
    const response = await page.request.post('/__test__/row', { data: row });
    expect(response.ok()).toBeTruthy();
    return response.json();
}

async function refresh(page) {
    await page.evaluate(() => fetchHistory());
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
        await page.locator('#newDownloadButton').click();
    }
    await expect(dialog).toBeVisible();
}

module.exports = { reset, seed, refresh, openCurrent, closeCurrent, openNewDownload };
