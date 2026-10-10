import path from "node:path";
import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cr from "aws-cdk-lib/custom-resources";
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { INCOMING_PREFIX, MEDIA_PREFIX, PHOTO_COLLECTION_ID, PHOTO_INDEX_NAME } from "./catalog-config";

export interface PhotoViewerStackProps extends StackProps {
  /** Static export directory (e.g. `../out`). When omitted the frontend is not deployed. */
  siteDirectory?: string;
  /** IANA zone for EXIF dates without an offset; defaults to Asia/Tokyo. */
  photoTimeZone?: string;
}

const SIGNING_KEY_PREFIX = "/photoviewer3d/cloudfront-signing-key";
const MEDIA_COOKIE_SECONDS = 12 * 60 * 60;

export class PhotoViewerStack extends Stack {
  constructor(scope: Construct, id: string, props: PhotoViewerStackProps = {}) {
    super(scope, id, props);
    const projectRoot = path.resolve(__dirname, "..");

    /** Each function gets its own role and log group; no broad managed policy. */
    const createFunction = (name: string, entry: string, overrides: Partial<NodejsFunctionProps> = {}) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY,
      });
      const role = new iam.Role(this, `${name}Role`, { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
      logGroup.grantWrite(role);
      const { bundling, ...rest } = overrides;
      return new NodejsFunction(this, name, {
        entry: path.join(projectRoot, "lambda", entry, "index.ts"),
        depsLockFilePath: path.join(projectRoot, "package-lock.json"),
        projectRoot,
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        memorySize: 256,
        timeout: Duration.seconds(10),
        role,
        logGroup,
        ...rest,
        bundling: {
          target: "node22", format: OutputFormat.CJS,
          externalModules: [], minify: true, sourceMap: true,
          ...bundling,
        },
      });
    };

    // ---------------------------------------------------------------- storage
    const mediaBucket = new s3.Bucket(this, "MediaBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{
        abortIncompleteMultipartUploadAfter: Duration.days(7),
        noncurrentVersionExpiration: Duration.days(30),
      }],
    });
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
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

    // ------------------------------------------------- CloudFront signing key
    const signingKeyFunction = createFunction("SigningKeyFunction", "signing-key", { timeout: Duration.seconds(30) });
    // No CDK grant exists for creating/deleting a SecureString; scope it to this prefix.
    signingKeyFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
      resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: `${SIGNING_KEY_PREFIX.slice(1)}/*` })],
    }));
    const signingKeyProvider = new cr.Provider(this, "SigningKeyProvider", {
      onEventHandler: signingKeyFunction,
      logGroup: new logs.LogGroup(this, "SigningKeyProviderLogs", {
        retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    const signingKey = new CustomResource(this, "SigningKey", {
      serviceToken: signingKeyProvider.serviceToken,
      // Increment KeyVersion to rotate the key pair.
      properties: { ParameterPrefix: SIGNING_KEY_PREFIX, KeyVersion: "1" },
    });
    const publicKey = new cloudfront.PublicKey(this, "MediaPublicKey", {
      encodedKey: signingKey.getAttString("PublicKeyPem"),
      comment: "PhotoViewer3D media signed cookies",
    });
    const keyGroup = new cloudfront.KeyGroup(this, "MediaKeyGroup", { items: [publicKey] });

    // --------------------------------------------------------------- the API
    const listPhotos = createFunction("ListPhotos", "list-photos", {
      timeout: Duration.seconds(20),
      environment: { PHOTO_TABLE_NAME: table.tableName, PHOTO_COLLECTION_ID },
    });
    table.grant(listPhotos, "dynamodb:Query");

    const session = createFunction("Session", "session", {
      environment: {
        CLOUDFRONT_KEY_PAIR_ID: publicKey.publicKeyId,
        SIGNING_KEY_PARAMETER: signingKey.getAttString("ParameterName"),
        MEDIA_COOKIE_SECONDS: String(MEDIA_COOKIE_SECONDS),
      },
    });
    ssm.StringParameter.fromSecureStringParameterAttributes(this, "SigningKeyParameter", {
      parameterName: signingKey.getAttString("ParameterName"), simpleName: false,
    }).grantRead(session);

    const api = new HttpApi(this, "PhotoApi", { description: "PhotoViewer3D API, served through CloudFront at /api/*" });
    const apiOrigin = new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // ---------------------------------------------------------------- CDN
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "PhotoViewer3D",
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        [`/${MEDIA_PREFIX}/*`]: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          trustedKeyGroups: [keyGroup],
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });
    const siteUrl = `https://${distribution.distributionDomainName}`;

    // ---------------------------------------------------------- auth (Cognito)
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.LITE,
      userInvitation: {
        emailSubject: "PhotoViewer3D invitation",
        emailBody: `You have been invited to PhotoViewer3D (${siteUrl}). Username: {username} Temporary password: {####}`,
      },
      // Invited users are easy to recreate; photos and the catalog are retained separately.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const domain = userPool.addDomain("HostedUi", {
      cognitoDomain: { domainPrefix: `photoviewer3d-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });
    const webClient = userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${siteUrl}/`],
        logoutUrls: [`${siteUrl}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
    const authorizer = new HttpUserPoolAuthorizer("CognitoAuthorizer", userPool, { userPoolClients: [webClient] });

    // ----------------------------------------------------------- uploads
    const uploadBucket = new s3.Bucket(this, "UploadBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Processed uploads are deleted; anything left (failures) expires.
      lifecycleRules: [{ expiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: [siteUrl], allowedHeaders: ["*"], maxAge: 3600 }],
    });
    const createUpload = createFunction("CreateUpload", "create-upload", {
      environment: { UPLOAD_BUCKET_NAME: uploadBucket.bucketName },
    });
    uploadBucket.grantPut(createUpload, `${INCOMING_PREFIX}*`);

    const processPhoto = createFunction("ProcessPhoto", "process-photo", {
      memorySize: 2048,
      timeout: Duration.minutes(2),
      reservedConcurrentExecutions: 10,
      environment: {
        PHOTO_TABLE_NAME: table.tableName,
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        PHOTO_TIME_ZONE: props.photoTimeZone ?? "Asia/Tokyo",
      },
      // Sharp ships native linux-x64 binaries; install it rather than bundle it.
      bundling: { nodeModules: ["sharp"] },
    });
    uploadBucket.grantRead(processPhoto, `${INCOMING_PREFIX}*`);
    uploadBucket.grantDelete(processPhoto, `${INCOMING_PREFIX}*`);
    mediaBucket.grantPut(processPhoto, `${MEDIA_PREFIX}/*`);
    table.grant(processPhoto, "dynamodb:GetItem", "dynamodb:PutItem");
    uploadBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(processPhoto), { prefix: INCOMING_PREFIX });

    // ------------------------------------------------------------ routes
    for (const [routePath, method, fn] of [
      ["/api/photos", HttpMethod.GET, listPhotos],
      ["/api/session", HttpMethod.POST, session],
      ["/api/uploads", HttpMethod.POST, createUpload],
    ] as const) {
      api.addRoutes({
        path: routePath, methods: [method], authorizer,
        integration: new HttpLambdaIntegration(`${fn.node.id}Integration`, fn),
      });
    }

    // ------------------------------------------------------------ frontend
    if (props.siteDirectory) {
      new s3deploy.BucketDeployment(this, "SiteDeployment", {
        destinationBucket: siteBucket,
        sources: [
          s3deploy.Source.asset(props.siteDirectory),
          // Runtime config keeps one static build valid for any deployment.
          s3deploy.Source.jsonData("auth-config.json", {
            region: this.region,
            userPoolId: userPool.userPoolId,
            clientId: webClient.userPoolClientId,
            cognitoDomain: domain.baseUrl(),
          }),
        ],
        distribution,
        distributionPaths: ["/*"],
        memoryLimit: 512,
        logGroup: new logs.LogGroup(this, "SiteDeploymentLogs", {
          retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
    }

    new CfnOutput(this, "SiteUrl", { value: siteUrl });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: webClient.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: domain.baseUrl() });
    new CfnOutput(this, "UploadBucketName", { value: uploadBucket.bucketName });
    new CfnOutput(this, "MediaBucketName", { value: mediaBucket.bucketName });
    new CfnOutput(this, "PhotoTableName", { value: table.tableName });
  }
}
