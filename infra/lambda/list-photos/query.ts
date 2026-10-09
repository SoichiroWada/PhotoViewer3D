import { QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { CATALOG_LIMITS, PHOTO_INDEX_NAME } from "../../lib/catalog-config";
import { CatalogLimitError } from "./types";

export interface QueryClient {
  send(command: QueryCommand): Promise<Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">>;
}
export type QueryLimits = { maxItems: number; maxPages: number; pageSize: number };
export type CatalogQueryConfig = { tableName: string; collectionId: string; limits?: QueryLimits };

/** Page iterator allows a later continuation-token API without changing storage. */
export async function* queryPhotoPages(client: QueryClient, config: CatalogQueryConfig) {
  const { tableName, collectionId } = config;
  const limits = config.limits ?? CATALOG_LIMITS;
  if (!tableName || !collectionId || Object.values(limits).some(value => !Number.isInteger(value) || value < 1)) {
    throw new Error("Invalid photo query configuration.");
  }
  let key: QueryCommandOutput["LastEvaluatedKey"];
  const seenKeys = new Set<string>();
  let total = 0;
  for (let page = 0; page < limits.maxPages; page++) {
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: PHOTO_INDEX_NAME,
      KeyConditionExpression: "#collection = :collection",
      ExpressionAttributeNames: { "#collection": "collectionId" },
      ExpressionAttributeValues: { ":collection": collectionId },
      ScanIndexForward: false,
      Limit: limits.pageSize,
      ExclusiveStartKey: key,
    }));
    const items = result.Items ?? [];
    total += items.length;
    if (total > limits.maxItems) throw new CatalogLimitError("Photo count exceeds the full-catalog limit.");
    yield items;
    key = result.LastEvaluatedKey;
    if (!key || Object.keys(key).length === 0) return;
    const signature = JSON.stringify(Object.keys(key).sort().map(name => [name, key![name]]));
    if (seenKeys.has(signature)) throw new Error("DynamoDB repeated a pagination key.");
    seenKeys.add(signature);
  }
  throw new CatalogLimitError("Query page count exceeds the full-catalog limit.");
}
