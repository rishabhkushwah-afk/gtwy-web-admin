import "server-only";

import { ApiError } from "@/lib/api/envelope";
import { probeOperatorAccess } from "@/lib/clients/gtwy";
import {
  OPERATOR_STATUS,
  classifyAccessProbe,
  missingEmailMessage,
  missingEmailShape,
  notOnAllowlistMessage,
  type OperatorStatus,
} from "@/lib/auth/operatorStatus";

/**
 * Step 3 of the §14.2 flow, in one place, because two callers need exactly the
 * same answer and must not be able to disagree about it:
 *
 *   - `POST /api/admin/session`, deciding whether to mint a session at all;
 *   - `withAdmin`, re-deciding it when a session goes past its 15-minute
 *     revalidation deadline (§3).
 *
 * gtwy-node is the only authority. Nothing here compares an address against a
 * list; the Admin access page lists the `ADMIN_REFERENCEID` project users for
 * display only — never to decide a request.
 */

export interface OperatorVerdict {
  status: OperatorStatus;
  /** The address gtwy-node echoed back. Only ever non-null on OPERATOR. */
  email: string | null;
}

/** One probe, one verdict. Logs the two "platform lost the e-mail" shapes distinctly. */
export async function verifyOperator(jwt: string): Promise<OperatorVerdict> {
  const probe = await probeOperatorAccess(jwt);
  const status = classifyAccessProbe(probe);

  if (status === OPERATOR_STATUS.NO_EMAIL_IN_TOKEN) {
    // "You are not an operator" and "the platform lost your e-mail" are the same
    // 403 on the wire and completely different problems for whoever is locked
    // out. This log line is the only place the difference is recorded.
    console.error(
      "[admin-api] operator gate: gtwy-node reports no e-mail on a valid session " +
        `(${missingEmailShape(probe)}). This is a platform defect, not a permission answer.`,
    );
  }

  if (status === OPERATOR_STATUS.ROUTE_ABSENT) {
    console.error(
      "[admin-api] operator gate: GET /api/internal-orgs/access answered 404. " +
        "This gtwy-node predates 5e3ab6c and has no internal-orgs router, so operator " +
        "status cannot be established. Report it — we do not fall back to a local allowlist.",
    );
  }

  if (status === OPERATOR_STATUS.INDETERMINATE) {
    console.error(`[admin-api] operator gate: gtwy-node gave an unreadable answer -> ${probe.status}`);
  }

  return { status, email: probe.email };
}

/**
 * The verdict as the plan §1.4 envelope, or `null` when the answer was yes.
 *
 * Every refusal below is a 403 on the wire except the two that are not about
 * permission at all. The messages are written for an operator and name no
 * gtwy-node internals — no route, no middleware, no claim.
 */
export function operatorVerdictError(verdict: OperatorVerdict, typedEmail?: string | null): ApiError | null {
  switch (verdict.status) {
    case OPERATOR_STATUS.OPERATOR:
      return null;
    case OPERATOR_STATUS.NOT_OPERATOR:
      return new ApiError("forbidden", notOnAllowlistMessage(verdict.email ?? typedEmail ?? ""));
    case OPERATOR_STATUS.NO_EMAIL_IN_TOKEN:
      return new ApiError("forbidden", missingEmailMessage());
    case OPERATOR_STATUS.TOKEN_REJECTED:
      return new ApiError("unauthorized", "Your sign-in is no longer valid. Sign in again.");
    case OPERATOR_STATUS.ROUTE_ABSENT:
      return new ApiError(
        "upstream_unavailable",
        "This console cannot check operator access against the platform right now. " +
          "The platform is running a build that predates the check.",
      );
    default:
      return new ApiError("upstream_unavailable");
  }
}

/** The `reason` the `/unauthorized` screen words itself from. Never a credential. */
export function verdictReason(verdict: OperatorVerdict): OperatorStatus {
  return verdict.status;
}
