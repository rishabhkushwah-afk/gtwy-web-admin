import type { NextRequest } from "next/server";

import { ApiError, fail, ok } from "@/lib/api/envelope";
import { UpstreamError } from "@/lib/clients/http";
import { exchangeAdminProxyToken, exchangeProxyAuthToken } from "@/lib/clients/gtwy";
import { operatorVerdictError, verifyOperator } from "@/lib/auth/operatorGate";
import { withAdmin } from "@/lib/auth/withAdmin";
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  sealSession,
  sessionCookieOptions,
} from "@/lib/auth/session";

/**
 * `POST /api/admin/session` — sign in. `DELETE` — sign out. (Plan §14.2.)
 *
 * **The one route not behind `withAdmin`**, because it is the route that
 * establishes the session; everything else in `/api/admin/*` is behind it.
 * What stands in its place is that it accepts exactly one thing — an msg91
 * `proxy_auth_token` — and grants exactly nothing on its own: both answers come
 * from gtwy-node, in three calls, in order.
 *
 *   0. `POST {GTWY_API_BASE}/api/user/adminProxyToken` with the admin project's
 *      handoff token → a platform `proxy_auth_token`. Who can reach this step
 *      is decided by msg91: only users of the admin project can sign in there.
 *   1. `POST {GTWY_API_BASE}/api/user/localToken` with the platform token in the
 *      `proxy_auth_token` header and **no body** → gtwy-node's session JWT.
 *      A failure is `400`, never `401`: the browser routes a 401 back to
 *      `/login`, which would make a failed sign-in loop.
 *   2. `GET {GTWY_API_BASE}/api/internal-orgs/access` with that JWT bare in
 *      `Authorization` → the operator verdict, classified by the table in
 *      `operatorStatus.ts` that GTWY-admin observed against a live gtwy-node.
 *
 * Only a yes sets the cookie. There is no local allowlist anywhere on this path.
 *
 * **Read-only** (hard rule 3): this writes nothing, not even an audit row.
 * Sign-in is not one of the four audited actions.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let proxyAuthToken: unknown;
  try {
    const body = (await req.json()) as { proxyAuthToken?: unknown };
    proxyAuthToken = body?.proxyAuthToken;
  } catch {
    return fail("bad_request");
  }

  if (typeof proxyAuthToken !== "string" || !proxyAuthToken.trim()) {
    return fail("bad_request", "No sign-in token was supplied.");
  }

  try {
    const platformToken = await exchangeAdminProxyToken(proxyAuthToken.trim());
    const jwt = await exchangeProxyAuthToken(platformToken);

    const verdict = await verifyOperator(jwt);
    const denial = operatorVerdictError(verdict);
    if (denial) {
      const response = fail(denial.code, denial.safeMessage);
      // Refusing a sign-in must also leave nothing behind from an earlier one.
      response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions());
      return response;
    }

    // `verifyOperator` only returns OPERATOR with an e-mail present — the
    // classifier's `!email` branch is NO_EMAIL_IN_TOKEN — so this is the
    // address gtwy-node itself echoed back, never one this console supplied.
    const email = (verdict.email ?? "").toLowerCase();

    const sealed = sealSession({ email, jwt });
    const response = ok({ email });
    response.cookies.set(SESSION_COOKIE, sealed.value, sessionCookieOptions(sealed.maxAge));
    return response;
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.safeMessage);
    if (err instanceof UpstreamError) {
      console.error("[admin-api] sign-in upstream failure", err);
      return fail("upstream_unavailable");
    }
    console.error("[admin-api] sign-in failed", err);
    return fail("internal");
  }
}

/**
 * Sign out. Behind `withAdmin` like every other route (hard rule 6) — and when
 * the session has already lapsed that wrapper clears the cookie on its own way
 * out, so signing out works whether or not the session was still good.
 *
 * gtwy-node's `POST /api/user/logout` blacklists the JWT in Redis, but this
 * console has no mandate to revoke a token it did not mint and that the same
 * person is still using in gtwy-ui. We drop our copy; the token's own `exp` and
 * gtwy-node's blacklist remain the authority on its life.
 */
export const DELETE = withAdmin(async () => {
  const response = ok({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions());
  return response;
});
