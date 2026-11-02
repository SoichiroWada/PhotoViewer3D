import { expect, test } from "@playwright/test";
import { photoMetadataUrl } from "./photoApi";

test("exported shell fetches a separate API and has no same-origin backend routes", async ({ page, request, baseURL }) => {
  const metadata = page.waitForRequest(photoMetadataUrl);
  const requests: string[] = [];
  page.on("request", event => requests.push(event.url()));
  await page.goto("/");
  expect((await metadata).url()).toBe(photoMetadataUrl);
  expect(new URL(photoMetadataUrl).origin).not.toBe(new URL(baseURL!).origin);
  await expect(page.getByRole("heading", { name: "3D Photo Viewer" })).toBeVisible();
  await expect(page.locator(".corridor__floor")).toHaveCount(1);
  await expect(page.getByRole("slider")).toBeEnabled();
  expect(requests.some(url => url.startsWith(baseURL + "/api/photos"))).toBeFalsy();
  expect((await request.get("/api/photos")).status()).toBe(404);
  expect((await request.get("/photos")).status()).toBe(404);
});

test("static shell and corridor remain available when the external API is offline", async ({ page }) => {
  await page.route(photoMetadataUrl, route => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "3D Photo Viewer" })).toBeVisible();
  await expect(page.locator(".corridor__floor")).toHaveCount(1);
  await expect(page.locator(".viewer-message[role=alert]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
});
