import { expect, test } from "@playwright/test";
import { getBrowserPhotos } from "./photoApi";

test("grid view lists photos in 5 columns, sorts, opens the lightbox, and remembers the choice", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const photos = await getBrowserPhotos(request);
  await page.goto("/");
  await expect(page.locator(".photo-card").first()).toBeVisible();
  await page.getByRole("button", { name: "Grid" }).click();
  const tiles = page.locator(".photo-tile");
  await expect(tiles).toHaveCount(photos.length);
  await expect(page.locator(".viewer-stage")).toHaveCount(0);

  // Default: newest first, laid out left to right.
  const names = () => page.locator(".photo-tile__filename").allTextContents();
  const byDateDesc = [...photos].sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt)).map(photo => photo.filename);
  expect(await names()).toEqual(byDateDesc);
  const boxes = await Promise.all(Array.from({ length: 6 }, (_, index) => tiles.nth(index).boundingBox()));
  expect(boxes.slice(0, 5).every(box => box!.y === boxes[0]!.y)).toBeTruthy();
  expect(boxes[5]!.y).toBeGreaterThan(boxes[0]!.y);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
  await expect.poll(async () => tiles.first().locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBeTruthy();
  await page.screenshot({ path: "test-results/grid-desktop.png" });

  const sort = page.getByLabel("Sort by");
  await sort.selectOption("date-asc");
  expect(await names()).toEqual([...byDateDesc].reverse());
  await sort.selectOption("name-desc");
  const byName = [...photos].map(photo => photo.filename).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  expect(await names()).toEqual([...byName].reverse());
  await sort.selectOption("name-asc");
  expect(await names()).toEqual(byName);

  await tiles.first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: byName[0] })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(tiles).toHaveCount(photos.length);
  await expect(sort).toHaveValue("name-asc");
  expect(await names()).toEqual(byName);

  // The corridor still works after returning from the grid.
  await page.getByRole("button", { name: "3D" }).click();
  await expect(page.locator(".photo-card").first()).toBeVisible();
  await page.locator(".viewer-stage").hover({ position: { x: 650, y: 400 } });
  await page.mouse.wheel(0, 70);
  await expect.poll(async () => Number(await page.locator(".viewer-stage").getAttribute("data-camera-z"))).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test("grid view uses two columns on phones without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Grid" }).click();
  const tiles = page.locator(".photo-tile");
  await expect(tiles.nth(2)).toBeVisible();
  const [a, b, c] = await Promise.all([0, 1, 2].map(index => tiles.nth(index).boundingBox()));
  expect(a!.y).toBe(b!.y);
  expect(c!.y).toBeGreaterThan(a!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: "test-results/grid-mobile.png" });
});
