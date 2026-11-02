import { getBrowserPhotos } from "./photoApi";
import { expect, test } from "@playwright/test";

const camera = async (page: import("@playwright/test").Page) =>
  Number(await page.locator(".viewer-stage").getAttribute("data-camera-z"));

test("the wall shows newer photos on the left and turns toward the past like the 3D view", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const photos = await getBrowserPhotos(request);
  await page.goto("/");
  await expect(page.locator(".photo-count")).toContainText(`${photos.length} photos`);
  await page.getByRole("button", { name: "Wall", exact: true }).click();
  await expect(page.getByRole("button", { name: "Wall", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".wall-belt polygon").first()).toBeAttached();
  const first = page.locator('.photo-card--wall[data-photo-index="0"]');
  await expect(first).toBeVisible();
  const stage = (await page.locator(".viewer-stage").boundingBox())!;
  const before = (await first.boundingBox())!;
  expect(before.x + before.width / 2).toBeLessThan(stage.x + stage.width / 2);
  expect((await page.locator('.photo-card--wall[data-photo-index="2"]').boundingBox())!.x).toBeGreaterThan(before.x);
  await expect.poll(async () => first.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBeTruthy();
  await page.screenshot({ path: "test-results/wall-desktop.png" });

  // Pulling the wheel toward you goes back in time, exactly as in 3D, and slides the wall left.
  await page.locator(".viewer-stage").hover({ position: { x: 650, y: 400 } });
  await page.mouse.wheel(0, 140);
  await expect.poll(() => camera(page)).toBeGreaterThan(200);
  await expect.poll(async () => (await first.boundingBox())!.x).toBeLessThan(before.x - 20);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => camera(page)).toBeGreaterThan(620);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => camera(page)).toBeLessThan(220);
  await page.screenshot({ path: "test-results/wall-moved.png" });

  // The 3D view keeps the same place in time once the camera has come to rest.
  let position = -1;
  await expect.poll(async () => { const previous = position; position = await camera(page); return position === previous; }).toBe(true);
  await page.getByRole("button", { name: "3D", exact: true }).click();
  expect(Math.abs(await camera(page) - position)).toBeLessThan(1);
  await page.getByRole("button", { name: "Wall", exact: true }).click();
  await page.getByRole("button", { name: "Back to present" }).click();
  await expect.poll(() => camera(page)).toBeLessThan(.2);
  await first.click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: photos[0].filename })).toBeVisible();
  await page.keyboard.press("Escape");

  // The choice is remembered.
  await page.reload();
  await expect(page.getByRole("button", { name: "Wall", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".photo-card--wall").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/wall-mobile.png" });
  expect(errors).toEqual([]);
});
