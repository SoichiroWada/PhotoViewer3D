import type { Photo } from "@/types/photo";
import type { PhotoSize } from "../photoResolution";

export type PhotoApiConfig = {
  apiBaseUrl?: string;
  photoBaseUrl?: string;
  fetch?: typeof fetch;
  /** Resolves root-relative bases such as `/api`; defaults to the page origin. */
  origin?: string;
  /** Bearer token for authenticated (Cognito) deployments. */
  getAccessToken?: () => Promise<string | null>;
};

function pageOrigin(): string | undefined {
  return typeof location === "undefined" ? undefined : location.origin;
}

function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Photo endpoints must use HTTP or HTTPS without embedded credentials.");
  }
  return url;
}

function baseUrl(value: string | undefined, name: string, origin = pageOrigin()): URL {
  if (!value?.trim()) throw new Error(`Set ${name} before building the frontend.`);
  // Same-origin deployments (CloudFront) use root-relative bases like `/api`.
  const relative = value.trim().startsWith("/") && !value.trim().startsWith("//");
  if (relative && !origin) throw new Error(`${name} is relative, but no page origin is available.`);
  const url = httpUrl(relative ? new URL(value.trim(), origin).href : value.trim());
  if (url.search || url.hash) throw new Error(`${name} must not include a query or fragment.`);
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url;
}

/** Absolute URLs are preserved verbatim, including opaque/signed image URLs. */
export function getPhotoUrl(value: string, photoBaseUrl: string, origin?: string): string {
  if (/^https?:\/\//i.test(value)) { httpUrl(value); return value; }
  if (!value || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error("Invalid photo image URL.");
  }
  return httpUrl(new URL(value, baseUrl(photoBaseUrl, "NEXT_PUBLIC_PHOTO_BASE_URL", origin)).href).href;
}

/** Phase 1 uses the existing size query contract on local/external endpoints. */
export function getPhotoVariantUrl(photo: Photo, size: PhotoSize): string {
  if (size === "original") return photo.originalUrl;
  if (photo.variants) return photo.variants[size];
  const value = photo.thumbnailUrl;
  // Use a dummy origin only to inspect relative URLs; it is never returned.
  const url = new URL(value, "https://photo-url.invalid");
  const knownSize = ["small", "medium", "large"].includes(url.searchParams.get("size") ?? "");
  const photoEndpoint = /\/(?:api\/)?photos\/[^/]+\/?$/.test(url.pathname);
  // Fixed assets (including signed originals) need no invented resize endpoint.
  if (!photoEndpoint && !knownSize) return value;
  const hashIndex = value.indexOf("#");
  const hash = hashIndex < 0 ? "" : value.slice(hashIndex);
  const target = hashIndex < 0 ? value : value.slice(0, hashIndex);
  const queryIndex = target.indexOf("?");
  const pathname = queryIndex < 0 ? target : target.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : target.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  params.set("size", size);
  return `${pathname}?${params}${hash}`;
}

export function createPhotoApi(config: PhotoApiConfig) {
  // Resolve configuration at request time: a missing setting does not break SSR.
  function metadataUrl() {
    return new URL("photos", baseUrl(config.apiBaseUrl, "NEXT_PUBLIC_API_BASE_URL", config.origin ?? pageOrigin())).href;
  }
  function normalize(data: unknown): Photo[] {
    if (!Array.isArray(data)) throw new Error("The photo API returned an invalid collection.");
    const origin = config.origin ?? pageOrigin();
    const imageBase = config.photoBaseUrl?.trim() || baseUrl(config.apiBaseUrl, "NEXT_PUBLIC_API_BASE_URL", origin).origin;
    const ids = new Set<string>();
    return data.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("The photo API returned an invalid photo.");
      const photo = entry as Record<string, unknown>;
      for (const key of ["id", "filename", "thumbnailUrl", "originalUrl", "takenAt"]) {
        if (typeof photo[key] !== "string" || !photo[key]) throw new Error(`The photo API returned an invalid ${key}.`);
      }
      const { id, filename, thumbnailUrl, originalUrl, takenAt, variants } = photo as unknown as Photo;
      if (!Number.isFinite(Date.parse(takenAt)) || ids.has(id)) throw new Error("The photo API returned an invalid date or duplicate ID.");
      ids.add(id);
      const resolve = (value: string) => getPhotoUrl(value, imageBase, origin);
      const normalized: Photo = { id, filename, takenAt, thumbnailUrl: resolve(thumbnailUrl), originalUrl: resolve(originalUrl) };
      if (variants !== undefined) {
        if (!variants || typeof variants !== "object") throw new Error("The photo API returned invalid variants.");
        const sizes = variants as Record<string, unknown>;
        for (const size of ["small", "medium", "large"]) {
          if (typeof sizes[size] !== "string" || !sizes[size]) throw new Error("The photo API returned invalid variants.");
        }
        normalized.variants = { small: resolve(variants.small), medium: resolve(variants.medium), large: resolve(variants.large) };
      }
      return normalized;
    });
  }
  return {
    metadataUrl,
    async getPhotos(options: { signal?: AbortSignal } = {}): Promise<Photo[]> {
      const url = metadataUrl();
      const token = config.getAccessToken ? await config.getAccessToken() : null;
      if (config.getAccessToken && !token) throw new Error("Your session has expired. Please sign in again.");
      const response = await (config.fetch ?? fetch)(url, {
        signal: options.signal, cache: "no-store", credentials: "omit",
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      let data: unknown;
      try { data = await response.json(); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        throw new Error(`The photo API returned invalid JSON (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        const error = data && typeof data === "object" && "error" in data ? (data as { error: unknown }).error : null;
        throw new Error(typeof error === "string" && error ? error : `Unable to load photos (HTTP ${response.status}).`);
      }
      return normalize(data);
    },
  };
}

export function getPhotos(options: { signal?: AbortSignal; getAccessToken?: () => Promise<string | null> } = {}): Promise<Photo[]> {
  // Explicit accesses let Next.js inline only these public values at build time.
  return createPhotoApi({
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    photoBaseUrl: process.env.NEXT_PUBLIC_PHOTO_BASE_URL,
    getAccessToken: options.getAccessToken,
  }).getPhotos({ signal: options.signal });
}

/** Base for other API calls (session, uploads), honoring deployment prefixes. */
export function apiUrl(path: string): string {
  return new URL(path, baseUrl(process.env.NEXT_PUBLIC_API_BASE_URL, "NEXT_PUBLIC_API_BASE_URL")).href;
}
