import type { APIRequestContext } from "@playwright/test";
import { createPhotoApi } from "../../src/lib/api/photoApi";

export const apiBaseUrl = process.env.TEST_API_BASE_URL ?? "http://127.0.0.1:4000";
export const photoBaseUrl = process.env.TEST_PHOTO_BASE_URL ?? apiBaseUrl;
const config = { apiBaseUrl, photoBaseUrl };
export const photoMetadataUrl = createPhotoApi(config).metadataUrl();

export function getBrowserPhotos(request: APIRequestContext) {
  return createPhotoApi({ ...config, fetch: async input => {
    const response = await request.get(String(input));
    return new Response(await response.text(), { status: response.status(), headers: response.headers() });
  } }).getPhotos();
}
