import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { createDeleteHandler } from "./handler";

const s3 = new S3Client({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.PHOTO_TABLE_NAME ?? "";
const mediaBucket = process.env.MEDIA_BUCKET_NAME ?? "";

export const handler = createDeleteHandler({
  async getCatalog(photoId) {
    const result = await db.send(new GetCommand({ TableName: tableName, Key: { photoId } }));
    return result.Item;
  },
  async deleteCatalog(photoId) {
    await db.send(new DeleteCommand({ TableName: tableName, Key: { photoId } }));
  },
  async deleteMedia(keys) {
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: mediaBucket,
      Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }));
    if (result.Errors?.length) throw new Error(`S3 refused ${result.Errors.length} media deletes: ${result.Errors[0]!.Code}`);
  },
});
