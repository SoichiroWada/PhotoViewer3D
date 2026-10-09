import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PHOTO_COLLECTION_ID } from "../../lib/catalog-config";
import { createListPhotosHandler } from "./handler";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({
  maxAttempts: 2, requestHandler: { connectionTimeout: 1500, requestTimeout: 5000 },
}));
export const handler = createListPhotosHandler({
  client,
  tableName: process.env.PHOTO_TABLE_NAME ?? "",
  collectionId: process.env.PHOTO_COLLECTION_ID ?? PHOTO_COLLECTION_ID,
});
