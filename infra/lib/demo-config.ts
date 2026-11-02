/** Members may read the collection but never upload or delete. */
export const DEMO_GROUP = "demo";
/** The shared demo account; `.invalid` can never receive mail, so it cannot be recovered or invited. */
export const DEMO_USERNAME = "demo@photoviewer3d.invalid";

/** HTTP API JWT authorizers pass array claims as text such as `[demo admins]`. */
export function isDemoCaller(claims: Record<string, unknown> | undefined): boolean {
  const groups = claims?.["cognito:groups"];
  const names = Array.isArray(groups) ? groups.map(String) : String(groups ?? "").replace(/^\[|\]$/g, "").split(/[\s,]+/);
  return names.includes(DEMO_GROUP);
}
