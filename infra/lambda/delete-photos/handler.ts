import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { MEDIA_PREFIX } from "../../lib/catalog-config";
import { isDemoCaller } from "../../lib/demo-config";

/** One request covers a screenful of selections; larger batches are split by the client. */
export const MAX_DELETE_IDS = 100;
const PHOTO_ID = /^[0-9a-f]{32}$/;
const MEDIA_KEYS = ["originalKey", "smallKey", "mediumKey", "largeKey"] as const;

export type DeleteDependencies = {
  /** Returns the catalog record, or undefined when it no longer exists. */
  getCatalog(photoId: string): Promise<Record<string, unknown> | undefined>;
  deleteCatalog(photoId: string): Promise<void>;
  /** The media bucket is versioned: deletes leave recoverable noncurrent versions for 30 days. */
  deleteMedia(keys: string[]): Promise<void>;
  logger?: Pick<Console, "info" | "error">;
};
export type DeleteResult = { deleted: string[]; failed: { id: string; error: string }[] };

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

export function parseDeleteIds(body: unknown): string[] | undefined {
  const ids = body && typeof body === "object" ? (body as { ids?: unknown }).ids : undefined;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_DELETE_IDS) return;
  if (!ids.every(id => typeof id === "string" && PHOTO_ID.test(id))) return;
  return [...new Set(ids as string[])];
}

/** Removes the catalog record first: a later media failure leaves only invisible, harmless objects. */
export async function deletePhoto(photoId: string, deps: DeleteDependencies): Promise<void> {
  const item = await deps.getCatalog(photoId);
  if (!item) return; // Already deleted; deleting again is a success.
  const keys = MEDIA_KEYS.map(name => item[name])
    .filter((key): key is string => typeof key === "string" && key.startsWith(`${MEDIA_PREFIX}/`) && !key.includes(".."));
  await deps.deleteCatalog(photoId);
  if (keys.length) await deps.deleteMedia(keys);
}

export function createDeleteHandler(deps: DeleteDependencies) {
  const log = deps.logger ?? console;
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    if (isDemoCaller(event.requestContext.authorizer?.jwt?.claims)) return json(403, { error: "Deleting is not available in demo mode." });
    let body: unknown;
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "");
    } catch { return json(400, { error: "Request body must be JSON." }); }
    const ids = parseDeleteIds(body);
    if (!ids) return json(400, { error: `Send between 1 and ${MAX_DELETE_IDS} photo IDs.` });
    const result: DeleteResult = { deleted: [], failed: [] };
    for (const id of ids) {
      try {
        await deletePhoto(id, deps);
        result.deleted.push(id);
      } catch (error) {
        log.error("Photo delete failed", { requestId: event.requestContext.requestId, photoId: id, error });
        result.failed.push({ id, error: "Unable to delete this photo." });
      }
    }
    log.info("Photos deleted", { requestId: event.requestContext.requestId,
      user: event.requestContext.authorizer?.jwt?.claims?.sub, deleted: result.deleted, failed: result.failed.length });
    return json(200, result);
  };
}
