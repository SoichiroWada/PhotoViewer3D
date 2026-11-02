import { getBrowserPhotos } from "./photoApi";
import { expect, test } from "@playwright/test";

test("actual year markers sit on the right wall and approach at their photo depth", async ({ page, request }) => {
  const photos = await getBrowserPhotos(request);
  const expected: { year: number; index: number }[] = [];
  let previous: number | undefined;
  photos.forEach((photo: { takenAt: string }, index: number) => {
    const year = new Date(photo.takenAt).getFullYear();
    if (year !== previous) { expected.push({ year, index }); previous = year; }
  });
  await page.goto("/");
  await expect(page.locator(".photo-count")).toContainText(`${photos.length} photos`);
  const labels = page.locator(".corridor-year");
  await expect(labels).toHaveCount(expected.filter(marker => marker.index < 26).length);
  for (const marker of expected.filter(marker => marker.index < 26)) {
    const label = page.locator(`.corridor-year[data-photo-index="${marker.index}"]`);
    await expect(label).toHaveText(String(marker.year));
    await expect(label).toHaveAttribute("data-photo-z", String(marker.index * 420));
    await expect(label).toHaveAttribute("data-relative-z", (marker.index * 420).toFixed(2));
    const box = (await label.boundingBox())!;
    const stage = (await page.locator(".viewer-stage").boundingBox())!;
    expect(box.x).toBeGreaterThan(stage.x + stage.width / 2);
    const rotation = await label.locator("span").evaluate(el => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    });
    expect(rotation).toBe(-90);
    expect(await label.evaluate(el => getComputedStyle(el).pointerEvents)).toBe("none");
  }
  const first = labels.first();
  const before = (await first.boundingBox())!;
  await page.locator(".viewer-stage").hover({ position: { x: 600, y: 300 } });
  await page.mouse.wheel(0, 70);
  await expect.poll(async () => Number(await page.locator(".viewer-stage").getAttribute("data-camera-z"))).toBeGreaterThan(104);
  const after = (await first.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height);
  expect(after.x).toBeGreaterThan(before.x);
  const relative = Number(await first.getAttribute("data-relative-z"));
  expect(relative).toBeLessThan(-104);
  await page.screenshot({ path: "test-results/corridor-years-desktop.png" });
  // The same wall marker stays on the right after responsive resizing.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = (await first.boundingBox())!;
  expect(mobileBox.x).toBeGreaterThan(195);
  await page.screenshot({ path: "test-results/corridor-years-mobile.png" });
  await page.locator(".viewer-stage").hover({ position: { x: 200, y: 300 } });
  await page.mouse.wheel(0, 700);
  await page.mouse.wheel(0, 400);
  await expect(page.locator('.corridor-year[data-photo-index="0"]')).toHaveCount(0);
});
