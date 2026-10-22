import "server-only";

import { env, MSG91_CACHE_TTL_MS } from "@/lib/env";
import { cached } from "@/lib/clients/cache";
import { httpJson } from "@/lib/clients/http";

/**
 * msg91, read-only, through the exact endpoints gtwy-node already calls.
 *
 *   getDetails (proxy token)  — middlewares/middleware.js#makeDataIfProxyTokenGiven
 *   getCompanies              — utils/proxy.utils.js:7 #getallOrgs
 *   getDetails (admin key)    — services/proxy.service.js#getProxyDetails
 *
 * Every read is cached for 5 minutes (plan §4.1) except the proxy-token identity
 * call, which must not be cached — it is the authentication check, and a cached
 * identity would keep a revoked token alive past the cookie TTL.
 */

const ROUTES_BASE = "https://routes.msg91.com/api";

function adminHeaders(): Record<string, string> {
  // gtwy-node sends this header lower-case in proxy.utils.js and mixed-case in
  // one place in proxy.service.js; HTTP header names are case-insensitive.
  return { authkey: env.adminApiKey() };
}

/**
 * One msg91 user row.
 *
 * `id/name/email/meta` are the four fields `analytics.controller.js#toUserEntry`
 * normalises. The rest are on the same payload and were confirmed live against
 * `GET /api/{PUBLIC_REFERENCEID}/getDetails` — they close plan §9 gap 6, which
 * assumed Role / Last active / Joined had no source.
 */
export interface Msg91User {
  id: string;
  name: string | null;
  email: string | null;
  meta: Record<string, unknown> | null;
  /** `role.name` — "Admin", "Editor", … `null` when the row carries no role. */
  role: string | null;
  roleId: number | null;
  /** ISO-8601, or `null` when the user has never logged in. */
  lastLoginAt: string | null;
  /** ISO-8601 — when the user joined. */
  createdAt: string | null;
}

/** One msg91 company row from `getCompanies`. */
export interface Msg91Org {
  id: string;
  name: string | null;
  /** The org's registered e-mail, used as the owner column on the workspaces list. */
  email: string | null;
  createdAt: string | null;
  /** msg91's own block flag. Distinct from our `blocked_orgs` collection. */
  isBlock: boolean;
  /** msg91 user id of the creator. */
  createdBy: string | null;
}

interface GetDetailsEnvelope {
  data?: {
    data?: unknown[];
    totalEntityCount?: number | string;
  } & Record<string, unknown>;
}

/** The shape `https://routes.msg91.com/api/c/getDetails` returns for a proxy token. */
interface ProxyTokenEnvelope {
  data?: Array<{
    id?: string | number;
    name?: string;
    email?: string;
    meta?: Record<string, unknown>;
    currentCompany?: { id?: string | number; name?: string };
  }>;
}

export interface ProxyTokenIdentity {
  userId: string;
  name: string | null;
  /** `null` when the proxy-token response omits it — see `resolveEmail` below. */
  email: string | null;
  orgId: string | null;
  orgName: string | null;
}

/*
 * `getDetailsByProxyToken` — `GET /api/c/getDetails` with the caller's
 * `proxy_auth_token`, byte-for-byte the call `makeDataIfProxyTokenGiven` makes —
 * **was removed at D11.** Plan §14.2 withdrew §2.1, which is the only thing that
 * ever called it.
 *
 * It existed to work around a real defect: `makeDataIfProxyTokenGiven`
 * (`middleware.js:77`) builds `user` without `email` while `InternalAuth`
 * authorises on exactly `req.profile.user.email`. Calling msg91 ourselves to
 * recover the address made this console decide an identity gtwy-node had not
 * checked. `POST /api/user/localToken` — the path the platform itself uses —
 * makes the defect irrelevant, so the workaround is gone rather than dormant:
 * a dormant one is a thing somebody re-reaches for.
 *
 * `ProxyTokenIdentity` above is kept; `getProxyDetails` below still produces
 * that shape for the org-name and member lookups, which are unrelated to auth.
 */

/**
 * `GET /api/{PUBLIC_REFERENCEID}/getDetails` with the admin key — the call
 * `proxy.service.js#getProxyDetails` makes. Its rows demonstrably carry `email`
 * (`analytics.controller.js#toUserEntry` reads `user.email` off them), so this
 * is the fallback when the proxy-token path does not return one.
 */
export async function getProxyDetails(
  params: {
    company_id?: string | number;
    user_id?: string | number;
    pageNo?: number;
    itemsPerPage?: number;
  },
  referenceId: string = env.publicReferenceId(),
): Promise<{ rows: Msg91User[]; total: number }> {
  const payload = await httpJson<GetDetailsEnvelope>(`${ROUTES_BASE}/${referenceId}/getDetails`, {
    source: "msg91.getProxyDetails",
    headers: adminHeaders(),
    query: params,
    timeoutMs: env.msg91TimeoutMs(),
  });

  const page = payload?.data;
  const batch = Array.isArray(page?.data) ? page.data : [];
  return {
    rows: batch.map(toUserEntry).filter((u): u is Msg91User => u !== null),
    total: Number(page?.totalEntityCount) || 0,
  };
}

/** `analytics.controller.js#toUserEntry`, plus the role/date fields on the same row. */
function toUserEntry(user: unknown): Msg91User | null {
  const u = user as {
    id?: string | number;
    name?: string;
    email?: string;
    meta?: Record<string, unknown>;
    role?: { id?: number; name?: string };
    role_id?: number;
    last_login_at?: string | null;
    created_at?: string | null;
  };
  if (u?.id === null || u?.id === undefined) return null;
  return {
    id: String(u.id),
    name: u.name || null,
    email: u.email || null,
    meta: u.meta || null,
    role: u.role?.name || null,
    roleId: u.role?.id ?? u.role_id ?? null,
    lastLoginAt: u.last_login_at || null,
    createdAt: u.created_at || null,
  };
}

/** A single user by id, used by the identity fallback and the "Blocked by" lookup. */
export async function getUserById(userId: string, companyId?: string): Promise<Msg91User | null> {
  return cached(`msg91:user:${companyId ?? "-"}:${userId}`, MSG91_CACHE_TTL_MS, async () => {
    const { rows } = await getProxyDetails({ user_id: userId, company_id: companyId });
    return rows.find((r) => r.id === String(userId)) ?? rows[0] ?? null;
  });
}

/**
 * Every member of one org, paginated exactly as
 * `analytics.controller.js#loadOrgUserMap` does it: 100 per page, stop on
 * `totalEntityCount`, hard stop at 100 pages.
 */
export async function listOrgUsers(orgId: string): Promise<Msg91User[]> {
  return cached(`msg91:org-users:${orgId}`, MSG91_CACHE_TTL_MS, async () => {
    const byId = new Map<string, Msg91User>();
    let pageNo = 1;
    let hasMore = true;

    while (hasMore) {
      const { rows, total } = await getProxyDetails({ company_id: orgId, pageNo, itemsPerPage: 100 });
      for (const row of rows) byId.set(row.id, row);
      hasMore = rows.length > 0 && byId.size < total;
      pageNo += 1;
      if (pageNo > 100) break;
    }

    return [...byId.values()];
  });
}

/**
 * Every user of the `ADMIN_REFERENCEID` project (the admin console's own msg91
 * project) — the row set of the Admin access page. `getDetails` refuses (422)
 * a call with neither `company_id` nor `user_id`, so this walks the project's
 * companies and collects each one's users.
 */
export async function listReferenceUsers(): Promise<Msg91User[]> {
  return cached("msg91:reference-users", MSG91_CACHE_TTL_MS, async () => {
    const referenceId = env.adminReferenceId();
    const payload = await httpJson<GetDetailsEnvelope>(`${ROUTES_BASE}/${referenceId}/getCompanies`, {
      source: "msg91.getCompanies",
      headers: adminHeaders(),
      query: { itemsPerPage: MAX_ITEMS_PER_PAGE, pageNo: 1 },
      timeoutMs: env.msg91TimeoutMs(),
    });
    const companies = (Array.isArray(payload?.data?.data) ? payload.data.data : [])
      .map(toOrgEntry)
      .filter((o): o is Msg91Org => o !== null);

    const byId = new Map<string, Msg91User>();
    for (const company of companies) {
      const { rows } = await getProxyDetails({ company_id: company.id, pageNo: 1, itemsPerPage: 100 }, referenceId);
      for (const row of rows) byId.set(row.id, row);
    }
    return [...byId.values()];
  });
}

/** msg91 rejects anything above this with HTTP 422 — confirmed live. */
const MAX_ITEMS_PER_PAGE = 1000;

/**
 * The organisation universe (plan §4.1) — `proxy.utils.js:7 #getallOrgs`.
 * `report.controller.js#getMonthlyreports` uses the same call to drive a
 * platform-wide report, so this is the established source for "every org".
 *
 * One deliberate difference from gtwy-node: it asks for `itemsPerPage=17321` in
 * a single call, and msg91 now answers that with
 * `422 {"itemsPerPage":["The items per page must not be greater than 1000."]}`.
 * `getallOrgs()` swallows the error and returns `[]`, so gtwy-node's own org
 * list is empty today. We page at 1000 instead, which returns the same universe
 * from the same endpoint.
 */
export async function getAllOrgs(): Promise<Msg91Org[]> {
  return cached("msg91:all-orgs", MSG91_CACHE_TTL_MS, async () => {
    const byId = new Map<string, Msg91Org>();
    let pageNo = 1;
    let hasMore = true;

    while (hasMore) {
      const payload = await httpJson<{ data?: { data?: unknown[]; totalEntityCount?: number | string } }>(
        `${ROUTES_BASE}/${env.publicReferenceId()}/getCompanies`,
        {
          source: "msg91.getCompanies",
          headers: adminHeaders(),
          query: { itemsPerPage: MAX_ITEMS_PER_PAGE, pageNo },
          timeoutMs: env.msg91TimeoutMs(),
        },
      );

      const page = payload?.data;
      const batch = Array.isArray(page?.data) ? page.data : [];
      for (const org of batch) {
        const entry = toOrgEntry(org);
        if (entry) byId.set(entry.id, entry);
      }

      const total = Number(page?.totalEntityCount) || 0;
      hasMore = batch.length > 0 && byId.size < total;
      pageNo += 1;
      // Same guard `loadOrgUserMap` uses, so a bad `totalEntityCount` cannot loop.
      if (pageNo > 100) break;
    }

    return [...byId.values()];
  });
}

function toOrgEntry(org: unknown): Msg91Org | null {
  const o = org as {
    id?: string | number;
    name?: string;
    email?: string;
    created_at?: string | null;
    is_block?: boolean;
    created_by?: string | number | null;
  };
  if (o?.id === undefined || o?.id === null) return null;
  return {
    id: String(o.id),
    name: o.name ?? null,
    email: o.email || null,
    createdAt: o.created_at || null,
    isBlock: Boolean(o.is_block),
    createdBy: o.created_by === undefined || o.created_by === null ? null : String(o.created_by),
  };
}

/** Org id → name, for the many pages that render both. */
export async function orgNameMap(): Promise<Map<string, string | null>> {
  const orgs = await getAllOrgs();
  return new Map(orgs.map((o) => [o.id, o.name]));
}
