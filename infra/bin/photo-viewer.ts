import { App } from "aws-cdk-lib";
import { PhotoViewerStack } from "../lib/photo-viewer-stack";

const app = new App();
const configuredOrigins: unknown = app.node.tryGetContext("allowedOrigins");
const allowedOrigins = configuredOrigins === undefined ? ["*"] :
  typeof configuredOrigins === "string" ? configuredOrigins.split(",").map(value => value.trim()) :
  configuredOrigins;
if (!Array.isArray(allowedOrigins) || !allowedOrigins.every(origin => typeof origin === "string")) {
  throw new Error("allowedOrigins must be a comma-separated string or an array of origins.");
}
new PhotoViewerStack(app, "PhotoViewerFoundation", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext("region") ?? "ap-northeast-1",
  },
  allowedOrigins,
});
