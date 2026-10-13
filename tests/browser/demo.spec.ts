import { expect, test } from "@playwright/test";
import { apiBaseUrl, getBrowserPhotos } from "./photoApi";

const jwt = (claims: object) => ["{}", JSON.stringify(claims), "sig"].map(part => Buffer.from(part).toString("base64url")).join(".");

test("DEMO signs in from the gate and shows the collection with upload and delete greyed out", async ({ page, request }) => {
  const photos = await getBrowserPhotos(request);
  let demoLogins = 0;
  await page.route("**/auth-config.json", route => route.fulfill({ json: {
    region: "ap-northeast-1", userPoolId: "pool", clientId: "client", cognitoDomain: "https://auth.example.test" } }));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST" };
  await page.route(`${apiBaseUrl}/**`, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(request.url()).pathname;
    if (path === "/demo-login") {
      demoLogins++;
      return route.fulfill({ headers: cors, json: { access_token: jwt({ "cognito:groups": ["demo"] }),
        id_token: jwt({ email: "demo@photoviewer3d.invalid" }), expires_in: 3600 } });
    }
    if (path === "/session") return route.fulfill({ json: { expiresAt: new Date(Date.now() + 3600_000).toISOString() }, headers: cors });
    if (path === "/photos") return route.fulfill({ json: photos, headers: cors });
    return route.fulfill({ status: 403, headers: cors, json: { error: "unexpected" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "DEMO" }).click();
  await expect(page.locator(".photo-card").first()).toBeVisible();
  expect(demoLogins).toBe(1);
  await expect(page.getByRole("button", { name: /^Upload/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Exit demo" })).toBeEnabled();

  await page.getByRole("button", { name: "Grid" }).click();
  await page.locator(".photo-tile").first().click({ modifiers: ["Control"] });
  await expect(page.getByText("1 selected")).toBeVisible();
  const remove = page.getByRole("button", { name: /^Delete/ });
  await expect(remove).toBeDisabled();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A reload stays in the demo by asking for demo tokens again.
  await page.reload();
  await expect(page.locator(".photo-tile").first()).toBeVisible();
  expect(demoLogins).toBe(2);
  await page.getByRole("button", { name: "Exit demo" }).click();
  await expect(page.getByRole("button", { name: "DEMO" })).toBeVisible();
});
