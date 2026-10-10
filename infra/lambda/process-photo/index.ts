import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createProcessHandler } from "./handler";
import { renderVariants } from "./image";

const s3 = new S3Client({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.PHOTO_TABLE_NAME ?? "";
const mediaBucket = process.env.MEDIA_BUCKET_NAME ?? "";

export const handler = createProcessHandler({
  timeZone: process.env.PHOTO_TIME_ZONE || "UTC",
  render: renderVariants,
  async getIncoming(bucket, key) {
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = Buffer.from(await result.Body!.transformToByteArray());
      return { bytes, lastModified: result.LastModified, metadata: result.Metadata ?? {} };
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  },
  async deleteIncoming(bucket, key) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
  async putMedia(key, body, contentType) {
    // Keys are content-addressed, so cached copies never go stale.
    await s3.send(new PutObjectCommand({ Bucket: mediaBucket, Key: key, Body: body, ContentType: contentType,
      CacheControl: "max-age=31536000, immutable" }));
  },
  async photoExists(photoId) {
    const result = await db.send(new GetCommand({ TableName: tableName, Key: { photoId }, ProjectionExpression: "photoId" }));
    return Boolean(result.Item);
  },
  async putCatalog(item) {
    try {
      await db.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(photoId)" }));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  },
});
