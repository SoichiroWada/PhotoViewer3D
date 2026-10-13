import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminInitiateAuthCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DEMO_GROUP, DEMO_USERNAME } from "../../lib/demo-config";
import { createDemoLoginHandler } from "./handler";

const cognito = new CognitoIdentityProviderClient({ maxAttempts: 2 });
const UserPoolId = process.env.USER_POOL_ID ?? "";
const ClientId = process.env.DEMO_CLIENT_ID ?? "";
const Username = DEMO_USERNAME;

export const handler = createDemoLoginHandler({
  setPassword: async Password => { await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username, Password, Permanent: true })); },
  createUser: async () => {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId, Username, MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: DEMO_USERNAME }, { Name: "email_verified", Value: "true" }],
    }));
  },
  addToDemoGroup: async () => { await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId, Username, GroupName: DEMO_GROUP })); },
  signIn: async PASSWORD => {
    const result = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId, ClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: Username, PASSWORD },
    }));
    const auth = result.AuthenticationResult;
    if (!auth?.AccessToken || !auth.IdToken) throw new Error(`Demo sign-in returned ${result.ChallengeName ?? "no tokens"}.`);
    return { accessToken: auth.AccessToken, idToken: auth.IdToken, expiresIn: auth.ExpiresIn ?? 3600 };
  },
});
