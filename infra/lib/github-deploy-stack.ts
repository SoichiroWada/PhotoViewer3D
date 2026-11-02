import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

export interface GitHubDeployStackProps extends StackProps {
  /** Repository as GitHub's OIDC `sub` names it (`owner@id/name@id`); its workflows may use these roles. */
  repository: string;
  /** The only branch allowed to deploy. */
  deployBranch: string;
  /** Stack the pull-request diff may read. */
  appStackName: string;
}

const GITHUB_ISSUER = "token.actions.githubusercontent.com";
// CDK's default bootstrap qualifier.
const BOOTSTRAP_QUALIFIER = "hnb659fds";

/**
 * Lets GitHub Actions deploy without stored AWS keys. Deployed by hand once; the
 * workflows never deploy this stack, so they cannot widen their own trust.
 */
export class GitHubDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: GitHubDeployStackProps) {
    super(scope, id, props);

    const provider = new iam.OidcProviderNative(this, "GitHubOidc", {
      url: `https://${GITHUB_ISSUER}`,
      clientIds: ["sts.amazonaws.com"],
    });
    const assumedBy = (subject: string) => new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
      StringEquals: { [`${GITHUB_ISSUER}:aud`]: "sts.amazonaws.com", [`${GITHUB_ISSUER}:sub`]: subject },
    });

    // Merges to the deploy branch: may only hand off to the CDK bootstrap roles.
    const deployRole = new iam.Role(this, "DeployRole", {
      description: `GitHub Actions deploys from ${props.repository}, branch ${props.deployBranch}`,
      assumedBy: assumedBy(`repo:${props.repository}:ref:refs/heads/${props.deployBranch}`),
    });
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-${BOOTSTRAP_QUALIFIER}-*-${this.account}-${this.region}`],
    }));

    // Pull requests: reads the deployed template for `cdk diff --method template`, nothing else.
    // Not the bootstrap lookup role, whose ReadOnlyAccess could read the photos.
    const diffRole = new iam.Role(this, "DiffRole", {
      description: `GitHub Actions cdk diff for pull requests in ${props.repository}`,
      assumedBy: assumedBy(`repo:${props.repository}:pull_request`),
    });
    diffRole.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudformation:DescribeStacks", "cloudformation:GetTemplate"],
      resources: [this.formatArn({ service: "cloudformation", resource: "stack", resourceName: `${props.appStackName}/*` })],
    }));

    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "DiffRoleArn", { value: diffRole.roleArn });
  }
}
