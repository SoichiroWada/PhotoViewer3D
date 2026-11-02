import path from "node:path";
import { App } from "aws-cdk-lib";
import { GitHubDeployStack } from "../lib/github-deploy-stack";
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
// Deployed by hand once (`cdk deploy PhotoViewer3DGitHubDeploy`); the workflows only deploy PhotoViewer3D.
new GitHubDeployStack(app, "PhotoViewer3DGitHubDeploy", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext("region") ?? "ap-northeast-1",
  },
  repository: "SoichiroWada/PhotoViewer3D",
  deployBranch: "master",
  appStackName: "PhotoViewer3D",
});
