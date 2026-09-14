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

module.exports = { reset, seed, refresh };
