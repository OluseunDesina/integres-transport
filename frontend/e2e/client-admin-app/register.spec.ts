import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const PASSWORD = 'a-strong-unguessable-passphrase-42';

function uniqueEmail(): string {
  return `e2e-register-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
}

test.describe('client-admin-app registration', () => {
  test('renders an axe-clean registration screen', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('login page links to registration and back', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Register' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('rejects a submission with mismatched passwords and stays axe-clean', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Business name').fill('Acme Shuttle Co');
    await page.getByLabel('Email').fill(uniqueEmail());
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill('something-else');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('Passwords do not match.')).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('is completable by keyboard alone', async ({ page }) => {
    const email = uniqueEmail();
    await page.goto('/register');

    await page.getByLabel('Business name').click();
    await page.keyboard.type('Acme Shuttle Co');
    await page.keyboard.press('Tab');
    await page.keyboard.type(email);
    await page.keyboard.press('Tab');
    await page.keyboard.type('+2348012345678');
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/home$/);
  });

  test('registers, auto-signs in, and lands on an axe-clean home screen', async ({ page }) => {
    const email = uniqueEmail();
    await page.goto('/register');
    await page.getByLabel('Business name').fill('Acme Shuttle Co');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Phone').fill('+2348012345678');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole('heading')).toContainText(email);
    await expect(page.getByText('You have client-admin-app access.')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('registering with an already-used email shows a clear, axe-clean error', async ({
    page,
  }) => {
    const email = uniqueEmail();

    await page.goto('/register');
    await page.getByLabel('Business name').fill('Acme Shuttle Co');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/home$/);

    await page.goto('/register');
    await page.getByLabel('Business name').fill('A Different Business');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: 'A client with this email already exists.' })
    ).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
