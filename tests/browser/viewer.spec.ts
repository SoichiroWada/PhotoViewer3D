import { expect, test } from "@playwright/test";

const camera = async (page: import("@playwright/test").Page) =>
  Number(await page.locator(".viewer-stage").getAttribute("data-camera-z"));

test("real photo API and viewer support continuous movement, passing, and lightbox", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const response = await request.get("/api/photos");
  expect(response.ok()).toBeTruthy();
  const photos = await response.json();
  expect(photos.length).toBeGreaterThan(2);
  for (let i = 1; i < photos.length; i++) {
    expect(Date.parse(photos[i - 1].takenAt)).toBeGreaterThanOrEqual(Date.parse(photos[i].takenAt));
  }
  const image = await request.get(photos[0].originalUrl);
  expect(image.headers()["content-type"]).toMatch(/^image\//);
  expect((await image.body()).length).toBeGreaterThan(0);
  const cached = await request.get(photos[0].originalUrl, { headers: { "if-none-match": image.headers().etag } });
  expect(cached.status()).toBe(304);
  expect((await request.get("/api/photos/000000000000000000000000")).status()).toBe(404);
  await page.goto("/");
  await expect(page.locator(".photo-count")).toContainText(`${photos.length} photos`);
  await expect(page.locator(".photo-card").first()).toBeVisible();
  await expect.poll(async () => page.locator(".photo-card img").first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBeTruthy();
  await page.screenshot({ path: "test-results/corridor-desktop.png" });
  const first = page.locator('[data-photo-index="0"]');
  const originalPosition = await first.evaluate(el => [
    (el as HTMLElement).style.getPropertyValue("--photo-x"),
    (el as HTMLElement).style.getPropertyValue("--photo-y"),
  ]);
  const initialWidth = (await first.boundingBox())!.width;
  await page.locator(".viewer-stage").hover({ position: { x: 650, y: 400 } });
  await page.mouse.wheel(0, 70);
  await expect.poll(() => camera(page)).toBeGreaterThan(95);
  await expect.poll(() => camera(page)).toBeLessThan(110);
  expect(await first.evaluate(el => [
    (el as HTMLElement).style.getPropertyValue("--photo-x"),
    (el as HTMLElement).style.getPropertyValue("--photo-y"),
  ])).toEqual(originalPosition);
  expect((await first.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => camera(page)).toBeGreaterThan(510);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => camera(page)).toBeLessThan(120);
  await page.mouse.wheel(0, 500);
  await page.mouse.wheel(0, 300);
  await expect(first).toHaveCount(0);
  expect(await page.locator(".photo-card").count()).toBeLessThanOrEqual(31);
  await page.getByRole("button", { name: "Back to present" }).click();
  await expect.poll(() => camera(page)).toBeLessThan(.2);
  await first.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: photos[0].filename })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open original" })).toHaveAttribute("href", photos[0].originalUrl);
  await expect(dialog.getByRole("link", { name: "Open original" })).toHaveAttribute("target", "_blank");
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(first).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "3D Photo Viewer" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/corridor-mobile.png" });
  expect(errors).toEqual([]);
});

test("large catalogs keep the DOM bounded across the timeline", async ({ page }) => {
  const photos = Array.from({ length: 10000 }, (_, index) => ({
    id: `test-${index}`, filename: `Memory ${index}.jpg`,
    thumbnailUrl: "/favicon.svg", originalUrl: "/favicon.svg",
    takenAt: new Date(Date.UTC(2025, 0, 1) - index * 86400000).toISOString(),
  }));
  await page.route("**/api/photos", route => route.fulfill({ json: photos }));
  await page.goto("/");
  await expect(page.locator(".photo-count")).toContainText("10000 photos");
  const slider = page.getByRole("slider");
  await slider.focus();
  await page.keyboard.press("End");
  await expect(page.getByText("You’ve reached the oldest memory.")).toBeVisible({ timeout: 10000 });
  expect(await page.locator(".photo-card").count()).toBeLessThanOrEqual(31);
  await page.getByRole("button", { name: "Return to present", exact: true }).click();
  await expect.poll(() => camera(page), { timeout: 10000 }).toBeLessThan(.2);
  expect(await page.locator(".photo-card").count()).toBeLessThanOrEqual(31);
});

test("empty and error states are actionable", async ({ page }) => {
  await page.route("**/api/photos", route => route.fulfill({ status: 503, json: { error: "The photo directory could not be read." } }));
  await page.goto("/");
  await expect(page.locator(".viewer-message[role=alert]")).toContainText("The photo directory could not be read.");
  await page.unroute("**/api/photos");
  await page.route("**/api/photos", route => route.fulfill({ json: [] }));
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Your corridor is waiting")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload photos" })).toBeEnabled();
});
