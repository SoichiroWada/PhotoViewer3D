import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PhotoViewerStack } from "../lib/photo-viewer-stack";

const template = Template.fromStack(new PhotoViewerStack(new App(), "TestFoundation", {
  env: { region: "ap-northeast-1" },
}));

test("S3 blocks all public access, encrypts, versions and retains photo data", () => {
  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.hasResource("AWS::S3::Bucket", {
    DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
    Properties: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      VersioningConfiguration: { Status: "Enabled" },
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
      LifecycleConfiguration: { Rules: [Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Status: "Enabled" })] },
      NotificationConfiguration: Match.absent(),
    },
  });
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Effect: "Deny", Action: "s3:*", Principal: { AWS: "*" }, Condition: { Bool: { "aws:SecureTransport": "false" } },
    })]) },
  });
  const bucket = Object.values(template.findResources("AWS::S3::Bucket"))[0]!;
  const rule = bucket.Properties.LifecycleConfiguration.Rules[0];
  assert.equal(rule.ExpirationInDays, undefined);
  assert.equal(rule.NoncurrentVersionExpiration, undefined);
  template.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
});

test("DynamoDB is retained, protected, on-demand and indexed by collection and sortable date", () => {
  template.resourceCountIs("AWS::DynamoDB::Table", 1);
  template.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
    Properties: {
      BillingMode: "PAY_PER_REQUEST", DeletionProtectionEnabled: true,
      KeySchema: [{ AttributeName: "photoId", KeyType: "HASH" }],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "photoId", AttributeType: "S" },
        { AttributeName: "collectionId", AttributeType: "S" },
        { AttributeName: "takenAtKey", AttributeType: "S" },
      ]),
      GlobalSecondaryIndexes: [{ IndexName: "collection-date-index", KeySchema: [
        { AttributeName: "collectionId", KeyType: "HASH" }, { AttributeName: "takenAtKey", KeyType: "RANGE" },
      ], Projection: { ProjectionType: "ALL" } }],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
    },
  });
});

test("Lambda uses Node.js 22, bundled assets, table environment and no VPC", () => {
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs22.x", Handler: "index.handler", MemorySize: 256, Timeout: 20,
    Environment: { Variables: { PHOTO_TABLE_NAME: Match.anyValue(), PHOTO_COLLECTION_ID: "default" } },
    Code: { S3Bucket: Match.anyValue(), S3Key: Match.anyValue() },
    LoggingConfig: { LogGroup: Match.anyValue() }, VpcConfig: Match.absent(),
  });
  template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
});

test("Lambda IAM allows only collection-scoped Query and scoped CloudWatch writes", () => {
  template.resourceCountIs("AWS::IAM::Role", 1);
  template.hasResourceProperties("AWS::IAM::Role", {
    ManagedPolicyArns: Match.absent(),
    AssumeRolePolicyDocument: { Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "lambda.amazonaws.com" } }], Version: "2012-10-17" },
  });
  const policies = Object.values(template.findResources("AWS::IAM::Policy"));
  const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const query = statements.filter(statement => [statement.Action].flat().includes("dynamodb:Query"));
  assert.equal(query.length, 1);
  assert.deepEqual([query[0].Action].flat(), ["dynamodb:Query"]);
  assert.deepEqual(query[0].Condition, { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["default"] } });
  assert.equal(query[0].Resource.length, 2);
  const resourceText = JSON.stringify(query[0].Resource);
  assert.ok(resourceText.includes("Arn"));
  assert.ok(resourceText.includes("/index/collection-date-index"));
  for (const statement of statements) {
    assert.equal(statement.Effect, "Allow");
    assert.ok([statement.Action].flat().every((action: string) =>
      ["dynamodb:Query", "logs:CreateLogStream", "logs:PutLogEvents"].includes(action)));
    assert.ok(![statement.Resource].flat().includes("*"));
  }
  assert.ok(statements.some(statement => [statement.Action].flat().includes("logs:PutLogEvents")));
});

test("HTTP API exposes only GET /photos with configurable, noncredentialed CORS", () => {
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    ProtocolType: "HTTP", CorsConfiguration: {
      AllowOrigins: ["*"], AllowMethods: ["GET", "OPTIONS"], AllowHeaders: ["Content-Type"], AllowCredentials: false, MaxAge: 3600,
    },
  });
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 1);
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /photos", AuthorizationType: "NONE" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Integration", { IntegrationType: "AWS_PROXY", PayloadFormatVersion: "2.0" });
});

test("stack outputs API base URL and storage identifiers without secrets or later-phase services", () => {
  const outputs = template.toJSON().Outputs;
  assert.deepEqual(Object.keys(outputs).sort(), ["PhotoApiUrl", "PhotoBucketName", "PhotoTableName"]);
  assert.ok(JSON.stringify(outputs.PhotoApiUrl.Value).includes("ApiEndpoint"));
  for (const type of ["AWS::CloudFront::Distribution", "AWS::Amplify::App", "AWS::Cognito::UserPool", "AWS::EC2::VPC"]) {
    template.resourceCountIs(type, 0);
  }
});

test("exact frontend CORS origins can be configured without embedding a LAN address", () => {
  const origins = ["https://viewer.example.com", "http://localhost:3000"];
  const custom = Template.fromStack(new PhotoViewerStack(new App(), "ConfiguredOrigins", { allowedOrigins: origins }));
  custom.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: Match.objectLike({ AllowOrigins: origins }) });
});

test("rejects empty, mixed-wildcard or invalid CORS origins before synthesizing resources", () => {
  for (const allowedOrigins of [[], ["*", "https://viewer.example.com"], ["https://viewer.example.com/path"], ["ftp://example.com"], ["https://user:pass@example.com"]]) {
    assert.throws(() => new PhotoViewerStack(new App(), "InvalidOrigins", { allowedOrigins }));
  }
});
