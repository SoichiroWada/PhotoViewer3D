import { apiUrl } from "./photoApi";

type TokenSource = () => Promise<string | null>;

async function authorized(getAccessToken: TokenSource): Promise<string> {
  const token = await getAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  return `Bearer ${token}`;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  const message = data?.error ?? data?.message;
  return typeof message === "string" && message ? message : `${fallback} (HTTP ${response.status}).`;
}

/** Obtains the CloudFront signed cookies that authorize `/media/*` image requests. */
export async function startMediaSession(getAccessToken: TokenSource, fetcher: typeof fetch = fetch): Promise<Date> {
  const response = await fetcher(apiUrl("session"), {
    method: "POST", cache: "no-store",
    // Same-origin so the browser stores the Set-Cookie response.
    credentials: "same-origin",
    headers: { Authorization: await authorized(getAccessToken) },
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Unable to start a photo session"));
  const data = await response.json() as { expiresAt?: string };
  return new Date(data.expiresAt ?? Date.now());
}

export type UploadProgress = (loaded: number, total: number) => void;

/** Two steps: the API presigns an S3 POST, then the browser sends the file directly to S3. */
export async function uploadPhoto(file: File, getAccessToken: TokenSource, onProgress?: UploadProgress): Promise<void> {
  const response = await fetch(apiUrl("uploads"), {
    method: "POST", cache: "no-store", credentials: "omit",
    headers: { Authorization: await authorized(getAccessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, size: file.size, lastModified: file.lastModified }),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Unable to prepare the upload"));
  const { url, fields } = await response.json() as { url: string; fields: Record<string, string> };
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append("file", file); // S3 requires the file to be the last field.
  // XMLHttpRequest, unlike fetch, reports upload progress.
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded, event.total); };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve()
      : reject(new Error(`Upload was rejected by storage (HTTP ${request.status}).`));
    request.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    request.send(form);
  });
}
