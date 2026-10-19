import { expect, test, type Page } from '@playwright/test';

// The site opens in the white (light) theme whatever the visitor's system prefers. The toggle switches to dark, and remembers it.

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const lightness = (rgb: string): number => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? ['0', '0', '0']).map(Number) as [number, number, number];
  return (r + g + b) / 3;
};

test.describe('a visitor whose system prefers dark and who has chosen nothing', () => {
  test.use({ colorScheme: 'dark' });

  test('gets the light theme', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await page.locator('html').getAttribute('data-theme')).not.toBe('dark');
    expect(lightness(await background(page))).toBeGreaterThan(200);
  });

  test('can switch to dark, and it is remembered on the next page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(lightness(await background(page))).toBeLessThan(60);
    await page.goto('/methodology');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
