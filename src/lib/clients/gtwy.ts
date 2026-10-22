import "server-only";

import { env } from "@/lib/env";
import { httpRaw } from "@/lib/clients/http";
import { ApiError, type ApiErrorCode } from "@/lib/api/envelope";

/**
 * The gtwy-node client — the sign-in exchange (plan §14.2) and the proxy for the
 * four live actions (plan §3), which go through here so gtwy-node's side effects
 * happen exactly as they do today: the Redis `sAdd`/`sRem` on block/unblock, the
 * msg91 existence check and Lago wallet check on add-internal-org.
 *
 * We forward the caller's **own session JWT**, so gtwy-node's `middleware` +
 * `InternalAuth` re-authorise independently. The admin's identity is never
 * spoofed and privilege is never escalated: if gtwy-node says 403, we return
 * 403. We mint no token and sign none.
 *
 * **`Authorization` carries the JWT bare — no `Bearer ` prefix.** `middleware`
 * (`middleware.js:145-165`) hands `req.get("Authorization")` straight to
 * `jwt.verify` without stripping a scheme, so a prefix 401s every request.
 * `combine_middleware` two functions down *does* strip it (`middleware.js:210`);
 * the inconsistency is real, and every route below is on `middleware`.
 *
 * | our route                              | gtwy-node                                     |
 * |----------------------------------------|-----------------------------------------------|
 * | POST   /api/admin/orgs/:orgId/block    | POST   {GTWY_API_BASE}/api/block_org          |
 * | POST   /api/admin/orgs/:orgId/unblock  | DELETE {GTWY_API_BASE}/api/block_org/:org_id  |
 * | POST   /api/admin/internal-orgs        | POST   {GTWY_API_BASE}/api/internal-orgs      |
 * | DELETE /api/admin/internal-orgs/:orgId | DELETE {GTWY_API_BASE}/api/internal-orgs/:id  |
 */

/** gtwy-node's own envelope: `{ success, message?, data? }`. */
export interface GtwyResponse<T = unknown> {
  status: number;
  success: boolean;
  message: string | null;
  data: T | null;
}

/**
 * `GTWY_API_BASE` is still empty in this deployment (plan §14.3), and an absent
 * variable made `env.gtwyApiBase()` throw a bare `Error`, which `withAdmin`
 * could only report as `internal` — a 500 that reads as a bug in this console
 * rather than as the missing configuration it is. It is the same situation
 * `clients/lago.ts` already reports as `upstream_unavailable`, so it gets the
 * same code. **Nothing about the action changes**: the request never reached
 * gtwy-node before and does not now.
 */
function base(): string {
  const configured = process.env.GTWY_API_BASE;
  if (!configured || configured.trim() === "") {
    console.error("[admin-api] GTWY_API_BASE is not configured; the live actions cannot proxy");
    throw new ApiError("upstream_unavailable");
  }
  return env.gtwyApiBase().replace(/\/+$/, "");
}

/** gtwy-node's status → our plan §1.4 code. */
function codeFor(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  return "upstream_unavailable";
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  jwt: string | null,
  body?: unknown,
): Promise<GtwyResponse<T>> {
  if (!jwt) {
    // gtwy-node must see the caller's real token to re-authorise. Without one we
    // refuse rather than act unauthorised.
    throw new ApiError("unauthorized", "This action needs a fresh sign-in.");
  }

  const { status, body: payload } = await httpRaw(`${base()}${path}`, {
    source: `gtwy${path}`,
    method,
    // Bare, no `Bearer ` — see the note at the top of this file.
    headers: { Authorization: jwt },
    body,
    // gtwy-node fronts Mongo, Redis, msg91 and Lago on these paths; the Lago
    // wallet check alone has its own BILLING_API_TIMEOUT_MS budget.
    timeoutMs: env.billingTimeoutMs() + env.msg91TimeoutMs(),
  });

  const envelope = (payload ?? {}) as { success?: boolean; message?: string; data?: T };

  if (status < 200 || status >= 300 || envelope.success === false) {
    console.error(`[admin-api] gtwy-node ${method} ${path} -> ${status}`, envelope.message);
    // gtwy-node's own messages on these routes are operator-written and safe to
    // show ("org 123 has no Lago wallet — provision it first"). A 5xx is not.
    const safe = status >= 500 ? undefined : envelope.message;
    throw new ApiError(codeFor(status), safe);
  }

  // Anything that was not a success threw above, so reaching here is the
  // success case by construction.
  return {
    status,
    success: true,
    message: envelope.message ?? null,
    data: envelope.data ?? null,
  };
}

/** `blockedOrg.controller.js#blockOrg` — Mongo upsert + Redis `sAdd`. */
export function blockOrg(orgId: string, reason: string, jwt: string | null) {
  return call("POST", "/api/block_org", jwt, { org_id: orgId, reason });
}

/** `blockedOrg.controller.js#unblockOrg` — Mongo delete + Redis `sRem`. */
export function unblockOrg(orgId: string, jwt: string | null) {
  return call("DELETE", `/api/block_org/${encodeURIComponent(orgId)}`, jwt);
}

/** `internalOrgs.controller.js#addInternalOrg` — msg91 + Lago wallet checks, then insert. */
export function addInternalOrg(orgId: string, jwt: string | null) {
  return call("POST", "/api/internal-orgs", jwt, { org_id: orgId });
}

/** `internalOrgs.controller.js#removeInternalOrg`. */
export function removeInternalOrg(orgId: string, jwt: string | null) {
  return call("DELETE", `/api/internal-orgs/${encodeURIComponent(orgId)}`, jwt);
}

/** `internalOrgs.controller.js#listInternalOrgs` — read, for `GET /api/admin/internal-orgs`. */
export function listInternalOrgs(jwt: string | null) {
  return call<unknown[]>("GET", "/api/internal-orgs", jwt);
}

// --------------------------------------------------------------- sign-in ---
//
// The two upstream calls `POST /api/admin/session` makes, in order (§14.2).
// They do not go through `call()` above: the first is the one endpoint in the
// system that may see a `proxy_auth_token` header, and the second must report
// its raw status to the classifier rather than throw on a 403.

/** The gtwy-node endpoints a `proxy_auth_token` may ever be sent to. */
export const ADMIN_PROXY_TOKEN_PATH = "/api/user/adminProxyToken";
export const LOCAL_TOKEN_PATH = "/api/user/localToken";

/** `GET /api/internal-orgs/access` — the operator probe. */
export const OPERATOR_ACCESS_PATH = "/api/internal-orgs/access";

/**
 * Step 0 — trade the admin project's handoff token for a platform one.
 *
 * The login widget signs in against the admin console's own msg91 project
 * (`NEXT_PUBLIC_REFERENCEID`), but `/localToken` only accepts tokens from the
 * platform project. `userOrgLocal.controller.js#adminProxyToken` decodes the
 * admin token, finds or creates that person in the platform project under
 * "GTWY Admin", and returns a platform `proxy_auth_token`. It does no access
 * check of its own: who can sign in is decided by the admin msg91 project.
 *
 * A 403 is surfaced as `forbidden`; anything else that fails is a failed
 * sign-in (`bad_request`, see step 1).
 */
export async function exchangeAdminProxyToken(proxyAuthToken: string): Promise<string> {
  const { status, body } = await httpRaw(`${base()}${ADMIN_PROXY_TOKEN_PATH}`, {
    source: `gtwy${ADMIN_PROXY_TOKEN_PATH}`,
    method: "POST",
    headers: { proxy_auth_token: proxyAuthToken },
    // gtwy-node makes three msg91 calls in sequence on this path.
    timeoutMs: env.msg91TimeoutMs() * 3,
  });

  const envelope = (body ?? {}) as {
    success?: boolean;
    message?: string;
    data?: { proxy_auth_token?: unknown };
  };
  const token = envelope.data?.proxy_auth_token;

  if (status === 403) {
    console.error(`[admin-api] adminProxyToken refused -> 403`, envelope.message ?? null);
    throw new ApiError("forbidden", "This account is not a user of the admin project. Access is invite-only.");
  }

  if (status < 200 || status >= 300 || envelope.success === false || typeof token !== "string" || !token) {
    // Neither token is ever logged — both are live credentials until spent.
    console.error(`[admin-api] adminProxyToken exchange failed -> ${status}`, envelope.message ?? null);
    throw new ApiError("bad_request", "Sign-in could not be completed. Try again.");
  }

  return token;
}

/**
 * Step 1 — trade the msg91 handoff token for gtwy-node's session JWT.
 *
 * `userOrgLocal.routes.js:13` → `userOrgLocal.controller.js#userOrgLocalToken`,
 * behind `loginAuth`. `generateProxyAuthToken` (`proxy.service.js:249`) reads
 * `req.headers.proxy_auth_token` and nothing else — gtwy-ui posts a
 * `{ userId, orgId }` body here and the controller ignores it, so we send none.
 * Answer: `{ success: true, data: { token } }`.
 *
 * **A failure here is `bad_request` (400), not `unauthorized` (401).** The
 * browser routes a 401 back to `/login`, which would turn a failed sign-in into
 * a loop; a failed exchange has to surface on the sign-in screen as a failed
 * sign-in.
 */
export async function exchangeProxyAuthToken(proxyAuthToken: string): Promise<string> {
  const { status, body } = await httpRaw(`${base()}${LOCAL_TOKEN_PATH}`, {
    source: `gtwy${LOCAL_TOKEN_PATH}`,
    method: "POST",
    headers: { proxy_auth_token: proxyAuthToken },
    timeoutMs: env.msg91TimeoutMs(),
  });

  const envelope = (body ?? {}) as { success?: boolean; message?: string; data?: { token?: unknown } };
  const token = envelope.data?.token;

  if (status < 200 || status >= 300 || envelope.success === false || typeof token !== "string" || !token) {
    // The token itself is never logged — it is a live credential until spent.
    console.error(`[admin-api] localToken exchange failed -> ${status}`, envelope.message ?? null);
    throw new ApiError("bad_request", "Sign-in could not be completed. Try again.");
  }

  return token;
}

/** What `GET /api/internal-orgs/access` said, verbatim, for the classifier to read. */
export interface AccessProbeResponse {
  status: number;
  allowed: boolean | null;
  email: string | null;
  message: string | null;
}

/**
 * Step 2 — ask gtwy-node whether this account is an operator.
 *
 * Returns the raw status rather than throwing, because 401, 403 and 404 are all
 * *answers* here and each maps to a different thing we return. Only a network
 * failure or a timeout throws (as `UpstreamError`, from `httpRaw`).
 */
export async function probeOperatorAccess(jwt: string): Promise<AccessProbeResponse> {
  const { status, body } = await httpRaw(`${base()}${OPERATOR_ACCESS_PATH}`, {
    source: `gtwy${OPERATOR_ACCESS_PATH}`,
    method: "GET",
    // Bare, no `Bearer ` — see the note at the top of this file.
    headers: { Authorization: jwt },
    timeoutMs: env.msg91TimeoutMs(),
  });

  const envelope = (body ?? {}) as {
    message?: unknown;
    data?: { allowed?: unknown; email?: unknown };
  };

  return {
    status,
    allowed: typeof envelope.data?.allowed === "boolean" ? envelope.data.allowed : null,
    email: typeof envelope.data?.email === "string" && envelope.data.email ? envelope.data.email : null,
    message: typeof envelope.message === "string" ? envelope.message : null,
  };
}
