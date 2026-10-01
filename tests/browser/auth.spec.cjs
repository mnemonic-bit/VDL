const { test, expect } = require('@playwright/test');
const { reset } = require('./support.cjs');

test('private content redirects to sign in and accepts a valid account', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('browser-test-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Video Download Helper')).toBeVisible();
});

test('administrator can add, suspend, reset, and remove a user', async ({ page }) => {
    await reset(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Users' }).click();

    await page.getByLabel('New username').fill('browser-user');
    await page.getByLabel('Initial password').fill('browser-password');
    await page.getByRole('button', { name: 'Add user' }).click();

    const row = page.locator('.user-row').filter({ hasText: 'browser-user' });
    await expect(row).toBeVisible();
    await row.getByLabel('New password for browser-user').fill('changed-password');
    await row.getByRole('button', { name: 'Save changes' }).click();
    await row.getByRole('button', { name: 'Suspend' }).click();
    await expect(row.getByText('Suspended')).toBeVisible();

    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
});
