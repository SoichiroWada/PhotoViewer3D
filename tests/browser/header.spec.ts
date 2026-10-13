import { expect, test } from "@playwright/test";
import { apiBaseUrl } from "./photoApi";

const jwt = (claims: object) => ["{}", JSON.stringify(claims), "sig"].map(part => Buffer.from(part).toString("base64url")).join(".");

test("the full screen button sits left of the photo count in both views and toggles its label", async ({ page }) => {
  await page.goto("/");
  for (const view of ["3D", "Grid"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    const button = page.getByRole("button", { name: "Full screen" });
    await expect(button).toBeVisible();
    const [buttonBox, countBox] = [await button.boundingBox(), await page.locator(".photo-count").boundingBox()];
    expect(buttonBox!.x + buttonBox!.width).toBeLessThan(countBox!.x);
    await button.click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await page.getByRole("button", { name: "Exit full screen" }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect(page.getByRole("button", { name: "Full screen" })).toBeVisible();
  }
});

test("the upload panel counts finished photos and closes itself once all succeed", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("photoViewer3d.refreshToken", "refresh"));
  await page.route("**/auth-config.json", route => route.fulfill({ json: {
    region: "ap-northeast-1", userPoolId: "pool", clientId: "client", cognitoDomain: "https://auth.example.test" } }));
  await page.route("https://auth.example.test/oauth2/token", route => route.fulfill({ json: {
    access_token: "access", id_token: jwt({ email: "user@example.test" }), expires_in: 3600 },
    headers: { "Access-Control-Allow-Origin": "*" } }));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST" };
  let releaseLast!: () => void;
  const lastHeld = new Promise<void>(resolve => { releaseLast = resolve; });
  await page.route("https://uploads.example.test/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (route.request().url().endsWith("/c.jpg")) await lastHeld;
    return route.fulfill({ status: 204, headers: cors });
  });
  await page.route(`${apiBaseUrl}/**`, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(request.url()).pathname;
    if (path === "/session") return route.fulfill({ json: { expiresAt: new Date(Date.now() + 3600_000).toISOString() }, headers: cors });
    if (path === "/photos") return route.fulfill({ json: [], headers: cors });
    if (path === "/uploads") {
      const { filename } = request.postDataJSON() as { filename: string };
      return route.fulfill({ json: { url: `https://uploads.example.test/${filename}`, fields: { key: filename } }, headers: cors });
    }
    return route.fallback();
  });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles(["a.jpg", "b.jpg", "c.jpg"].map(name => ({ name, mimeType: "image/jpeg", buffer: Buffer.from("x") })));
  const panel = page.locator(".upload-panel");
  await expect(panel).toContainText("Uploading 2/3 photos");
  releaseLast();
  await expect(panel).toContainText("3/3 uploaded — processing");
  await expect(panel).toBeHidden({ timeout: 6000 });
});
