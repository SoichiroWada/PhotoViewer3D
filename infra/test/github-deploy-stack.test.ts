import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { GitHubDeployStack } from "../lib/github-deploy-stack";

const template = Template.fromStack(new GitHubDeployStack(new App(), "TestGitHubDeploy", {
  env: { account: "123456789012", region: "ap-northeast-1" },
  repository: "owner/repo", deployBranch: "master", appStackName: "App",
}));
const roles = Object.entries(template.findResources("AWS::IAM::Role"));
const policies = Object.values(template.findResources("AWS::IAM::Policy"));
const role = (prefix: string) => roles.find(([id]) => id.startsWith(prefix))!;
const statementsOf = (roleId: string) => policies
  .filter((policy) => policy.Properties.Roles.some((ref: any) => ref.Ref === roleId))
  .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
const subjectOf = ([, value]: [string, any]) =>
  value.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"];

test("trusts only GitHub's OIDC issuer for STS", () => {
  template.hasResourceProperties("AWS::IAM::OIDCProvider", {
    Url: "https://token.actions.githubusercontent.com", ClientIdList: ["sts.amazonaws.com"],
  });
  for (const [, value] of roles) {
    const [statement] = value.Properties.AssumeRolePolicyDocument.Statement;
    assert.equal(statement.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com");
  }
});

test("only the deploy branch can deploy, and only through the CDK bootstrap roles", () => {
  const deploy = role("DeployRole");
  assert.equal(subjectOf(deploy), "repo:owner/repo:ref:refs/heads/master");
  const statements = statementsOf(deploy[0]);
  assert.deepEqual(statements.map((statement: any) => statement.Action), ["sts:AssumeRole"]);
  assert.match(JSON.stringify(statements[0].Resource), /role\/cdk-hnb659fds-\*-123456789012-ap-northeast-1/);
});

test("pull requests may only read the app stack's template", () => {
  const diff = role("DiffRole");
  assert.equal(subjectOf(diff), "repo:owner/repo:pull_request");
  const [statement, ...rest] = statementsOf(diff[0]);
  assert.equal(rest.length, 0);
  assert.deepEqual(statement.Action, ["cloudformation:DescribeStacks", "cloudformation:GetTemplate"]);
  assert.match(JSON.stringify(statement.Resource), /stack\/App\/\*/);
});
