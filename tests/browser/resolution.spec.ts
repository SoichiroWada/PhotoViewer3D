import { expect, test, type Page } from "@playwright/test";
import type { Photo } from "../../src/types/photo";

async function travel(page: Page, cameraZ: number) {
  await page.getByRole("slider").evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, cameraZ);
  await expect.poll(async () => Number(await page.locator(".viewer-stage").getAttribute("data-camera-z"))).toBeCloseTo(cameraZ, 1);
}
async function catalog(page: Page, count: number): Promise<Photo[]> {
  const photos: Photo[] = await (await page.request.get("/api/photos")).json();
  expect(photos.length).toBeGreaterThanOrEqual(count);
  const sample = photos.slice(0, count);
  await page.route("**/api/photos", route => route.fulfill({ json: sample }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  return sample;
}

test("distance preloads decode before switching, retain geometry, and avoid threshold oscillation", async ({ page }) => {
  const photos = await catalog(page, 8); const target = photos[6];
  const requests = { medium: 0, large: 0 };
  let releaseMedium!: () => void; let releaseLarge!: () => void;
  const mediumGate = new Promise<void>(resolve => { releaseMedium = resolve; });
  const largeGate = new Promise<void>(resolve => { releaseLarge = resolve; });
  await page.route(`**/api/photos/${target.id}?*`, async route => {
    const size = new URL(route.request().url()).searchParams.get("size");
    if (size === "medium") { requests.medium++; await mediumGate; }
    if (size === "large") { requests.large++; await largeGate; }
    await route.continue();
  });
  try {
    await page.goto("/");
    const card = page.locator('.photo-card[data-photo-index="6"]'); const img = card.locator("img");
    await expect(img).toHaveAttribute("data-resolution", "small");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);
    expect(requests.large).toBe(0); expect(requests.medium).toBe(0);
    const base = await card.evaluate(el => ({ width: getComputedStyle(el).width, imageHeight: getComputedStyle(el.querySelector("img")!).height }));
    await travel(page, 220); // relativeZ 2300: speculative medium, small displayed
    await expect.poll(() => requests.medium).toBe(1);
    await expect(img).toHaveAttribute("data-resolution", "small");
    await travel(page, 550); // relativeZ 1970: medium needed but still delayed
    await expect(img).toHaveAttribute("data-resolution", "small");
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 320)).toBeTruthy();
    expect(requests.medium).toBe(1); // transferred preload, no duplicate request
    releaseMedium();
    await expect(img).toHaveAttribute("data-resolution", "medium");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(800);
    await travel(page, 1770); // relativeZ 750: speculative large
    await expect.poll(() => requests.large).toBe(1);
    await expect(img).toHaveAttribute("data-resolution", "medium");
    await travel(page, 2170); // relativeZ 350: large needed, retain decoded medium
    await expect(img).toHaveAttribute("data-resolution", "medium");
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 800)).toBeTruthy();
    releaseLarge();
    await expect(img).toHaveAttribute("data-resolution", "large");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
    for (const relativeZ of [450, 390, 600, 410]) {
      await travel(page, 2520 - relativeZ);
      await expect(img).toHaveAttribute("data-resolution", "large");
    }
    expect(requests.large).toBe(1);
    const after = await card.evaluate(el => ({ width: getComputedStyle(el).width, imageHeight: getComputedStyle(el.querySelector("img")!).height }));
    expect(after).toEqual(base);
    expect(await img.evaluate(el => getComputedStyle(el).objectFit)).toBe("contain");
    await travel(page, 1620); // retreat beyond large hysteresis, medium ready
    await expect(img).toHaveAttribute("data-resolution", "medium");
    await travel(page, 320); // relativeZ 2200: retain medium
    await expect(img).toHaveAttribute("data-resolution", "medium");
    await travel(page, 20); // relativeZ 2500: back to small
    await expect(img).toHaveAttribute("data-resolution", "small");
    await travel(page, 2170);
    await card.evaluate((el: HTMLButtonElement) => el.click());
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("img")).toHaveAttribute("src", target.originalUrl);
    await expect(dialog.getByRole("link", { name: "Open original" })).toHaveAttribute("href", target.originalUrl);
    await expect.poll(() => dialog.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(1600);
    await page.keyboard.press("Escape");
  } finally { releaseMedium(); releaseLarge(); }
});

test("a failed higher-resolution upgrade leaves the decoded medium photo visible", async ({ page }) => {
  const photos = await catalog(page, 8); const target = photos[6];
  let failed = 0;
  await page.route(`**/api/photos/${target.id}?*`, route => {
    if (new URL(route.request().url()).searchParams.get("size") === "large") {
      failed++; return route.fulfill({ status: 503, body: "Resize unavailable" });
    }
    return route.continue();
  });
  await page.goto("/");
  const card = page.locator('.photo-card[data-photo-index="6"]'); const img = card.locator("img");
  await travel(page, 550);
  await expect(img).toHaveAttribute("data-resolution", "medium");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(800);
  await travel(page, 1770); await expect.poll(() => failed).toBe(1);
  await travel(page, 2170); await expect.poll(() => failed).toBe(2);
  await expect(img).toHaveAttribute("data-resolution", "medium");
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 800)).toBeTruthy();
  await expect(card.locator(".photo-card__failed")).toHaveCount(0);
});

test("initial variant failures fall back to the untouched original", async ({ page }) => {
  const [photo] = await catalog(page, 1);
  await page.route(`**/api/photos/${photo.id}?*`, route => {
    if (new URL(route.request().url()).searchParams.get("size") !== "original") return route.fulfill({ status: 503, body: "Resize unavailable" });
    return route.continue();
  });
  await page.goto("/");
  const img = page.locator(".photo-card img");
  await expect(img).toHaveAttribute("data-resolution", "original");
  await expect(img).toHaveAttribute("src", photo.originalUrl);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(1600);
});
