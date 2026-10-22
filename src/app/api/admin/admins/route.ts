import type { NextRequest } from "next/server";

import { ok, upstream } from "@/lib/api/envelope";
import { withAdmin } from "@/lib/auth/withAdmin";
import { listReferenceUsers } from "@/lib/clients/msg91";
import { lastActiveByEmail } from "@/lib/audit/writeAudit";
import type { RawAdminAccessRow } from "@/lib/mappers/admins";

/**
 * `GET /api/admin/admins` → the Admin access page (plan §5, page 09).
 *
 * One row per user of the `ADMIN_REFERENCEID` msg91 project:
 * `{ email, lastActiveAt }`.
 *
 * **The reference project is the row set.** There is no admin collection and no
 * invite record anywhere — an admin exists here because msg91 lists them under
 * this deployment's reference id. E-mails are lower-cased and de-duplicated, and
 * users without an e-mail are skipped (nothing to show, nothing to key on).
 *
 * `lastActiveAt` is the newest `admin_audit_logs.createdAt` for that e-mail, or
 * `null` (plan §9, gap 10). The mapper turns `null` into "never".
 *
 * **Either source failing is an error, not a degrade.** msg91 is the row set, so
 * without it there is no page; and if the audit collection cannot be read,
 * reporting "never" for an admin who has in fact acted would be a lie the page
 * has no way to walk back. So the route fails and the page shows its error
 * branch.
 *
 * Read-only. Nothing here writes.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withAdmin(async (_req: NextRequest) => {
  let users: Awaited<ReturnType<typeof listReferenceUsers>>;
  try {
    users = await listReferenceUsers();
  } catch (err) {
    throw upstream("msg91", err);
  }

  const emails = [
    ...new Set(users.map((u) => u.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e))),
  ];

  // An empty project is a real state, not a failure. The page renders its empty
  // branch and says so. No point querying Mongo for it.
  if (emails.length === 0) return ok<RawAdminAccessRow[]>([]);

  let lastActive: Map<string, Date>;
  try {
    lastActive = await lastActiveByEmail();
  } catch (err) {
    throw upstream("admin_audit_logs", err);
  }

  const rows: RawAdminAccessRow[] = emails.map((email) => {
    // `lastActiveByEmail` keys on the lower-cased `admin_email` the audit writer
    // stores, the same normalised form used above — so one admin is never split
    // across two keys by casing.
    const at = lastActive.get(email);
    return { email, lastActiveAt: at ? new Date(at).toISOString() : null };
  });

  return ok(rows);
});
