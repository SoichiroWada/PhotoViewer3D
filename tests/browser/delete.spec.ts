import { expect, test, type Page } from "@playwright/test";
import { apiBaseUrl, getBrowserPhotos } from "./photoApi";

const jwt = (claims: object) => ["{}", JSON.stringify(claims), "sig"].map(part => Buffer.from(part).toString("base64url")).join(".");

/** Signs in as a mocked Cognito user; the catalog is the fixture photos and deletes are recorded. */
async function signedIn(page: Page, photos: unknown[], failIds: string[] = []) {
  const deletes: string[][] = [];
  await page.addInitScript(() => localStorage.setItem("photoViewer3d.refreshToken", "refresh"));
  await page.route("**/auth-config.json", route => route.fulfill({ json: {
    region: "ap-northeast-1", userPoolId: "pool", clientId: "client", cognitoDomain: "https://auth.example.test" } }));
  await page.route("https://auth.example.test/oauth2/token", route => route.fulfill({ json: {
    access_token: "access", id_token: jwt({ email: "user@example.test" }), expires_in: 3600 },
    headers: { "Access-Control-Allow-Origin": "*" } }));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST" };
  await page.route(`${apiBaseUrl}/**`, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(request.url()).pathname;
    if (path === "/session") return route.fulfill({ json: { expiresAt: new Date(Date.now() + 3600_000).toISOString() }, headers: cors });
    if (path === "/photos" && request.method() === "GET") return route.fulfill({ json: photos, headers: cors });
    if (path === "/photos/delete") {
      expect(request.headers().authorization).toBe("Bearer access");
      const { ids } = request.postDataJSON() as { ids: string[] };
      deletes.push(ids);
      return route.fulfill({ headers: cors, json: {
        deleted: ids.filter(id => !failIds.includes(id)),
        failed: ids.filter(id => failIds.includes(id)).map(id => ({ id, error: "Unable to delete this photo." })) } });
    }
    return route.fallback();
  });
  return deletes;
}

test("selected photos are deleted only after confirming, and Cancel keeps them", async ({ page, request }) => {
  const photos = await getBrowserPhotos(request);
  const deletes = await signedIn(page, photos);
  await page.goto("/");
  await page.getByRole("button", { name: "Grid" }).click();
  const tiles = page.locator(".photo-tile");
  await expect(tiles).toHaveCount(photos.length);
  const names = await page.locator(".photo-tile__filename").allTextContents();
  const toolbarDelete = page.locator(".grid-toolbar").getByRole("button", { name: /^Delete/ });
  await expect(toolbarDelete).toBeDisabled();

  // Tick one, then Shift-tick a fourth: four photos in display order.
  await page.getByRole("checkbox", { name: `Select ${names[0]}` }).click();
  await page.getByRole("checkbox", { name: `Select ${names[3]}` }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".grid-toolbar__count")).toHaveText("4 selected");
  // While selecting, a plain click toggles instead of opening the lightbox.
  await tiles.nth(5).locator(".photo-tile__open").click();
  await expect(page.locator(".grid-toolbar__count")).toHaveText("5 selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tiles.nth(5).locator(".photo-tile__open").click();

  await toolbarDelete.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`${names[0]}、${names[1]}、${names[2]} ほか1枚を削除しますか？`);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.screenshot({ path: "test-results/delete-confirm.png" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(deletes).toEqual([]);
  await expect(tiles).toHaveCount(photos.length);

  await page.keyboard.press("Delete");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tiles).toHaveCount(photos.length - 4);
  expect(deletes).toHaveLength(1);
  expect(deletes[0]).toHaveLength(4);
  await expect(page.locator(".grid-toolbar__count")).not.toContainText("selected");
  expect(await page.locator(".photo-tile__filename").allTextContents()).toEqual(names.slice(4));
});

test("a single photo names itself, and failures stay selected with an error", async ({ page, request }) => {
  const photos = await getBrowserPhotos(request);
  await signedIn(page, photos, [photos[0]!.id]);
  await page.goto("/");
  await page.getByRole("button", { name: "Grid" }).click();
  await page.locator(".photo-tile").first().locator(".photo-tile__open").click({ modifiers: ["Control"] });
  await page.locator(".grid-toolbar").getByRole("button", { name: "Delete (1)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`${photos[0]!.filename} を削除しますか？`);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByRole("alert")).toContainText("1 photo(s) could not be deleted");
  await expect(page.locator(".photo-tile")).toHaveCount(photos.length);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".grid-toolbar__count")).toHaveText("1 selected");
});

test("the local backend shows no selection or delete controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Grid" }).click();
  await expect(page.locator(".photo-tile").first()).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
});
