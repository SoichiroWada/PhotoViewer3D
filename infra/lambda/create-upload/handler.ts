import { randomUUID } from "node:crypto";
import path from "node:path";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { INCOMING_PREFIX, MAX_UPLOAD_BYTES, SUPPORTED_TYPES } from "../../lib/catalog-config";

export type PresignedPost = { url: string; fields: Record<string, string> };
export type PostPresigner = (input: {
  key: string; contentType: string; maxBytes: number; metadata: Record<string, string>; expiresSeconds: number;
}) => Promise<PresignedPost>;

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

/** Keep the original name readable for the catalog, but safe as an S3 key segment. */
export function safeFilename(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const name = path.basename(value.replace(/\\/g, "/")).normalize("NFC").replace(/[\u0000-\u001f\u007f/]/g, "").trim();
  if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 200) return;
  return name;
}

export function createUploadHandler(presign: PostPresigner, logger: Pick<Console, "error"> = console) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    let body: Record<string, unknown>;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
      body = JSON.parse(raw);
      if (!body || typeof body !== "object") throw new Error();
    } catch { return json(400, { error: "Request body must be JSON." }); }
    const filename = safeFilename(body.filename);
    const contentType = filename && SUPPORTED_TYPES[path.extname(filename).toLowerCase()];
    if (!filename || !contentType) return json(400, { error: "Only JPEG, PNG and WebP files are supported." });
    if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 1 || body.size > MAX_UPLOAD_BYTES) {
      return json(400, { error: `Photos must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB.` });
    }
    const metadata: Record<string, string> = { uploader: String(event.requestContext.authorizer?.jwt?.claims?.sub ?? "unknown") };
    if (typeof body.lastModified === "number" && Number.isFinite(body.lastModified) && body.lastModified > 0) {
      metadata.mtime = new Date(body.lastModified).toISOString();
    }
    try {
      const key = `${INCOMING_PREFIX}${randomUUID()}/${filename}`;
      const post = await presign({ key, contentType, maxBytes: body.size, metadata, expiresSeconds: 900 });
      return json(200, post);
    } catch (error) {
      logger.error("Upload presign failed", { requestId: event.requestContext.requestId, error });
      return json(500, { error: "Unable to prepare the upload." });
    }
  };
}
