import path from "node:path";
import { App } from "aws-cdk-lib";
import { PhotoViewerStack } from "../lib/photo-viewer-stack";

const app = new App();
// `-c siteDir=../out` deploys the static frontend export; omit it for infra-only changes.
const siteDir: unknown = app.node.tryGetContext("siteDir");
if (siteDir !== undefined && typeof siteDir !== "string") throw new Error("siteDir must be a path.");
new PhotoViewerStack(app, "PhotoViewer3D", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext("region") ?? "ap-northeast-1",
  },
  siteDirectory: siteDir ? path.resolve(siteDir) : undefined,
  photoTimeZone: app.node.tryGetContext("photoTimeZone"),
});
