import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { CATALOG_LIMITS } from "../../lib/catalog-config";
import { queryPhotoPages, type CatalogQueryConfig, type QueryClient } from "./query";
import { toPublicPhoto, unavailablePhotoUrls } from "./mapping";
import { CatalogLimitError, PhotoDeliveryUnavailableError, type PhotoUrlResolver, type PublicPhoto } from "./types";

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body), isBase64Encoded: false };
}

export type ListPhotosDependencies = CatalogQueryConfig & {
  client: QueryClient;
  resolveUrls?: PhotoUrlResolver;
  maxResponseBytes?: number;
  logger?: Pick<Console, "error">;
};

export function createListPhotosHandler(dependencies: ListPhotosDependencies) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      const photos: PublicPhoto[] = [];
      const maxBytes = dependencies.maxResponseBytes ?? CATALOG_LIMITS.maxResponseBytes;
      if (!Number.isInteger(maxBytes) || maxBytes < 2) throw new Error("Invalid response limit.");
      let bytes = 2; // JSON array brackets
      const ids = new Set<string>();
      let previousKey: string | undefined;
      for await (const items of queryPhotoPages(dependencies.client, dependencies)) {
        for (const item of items) {
          if (item.collectionId !== dependencies.collectionId) throw new Error("Unexpected catalog collection.");
          const photo = toPublicPhoto(item, dependencies.resolveUrls ?? unavailablePhotoUrls);
          const key = item.takenAtKey as string;
          if (ids.has(photo.id) || (previousKey !== undefined && key > previousKey)) throw new Error("Catalog order or identity changed during pagination.");
          ids.add(photo.id); previousKey = key;
          bytes += Buffer.byteLength(JSON.stringify(photo), "utf8") + (photos.length ? 1 : 0);
          if (bytes > maxBytes) throw new CatalogLimitError("Response exceeds the full-catalog byte limit.");
          photos.push(photo);
        }
      }
      return jsonResponse(200, photos);
    } catch (error) {
      (dependencies.logger ?? console).error("Photo catalog request failed", { requestId: event.requestContext?.requestId, error });
      if (error instanceof CatalogLimitError) return jsonResponse(413, { error: "Photo collection exceeds the current full-catalog limit." });
      if (error instanceof PhotoDeliveryUnavailableError) return jsonResponse(503, { error: "Photo delivery is not configured yet." });
      return jsonResponse(500, { error: "Unable to load photos." });
    }
  };
}
