import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function openComposer(page: Page) {
  await signup(page, `composer-type-${Date.now()}@rakazo.test`, "password12", "Draft Writer");
  await completeOnboarding(page);
  return page.getByRole("combobox", { name: /Message/ });
}

async function expectTypography(composer: Locator, fontSize: string, lineHeight: string) {
  const mirror = composer.locator("+ [aria-hidden]");
  await expect(composer).toHaveCSS("font-size", fontSize);
  await expect(mirror).toHaveCSS("font-size", fontSize);
  await expect(composer).toHaveCSS("line-height", lineHeight);
  await expect(mirror).toHaveCSS("line-height", lineHeight);
  expect((await composer.boundingBox())!.width).toBeCloseTo((await mirror.boundingBox())!.width, 1);
}

test.describe("touch composer", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("keeps readable, aligned text in portrait and landscape without restricting zoom", async ({
    page,
  }, testInfo) => {
    const composer = await openComposer(page);
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=/i);

    for (const size of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size);
      await composer.fill("A draft to check the mobile text and caret.");
      await expectTypography(composer, "16px", "24px");
      await expect(composer).toBeFocused();
      await captureScreenshot(page, testInfo, `composer-touch-${size.width}`);

      const draft = "A longer draft that wraps across several lines. ".repeat(12);
      await composer.fill(`${draft}\nA final line.`);
      await expectTypography(composer, "16px", "24px");
      expect(await composer.evaluate((field) => field.scrollHeight)).toBeGreaterThan(
        (await composer.boundingBox())!.height,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await composer.blur();
      await composer.focus();
      await expect(composer).toHaveValue(`${draft}\nA final line.`);
    }
  });
});

test("keeps the existing desktop composer typography", async ({ page }, testInfo) => {
  const composer = await openComposer(page);
  await composer.fill("A desktop draft with the original typography.");
  await expectTypography(composer, "15px", "22px");
  await captureScreenshot(page, testInfo, "composer-desktop-typography");
});
