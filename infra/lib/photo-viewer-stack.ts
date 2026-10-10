import path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PHOTO_COLLECTION_ID, PHOTO_INDEX_NAME } from "./catalog-config";

export interface PhotoViewerStackProps extends StackProps {
  allowedOrigins?: string[];
}

export class PhotoViewerStack extends Stack {
  constructor(scope: Construct, id: string, props: PhotoViewerStackProps = {}) {
    super(scope, id, props);
    const allowedOrigins = props.allowedOrigins ?? ["*"];
    if (!allowedOrigins.length || (allowedOrigins.includes("*") && allowedOrigins.length !== 1)) {
      throw new Error("Use either one wildcard CORS origin or a non-empty list of exact origins.");
    }
    for (const origin of allowedOrigins) {
      if (origin === "*") continue;
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
        throw new Error("CORS origins must be exact HTTP/HTTPS origins without paths or credentials.");
      }
    }

    const bucket = new s3.Bucket(this, "PhotoBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });
    const table = new dynamodb.Table(this, "PhotoTable", {
      partitionKey: { name: "photoId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: PHOTO_INDEX_NAME,
      partitionKey: { name: "collectionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "takenAtKey", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const logGroup = new logs.LogGroup(this, "ListPhotosLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // const role = new iam.Role(this, "ListPhotosRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });

    const role = new iam.Role(this, "ListPhotosRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),

      permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(
        this,
        "ListPhotosBoundary",
        "arn:aws:iam::511530786011:policy/PhotoViewer3D-Lambda-Boundary"
      ),
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [table.tableArn, `${table.tableArn}/index/${PHOTO_INDEX_NAME}`],
      conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [PHOTO_COLLECTION_ID] } },
    }));
    logGroup.grantWrite(role);
    const projectRoot = path.resolve(__dirname, "..");
    const listPhotos = new NodejsFunction(this, "ListPhotos", {
      entry: path.join(projectRoot, "lambda/list-photos/index.ts"),
      depsLockFilePath: path.join(projectRoot, "package-lock.json"),
      projectRoot,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(20),
      role,
      logGroup,
      environment: { PHOTO_TABLE_NAME: table.tableName, PHOTO_COLLECTION_ID },
      bundling: {
        target: "node22", format: OutputFormat.CJS,
        externalModules: [], minify: true, sourceMap: true,
      },
    });
    const api = new HttpApi(this, "PhotoApi", {
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.OPTIONS],
        allowHeaders: ["Content-Type"],
        allowCredentials: false,
        maxAge: Duration.hours(1),
      },
    });
    api.addRoutes({
      path: "/photos", methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("ListPhotosIntegration", listPhotos),
    });

    new CfnOutput(this, "PhotoApiUrl", { value: api.apiEndpoint, description: "Metadata API base URL; GET /photos. No image delivery endpoint yet." });
    new CfnOutput(this, "PhotoBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "PhotoTableName", { value: table.tableName });
  }
}
