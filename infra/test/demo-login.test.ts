import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { createDemoLoginHandler, type DemoDependencies } from "../lambda/demo-login/handler";
import { isDemoCaller } from "../lib/demo-config";
import { createUploadHandler } from "../lambda/create-upload/handler";
import { createDeleteHandler } from "../lambda/delete-photos/handler";

const event = { requestContext: { requestId: "r" } } as APIGatewayProxyEventV2;

function fakeCognito(options: { exists?: boolean; failSignIn?: boolean } = {}) {
  let exists = options.exists ?? true;
  let password = "";
  const calls: string[] = [];
  let clock = 1_000_000;
  const deps: DemoDependencies = {
    async setPassword(next) {
      calls.push("setPassword");
      if (!exists) throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
      password = next;
    },
    async createUser() { calls.push("createUser"); exists = true; },
    async addToDemoGroup() { calls.push("addToDemoGroup"); },
    async signIn(given) {
      calls.push("signIn");
      if (options.failSignIn || given !== password) throw new Error("NotAuthorizedException: arn:secret");
      return { accessToken: `access-${calls.length}`, idToken: "id", expiresIn: 3600 };
    },
    now: () => clock,
    logger: { error() {} },
  };
  return { deps, calls, advance: (ms: number) => { clock += ms; } };
}

test("demo sign-in resets a random password, ensures group membership, and returns OAuth-shaped tokens", async () => {
  const { deps, calls } = fakeCognito();
  const response = await createDemoLoginHandler(deps)(event);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["setPassword", "addToDemoGroup", "signIn"]);
  const body = JSON.parse(response.body!);
  assert.deepEqual(Object.keys(body).sort(), ["access_token", "expires_in", "id_token"]);
  assert.equal(body.expires_in, 3600);
  assert.equal(response.headers!["Cache-Control"], "no-store");
});

test("demo sign-in recreates a deleted demo user", async () => {
  const { deps, calls } = fakeCognito({ exists: false });
  assert.equal((await createDemoLoginHandler(deps)(event)).statusCode, 200);
  assert.deepEqual(calls, ["setPassword", "createUser", "setPassword", "addToDemoGroup", "signIn"]);
});

test("demo tokens are reused until ten minutes before expiry", async () => {
  const { deps, calls, advance } = fakeCognito();
  const handler = createDemoLoginHandler(deps);
  const first = JSON.parse((await handler(event)).body!);
  advance(45 * 60 * 1000);
  const second = JSON.parse((await handler(event)).body!);
  assert.equal(second.access_token, first.access_token);
  assert.equal(second.expires_in, 15 * 60);
  advance(6 * 60 * 1000);
  const third = JSON.parse((await handler(event)).body!);
  assert.notEqual(third.access_token, first.access_token);
  assert.equal(calls.filter(call => call === "signIn").length, 2);
});

test("demo sign-in failures are generic and not cached", async () => {
  const { deps } = fakeCognito({ failSignIn: true });
  const response = await createDemoLoginHandler(deps)(event);
  assert.equal(response.statusCode, 500);
  assert.ok(!response.body!.includes("arn"));
});

test("demo callers are recognized from every group-claim encoding", () => {
  assert.ok(isDemoCaller({ "cognito:groups": "[demo]" }));
  assert.ok(isDemoCaller({ "cognito:groups": "[admins demo]" }));
  assert.ok(isDemoCaller({ "cognito:groups": ["demo"] }));
  assert.ok(!isDemoCaller({ "cognito:groups": "[demonstrators]" }));
  assert.ok(!isDemoCaller({ sub: "user" }));
  assert.ok(!isDemoCaller(undefined));
});

test("upload and delete APIs refuse demo callers before doing any work", async () => {
  const demoEvent = { body: JSON.stringify({ filename: "a.jpg", size: 1, ids: ["0".repeat(32)] }), isBase64Encoded: false,
    requestContext: { requestId: "r", authorizer: { jwt: { claims: { sub: "d", "cognito:groups": "[demo]" }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  const upload = await createUploadHandler(async () => { throw new Error("must not presign"); })(demoEvent);
  assert.equal(upload.statusCode, 403);
  const fail = async () => { throw new Error("must not touch storage"); };
  const remove = await createDeleteHandler({ getCatalog: fail, deleteCatalog: fail, deleteMedia: fail })(demoEvent);
  assert.equal(remove.statusCode, 403);
});
