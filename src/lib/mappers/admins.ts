import type { AdminAccessRow } from "@/mocks/types";
import { istDateTime } from "./primitives";

/**
 * Admin access (plan §5, page 09).
 *
 * The row set is the users of the `ADMIN_REFERENCEID` msg91 project, so the only value
 * that needs mapping is `lastActiveAt` — the newest `admin_audit_logs.createdAt`
 * for that e-mail (plan §9, gap 10 / Q44).
 *
 * That timestamp records **an action taken in this console**, not a login. There
 * is no admin-activity store and msg91 exposes no per-admin last-seen, so an
 * admin who has only ever read pages here has no row and reads "never". Most
 * admins will read "never" until they block, unblock, or change an internal org.
 */

/** The label for an admin who has taken no auditable action in this console. */
export const NEVER = "never";

/** Exactly what `GET /api/admin/admins` returns — raw, per plan §1.3. */
export interface RawAdminAccessRow {
  email: string;
  /** ISO-8601, or `null` when the admin has no audit row. */
  lastActiveAt: string | null;
}

/**
 * `null` → "never"; anything else → the IST timestamp (plan §4.5, Q26).
 *
 * An unparseable value degrades to "never" rather than throwing — `istDateTime`
 * would raise on an Invalid Date, and a malformed stored timestamp must not take
 * the page down.
 */
export function lastActiveLabel(lastActiveAt: string | Date | null | undefined): string {
  if (!lastActiveAt) return NEVER;
  const at = lastActiveAt instanceof Date ? lastActiveAt : new Date(lastActiveAt);
  if (!Number.isFinite(at.getTime())) return NEVER;
  return istDateTime(at);
}

export function mapAdmins(rows: RawAdminAccessRow[]): AdminAccessRow[] {
  return rows.map((row) => ({
    email: row.email,
    lastActive: lastActiveLabel(row.lastActiveAt),
  }));
}
