import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { createUploadHandler } from "./handler";

const s3 = new S3Client({});
const bucket = process.env.UPLOAD_BUCKET_NAME ?? "";

export const handler = createUploadHandler(({ key, contentType, maxBytes, metadata, expiresSeconds }) => {
  const metaFields = Object.fromEntries(Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name}`, value]));
  return createPresignedPost(s3, {
    Bucket: bucket, Key: key, Expires: expiresSeconds,
    Fields: { "Content-Type": contentType, ...metaFields },
    // The signed policy pins the exact key, type, metadata and declared size.
    Conditions: [["content-length-range", 1, maxBytes], ["eq", "$Content-Type", contentType],
      ...Object.entries(metaFields).map(([name, value]) => ["eq", `$${name}`, value] as ["eq", string, string])],
  });
});
