import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PhotoViewerStack } from "../lib/photo-viewer-stack";

const template = Template.fromStack(new PhotoViewerStack(new App(), "TestStack", {
  env: { region: "ap-northeast-1" },
}));
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: any; DeletionPolicy?: string }>;
const ofType = (type: string) => Object.entries(resources).filter(([, value]) => value.Type === type);

test("all three buckets block public access, encrypt and require TLS", () => {
  template.resourceCountIs("AWS::S3::Bucket", 3);
  for (const [, bucket] of ofType("AWS::S3::Bucket")) {
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, "AES256");
  }
  for (const [, policy] of ofType("AWS::S3::BucketPolicy")) {
    assert.ok(policy.Properties.PolicyDocument.Statement.some((statement: any) =>
      statement.Effect === "Deny" && statement.Condition?.Bool?.["aws:SecureTransport"] === "false"));
  }
});

test("media bucket and catalog are retained; only uploads and the site are disposable", () => {
  const [, media] = ofType("AWS::S3::Bucket").find(([id]) => id.startsWith("MediaBucket"))!;
  assert.equal(media.DeletionPolicy, "Retain");
  assert.deepEqual(media.Properties.VersioningConfiguration, { Status: "Enabled" });
  const [, upload] = ofType("AWS::S3::Bucket").find(([id]) => id.startsWith("UploadBucket"))!;
  assert.equal(upload.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays, 7);
  assert.deepEqual(upload.Properties.CorsConfiguration.CorsRules[0].AllowedMethods, ["POST"]);
  template.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain",
    Properties: Match.objectLike({
      BillingMode: "PAY_PER_REQUEST", DeletionProtectionEnabled: true,
      KeySchema: [{ AttributeName: "photoId", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "collection-date-index", KeySchema: [
        { AttributeName: "collectionId", KeyType: "HASH" }, { AttributeName: "takenAtKey", KeyType: "RANGE" },
      ] })],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }),
  });
});

test("every API route requires the Cognito JWT authorizer", () => {
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
  const keys = ofType("AWS::ApiGatewayV2::Route").map(([, route]) => {
    assert.equal(route.Properties.AuthorizationType, "JWT");
    assert.ok(route.Properties.AuthorizerId);
    return route.Properties.RouteKey;
  });
  assert.deepEqual(keys.sort(), ["GET /api/photos", "POST /api/session", "POST /api/uploads"]);
  template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
    AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"],
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: Match.absent() });
});

test("Cognito is invitation-only with a public PKCE client", () => {
  template.hasResourceProperties("AWS::Cognito::UserPool", {
    AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    UsernameAttributes: ["email"],
    UserPoolTier: "LITE",
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false,
    AllowedOAuthFlows: ["code"],
    AllowedOAuthFlowsUserPoolClient: true,
    SupportedIdentityProviders: ["COGNITO"],
    PreventUserExistenceErrors: "ENABLED",
  });
});

test("CloudFront serves site, API and signed-cookie media from one origin", () => {
  const [, distribution] = ofType("AWS::CloudFront::Distribution")[0]!;
  const config = distribution.Properties.DistributionConfig;
  assert.equal(config.DefaultCacheBehavior.ViewerProtocolPolicy, "redirect-to-https");
  const behaviors = Object.fromEntries(config.CacheBehaviors.map((behavior: any) => [behavior.PathPattern, behavior]));
  assert.deepEqual(Object.keys(behaviors).sort(), ["/api/*", "/media/*"]);
  assert.equal(behaviors["/media/*"].TrustedKeyGroups.length, 1);
  assert.equal(behaviors["/api/*"].TrustedKeyGroups, undefined);
  assert.equal(behaviors["/api/*"].AllowedMethods.length, 7);
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
  template.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
  // No error-page rewrites: an expired media cookie must surface as 403, not index.html.
  assert.equal(config.CustomErrorResponses, undefined);
});

test("application Lambdas use Node.js 22 with dedicated roles and no managed policies", () => {
  const app = ofType("AWS::Lambda::Function").filter(([id]) =>
    ["ListPhotos", "Session", "CreateUpload", "ProcessPhoto", "SigningKeyFunction"].some(name => id.startsWith(name) && !id.includes("Provider")));
  assert.equal(app.length, 5);
  for (const [, fn] of app) {
    assert.equal(fn.Properties.Runtime, "nodejs22.x");
    assert.ok(fn.Properties.LoggingConfig.LogGroup);
    assert.equal(fn.Properties.VpcConfig, undefined);
  }
  for (const [id, role] of ofType("AWS::IAM::Role")) {
    if (["ListPhotos", "Session", "CreateUpload", "ProcessPhoto", "SigningKeyFunction"].some(name => id.startsWith(`${name}Role`))) {
      assert.equal(role.Properties.ManagedPolicyArns, undefined, id);
    }
  }
  template.hasResourceProperties("AWS::Lambda::Function", {
    MemorySize: 2048, ReservedConcurrentExecutions: 10,
    Environment: { Variables: Match.objectLike({ PHOTO_TIME_ZONE: "Asia/Tokyo" }) },
  });
});

test("application IAM statements never use wildcard resources and match each function's job", () => {
  const actionsFor = (prefix: string) => ofType("AWS::IAM::Policy")
    .filter(([id]) => id.startsWith(`${prefix}RoleDefaultPolicy`))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement)
    .flatMap((statement: any) => {
      assert.ok(![statement.Resource].flat().includes("*"), `${prefix} uses a wildcard resource`);
      return [statement.Action].flat();
    });
  const logs = ["logs:CreateLogStream", "logs:PutLogEvents"];
  assert.deepEqual(actionsFor("ListPhotos").sort(), [...logs, "dynamodb:Query"].sort());
  assert.ok(actionsFor("Session").every(action => logs.includes(action) || action.startsWith("ssm:Get") || action === "ssm:DescribeParameters"));
  assert.ok(actionsFor("CreateUpload").every(action => logs.includes(action) || action.startsWith("s3:Put") || action === "s3:Abort*"));
  const process = actionsFor("ProcessPhoto");
  assert.ok(process.includes("dynamodb:PutItem") && process.includes("s3:DeleteObject*"));
  assert.ok(!process.some(action => ["dynamodb:Scan", "dynamodb:DeleteItem", "s3:DeleteBucket"].includes(action)));
});

test("uploads trigger processing only under incoming/", () => {
  template.hasResourceProperties("Custom::S3BucketNotifications", {
    NotificationConfiguration: { LambdaFunctionConfigurations: [Match.objectLike({
      Events: ["s3:ObjectCreated:*"],
      Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "incoming/" }] } },
    })] },
  });
});

test("outputs identify resources without secrets; site deployment is opt-in", () => {
  const outputs = template.toJSON().Outputs;
  assert.deepEqual(Object.keys(outputs).sort(), [
    "CognitoDomain", "DistributionId", "MediaBucketName", "PhotoTableName", "SiteUrl", "UploadBucketName",
    "UserPoolClientId", "UserPoolId",
  ]);
  assert.ok(!JSON.stringify(outputs).includes("PRIVATE KEY"));
  template.resourceCountIs("Custom::CDKBucketDeployment", 0);
});
