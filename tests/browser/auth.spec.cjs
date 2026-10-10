const { test, expect } = require('@playwright/test');
const { reset, openSettings } = require('./support.cjs');

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

test('account menu signs the current user out', async ({ page }) => {
    await reset(page);
    await page.locator('#accountMenuButton').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('the last administrator cannot be changed to a normal user', async ({ page }) => {
    await reset(page);
    await openSettings(page);
    await page.getByRole('button', { name: 'Users' }).click();

    const adminRow = page.locator('.user-row').filter({
        has: page.getByLabel('Login name for admin'),
    });
    const roleSelect = adminRow.getByLabel('Role for admin');
    await expect(roleSelect).toBeDisabled();
    await expect(roleSelect).toHaveValue('admin');
    await expect(roleSelect.locator('..')).toHaveAttribute(
        'title',
        'You cannot change the role of the last administrator on the system',
    );

    const backupId = await page.evaluate(async () => {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'backup-admin',
                name: 'Backup Admin',
                password: 'backup-password',
                role: 'admin',
            }),
        });
        return (await response.json()).id;
    });
    await page.evaluate(() => loadUsers());
    await expect(roleSelect).toBeEnabled();
    await expect(roleSelect.locator('..')).not.toHaveAttribute('title');

    await page.evaluate(async userId => {
        await fetch(`/api/users/${userId}`, { method: 'DELETE' });
        await loadUsers();
    }, backupId);
    await expect(roleSelect).toBeDisabled();
    await expect(roleSelect).toHaveValue('admin');
});

test('administrator can add, edit, suspend, and remove a user from the table', async ({ page }) => {
    await reset(page);
    await openSettings(page);
    await page.getByRole('button', { name: 'Users' }).click();

    const newRow = page.locator('.user-row-new');
    await newRow.getByLabel('New login name').fill('browser-user');
    const lockedRow = page.locator('.user-row').first();
    await expect(lockedRow.getByLabel(/Login name for/)).toBeDisabled();
    await expect(lockedRow).toHaveAttribute(
        'title',
        'Save or cancel the current user changes before editing another user',
    );
    await expect(newRow).not.toHaveAttribute('title');
    await newRow.getByLabel('New user name').fill('Browser User');
    await newRow.getByRole('button', { name: 'Save' }).click();

    const createdDialog = page.getByRole('dialog', { name: 'User added' });
    await expect(createdDialog).toBeVisible();
    await expect(createdDialog.getByLabel('Initial password')).toHaveValue(/[0-9a-f]{32}/);
    await createdDialog.getByRole('button', { name: 'Done' }).click();

    const row = page.locator('.user-row').filter({
        has: page.getByLabel('Login name for browser-user'),
    });
    await expect(row).toBeVisible();
    await row.getByLabel('Name for browser-user', { exact: true }).fill('Changed Name');
    await expect(newRow).toHaveAttribute(
        'title',
        'Save or cancel the current user changes before editing another user',
    );
    await expect(row.getByRole('button', { name: 'Save' }).locator('use')).toHaveAttribute('href', '#i-check');
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByLabel('Name for browser-user', { exact: true })).toHaveValue('Browser User');

    await row.getByLabel('Name for browser-user', { exact: true }).fill('Changed Name');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByLabel('Name for browser-user', { exact: true })).toHaveValue('Changed Name');
    await row.getByRole('button', { name: 'Suspend' }).click();
    await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();

    await row.getByRole('button', { name: 'Remove' }).click();
    const removeDialog = page.getByRole('dialog', { name: 'Remove user?' });
    await expect(removeDialog).toContainText('Changed Name');
    await removeDialog.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
});
