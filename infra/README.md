# AWS infrastructure — Phase 2

This directory defines the AWS foundation for 3D Photo Viewer using **AWS CDK
v2 and TypeScript**. It is separate from the working static frontend and local
photo backend. **No AWS resources have been deployed.** The frontend still uses
its existing local API configuration.

The default region is **Tokyo (`ap-northeast-1`)**. The account is resolved from
the deployment environment through CDK; no account ID is hardcoded. There are
no VPC or other environment lookups, so synthesis does not need AWS credentials.

## Validate locally

Requires Node.js 22 or newer. The Lambda target is Node.js 22; local validation
also works on Node.js 24. Infrastructure dependencies and their lockfile live
here, independently of the root application's dependencies.

```bash
cd infra
npm install
npm test
npm run build
npx cdk synth --no-lookups
```

`npm run build` compiles this TypeScript project to `dist/`. CDK runs the source
entry point through `tsx` and bundles the Lambda with local esbuild, including
AWS SDK v3 rather than relying on the SDK provided by the Lambda runtime. Docker
is not required. `cdk.out/` and `dist/` are generated output and ignored by Git.
Synthesis creates local CloudFormation templates and Lambda assets; it does not
create AWS resources. CDK version reporting/telemetry is disabled in `cdk.json`.

Tests use CDK assertions and mock DynamoDB clients. They exercise security
settings, routes, outputs, pagination, the public response shape and error
handling without calling AWS.

## Resources and security

| Resource | Configuration |
| --- | --- |
| S3 photo bucket | All public access blocked, S3-managed AES-256 encryption, bucket-owner-enforced ownership, HTTPS required, versioning enabled |
| DynamoDB catalog | On-demand billing, AWS-managed encryption, point-in-time recovery and deletion protection |
| List-photos Lambda | Node.js 22, 256 MiB memory, 20-second timeout, outside a VPC |
| API Gateway | HTTP API with `GET /photos`, Lambda proxy integration and configurable CORS |
| CloudWatch Logs | Explicit Lambda log group with 14-day retention |

The bucket and table use CloudFormation **Retain** for removal and replacement.
The bucket aborts incomplete multipart uploads after seven days, but does not
expire completed photos or old object versions. Version storage and retained
resources can continue incurring costs after stack removal. Development logs
use the **Destroy** removal policy. No photo data is automatically deleted.

S3 prefixes are conventions, not actual folders or provisioned dummy objects:

```text
incoming/    # future imports
originals/   # original image bytes
variants/    # future resized images
```

There are no S3 event notifications, import functions, seeded catalog records,
CloudFront distribution, hosting, upload endpoints or authentication resources
in this phase.

The Lambda's custom execution role permits only:

- `dynamodb:Query` on this table and its named chronological index, restricted
  to the `default` collection through `dynamodb:LeadingKeys`.
- `logs:CreateLogStream` and `logs:PutLogEvents` within its explicit log group.

It has no DynamoDB Scan/write permissions, S3 read/write permissions or broad
managed execution policy. API Gateway receives permission to invoke this Lambda.
The bucket policy denies insecure transport; it does not grant public access.

## Catalog schema and chronological ordering

The table's primary key is `photoId` (string). Its **`collection-date-index`**
global secondary index uses:

- Partition key: `collectionId` (string), initially `"default"`.
- Sort key: `takenAtKey` (string), formatted as `<takenAt>#<photoId>`.

Use canonical UTC ISO timestamps with milliseconds, for example
`2021-03-27T14:30:00.000Z#abc123`. Equal capture dates are ordered deterministically
by photo ID. A Query with `ScanIndexForward: false` returns newest first without
a table scan. GSI reads are eventually consistent; recently imported records
may not appear immediately.

Future records are described by `CatalogPhoto` in
[`lambda/list-photos/types.ts`](lambda/list-photos/types.ts):

```typescript
{
  photoId: string;
  collectionId: string;
  takenAtKey: string;
  filename: string;
  takenAt: string;
  originalKey: string;
  smallKey?: string;
  mediumKey?: string;
  largeKey?: string;
  dateSource?: string;
  sha256?: string;
  width?: number;
  height?: number;
}
```

The six required fields are `photoId`, `collectionId`, `takenAtKey`, `filename`,
`takenAt` and `originalKey`. Import, EXIF selection, duplicate detection and
variant generation are future work; the existing local implementations remain
unchanged.

## GET /photos and pagination

The handler reads `PHOTO_TABLE_NAME` and `PHOTO_COLLECTION_ID`, supplied by the
stack. Query pagination, public mapping and HTTP response construction are
separate modules under `lambda/list-photos/`.

To preserve the frontend's complete-array contract, the handler follows every
`LastEvaluatedKey` internally, including continuation keys on empty pages. It
returns one JSON array with exactly the existing five public fields:

```typescript
{ id: string; filename: string; thumbnailUrl: string; originalUrl: string; takenAt: string }
```

Safety limits are centralized in `lib/catalog-config.ts`:

- At most **5,000 records**.
- At most **50 query pages**, requesting up to **250 records per page**; DynamoDB
  can return fewer due to its per-page size limit.
- At most **4 MiB of UTF-8 response JSON**, including brackets and commas.

Exceeding a limit returns **413**, never a silently truncated timeline. Repeated
pagination keys, duplicate IDs, invalid records or inconsistent ordering return
a generic **500**. Internal diagnostics, including the request ID, go to the
Lambda log group. DynamoDB failures also return **500** without AWS details or
stack traces. All responses have `Content-Type: application/json` and
`Cache-Control: no-store`.

Queries do not provide a collection-wide snapshot during concurrent imports.
The handler detects duplicate/out-of-order records, but cannot detect every
possible concurrent catalog change. Large/slow catalogs also remain subject to
the Lambda timeout. A later continuation-token API can reuse the page iterator
instead of accumulating the full response.

### Image delivery boundary

An empty catalog returns **200** with `[]`. Object keys remain internal, and URL
generation is isolated in `mapping.ts` behind `PhotoUrlResolver`. No permanent
public S3 URL is fabricated.

Until an approved delivery resolver is implemented, a nonempty catalog returns
**503** with `{"error":"Photo delivery is not configured yet."}`. Tests inject a
resolver to verify the complete frontend-compatible response. This intentional
boundary keeps the bucket private and avoids connecting the frontend to an
unfinished AWS image API.

## Configuration and outputs

CORS defaults to `*` for the initial read-only metadata endpoint; credentials are
disabled. Configure exact frontend origins when they are known:

```bash
npx cdk synth --no-lookups -c allowedOrigins=https://viewer.example.com
```

Multiple origins can be passed as a comma-separated context value. Only exact
HTTP/HTTPS origins are accepted, without paths or embedded credentials. CORS is
browser policy, not authentication or authorization. Future authenticated APIs
will need restricted origins and access controls.

Override the target region explicitly if necessary:

```bash
npx cdk synth --no-lookups -c region=ap-northeast-1
```

The stack defines these outputs, available as actual values **after deployment**:

| Output | Purpose |
| --- | --- |
| `PhotoApiUrl` | API base URL; append `/photos` for metadata. This can later become `NEXT_PUBLIC_API_BASE_URL`. |
| `PhotoBucketName` | Private photo storage bucket name |
| `PhotoTableName` | Catalog table name |

No output contains a secret. None provides an image-delivery URL yet. Do not
change the frontend's `.env.local` to use synthesized placeholders.

## Future deployment — documentation only

**Do not run these commands until AWS access, target account, costs and the
deployment plan have been reviewed and deployment explicitly approved.** This
phase has not run bootstrap, deployment or destruction.

Credentials must come from an external AWS CLI profile, IAM Identity Center/SSO,
IAM role or another approved credential provider. Do not store credentials in
source, CDK files, README, `.env.local` or frontend public configuration.

```bash
# From infra/, using your externally configured profile:
aws sts get-caller-identity --profile your-profile
npx cdk bootstrap --profile your-profile
npx cdk diff --profile your-profile
npx cdk deploy --profile your-profile
```

Confirm the identity and Tokyo target before approving any resource creation.
Bootstrapping itself creates AWS resources. Neither it nor deployment is needed
for the local tests, TypeScript compilation or credential-free synthesis.

## Later migration work

Review and approve the AWS deployment separately. A subsequent phase can define
private image delivery and its URL/variant contract, implement ingestion and
catalog population with EXIF/duplicate processing, then connect the frontend
after end-to-end validation. Static hosting, authentication, domains and uploads
remain outside this infrastructure foundation.
