/**
 * The data accessors (plan §1.3).
 *
 * Every function keeps the name and the payload type it has in
 * `src/mocks/index.ts`; the only change is that it becomes async, because it
 * fetches. `src/mocks/types.ts` stays the contract and page imports do not
 * change — pages keep importing from `@/mocks`, which re-exports from here as
 * each page is converted.
 *
 * **Sequencing.** D0 builds the foundation and changes no page, so every
 * accessor below still resolves the frozen fixture. Each later task replaces one
 * body with `adminFetch` + its mapper and converts that one page to `useEffect`
 * + `PageStateBoundary` in the same commit — so the app is never half-async.
 * The `@route` tag on each accessor names the endpoint it is waiting for and the
 * task that owns it, taken from plan §5.
 */

import type {
  BlockedRow,
  Embed,
  EmbedRow,
  Invoice,
  PlanCard,
  PlanChoice,
  WorkspaceDetailView,
  WorkspaceKpi,
  WorkspaceTab,
} from "@/mocks/types";
import { adminFetch } from "@/lib/data/client";
import {
  mapEmbed,
  mapEmbedDetail,
  mapEmbedRow,
  type EmbedDetailPanel,
  type RawEmbedAgent,
  type RawEmbedDetail,
  type RawEmbedEndUser,
  type RawEmbedList,
} from "@/lib/mappers/embeds";
import { mapBlockedRows, type RawBlockedOrg, type RawInternalOrg } from "@/lib/mappers/blocked";
import {
  mapInvoices,
  mapPlanCards,
  mapPlanChoices,
  type RawInvoice,
  type RawPlans,
} from "@/lib/mappers/billing";
import { mapUsage } from "@/lib/mappers/usage";
import { mapPlatformKeys, type RawPlatformKeys } from "@/lib/mappers/platformKeys";
import { mapAdmins, type RawAdminAccessRow } from "@/lib/mappers/admins";
import {
  AUDIT_PAGE_SIZE,
  mapAuditPage,
  type AuditPage,
  type RawAuditAction,
  type RawAuditPage,
} from "@/lib/mappers/audit";
import {
  DEFAULT_PAGE_SIZE,
  mapWorkspaceList,
  type WorkspaceListPage,
  type WorkspaceListQuery,
  type WorkspaceListRaw,
} from "@/lib/mappers/workspaces";
import {
  mapKpis,
  mapTabs,
  mapWorkspaceDetail,
  mapWorkspaceEmbedRow,
  type RawWorkspaceAgent,
  type RawWorkspaceApiKey,
  type RawWorkspaceBilling,
  type RawWorkspaceBundle,
  type RawWorkspaceEmbed,
  type RawWorkspaceHeader,
  type RawWorkspaceKnowledgeBase,
  type RawWorkspaceMember,
  type RawWorkspaceTool,
  type RawWorkspaceUsage,
} from "@/lib/mappers/workspaceDetail";
import {
  mapFailingAgents,
  mapKpis as mapOverviewKpis,
  mapOrgRates,
} from "@/lib/mappers/overview";
import {
  DEFAULT_OVERVIEW_RANGE,
  OVERVIEW_ROW_LIMIT,
  type FailingAgentRow,
  type OrgSuccessRateRow,
  type OverviewKpis,
  type OverviewRange,
} from "@/lib/metrics/overview-contract";
import {
  DEFAULT_USAGE_RANGE,
  type PlatformUsage,
  type UsageRange,
} from "@/lib/metrics/usage-contract";

export * from "@/mocks/types";
export * from "@/mocks/nav";

/** The `/usage` window vocabulary, so the page can type its own toggle state. */
export { DEFAULT_USAGE_RANGE, USAGE_RANGES, type UsageRange } from "@/lib/metrics/usage-contract";

/** The `/workspaces` filter vocabulary and page shape, for the same reason. */
export {
  DEFAULT_PAGE_SIZE,
  WORKSPACE_FILTERS,
  type WorkspaceFilter,
  type WorkspaceListPage,
  type WorkspaceListQuery,
} from "@/lib/mappers/workspaces";

/** The `/access/audit` page shape and its four action codes, for the same reason. */
export {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABEL,
  AUDIT_PAGE_SIZE,
  type AuditPage,
  type RawAuditAction,
} from "@/lib/mappers/audit";

/** The `/` window vocabulary, plus the heading the live toggle drives. */
export {
  DEFAULT_OVERVIEW_RANGE,
  OVERVIEW_RANGES,
  type OverviewRange,
} from "@/lib/metrics/overview-contract";
export { OVERVIEW_RANGE_TITLE } from "@/lib/mappers/overview";

/** The four live actions (plan §3), for the pages that own their controls. */
export * from "@/lib/data/actions";

/**
 * `GET /api/admin/overview/kpis · failing-agents · org-rates` — live (D1).
 *
 * Same `{ kpis, failingAgents, orgRates }` payload the fixture accessor
 * returned, so the page destructures exactly what it always did. The three
 * routes are independent reads and go out together; the range toggle is live
 * (plan §4.5 Q22) and reaches all three, so the KPI strip and the two tables can
 * never end up describing different windows.
 */
export const getOverview = async (
  range: OverviewRange = DEFAULT_OVERVIEW_RANGE,
  signal?: AbortSignal,
) => {
  const window = `range=${encodeURIComponent(range)}`;
  const rows = `${window}&limit=${OVERVIEW_ROW_LIMIT}`;

  const [kpisRaw, agentsRaw, ratesRaw] = await Promise.all([
    adminFetch<OverviewKpis>(`/api/admin/overview/kpis?${window}`, { signal }),
    adminFetch<FailingAgentRow[]>(`/api/admin/overview/failing-agents?${rows}`, { signal }),
    adminFetch<OrgSuccessRateRow[]>(`/api/admin/overview/org-rates?${rows}`, { signal }),
  ]);

  return {
    kpis: mapOverviewKpis(kpisRaw),
    failingAgents: mapFailingAgents(agentsRaw),
    orgRates: mapOrgRates(ratesRaw),
  };
};

/**
 * `GET /api/admin/workspaces` — live (D2).
 *
 * The one accessor whose **return type** changed rather than just becoming
 * async: the list is paginated (plan §5, Q48 — 25 a page) and the design's
 * heading renders the count of the whole filtered set, not of the page, so the
 * page needs `total` alongside `rows`. `rows` is still `WorkspaceRow[]` and
 * `src/mocks/types.ts` is still the contract for it.
 *
 * `filter` and `q` are parameters because plan §4.5 makes the Workspaces plan
 * filter and the header search real. `q` matches **org id and org name only**
 * (§9 gap 11).
 */
export const getWorkspaceRows = async (
  options: WorkspaceListQuery = {},
  signal?: AbortSignal,
): Promise<WorkspaceListPage> => {
  const params = new URLSearchParams();
  params.set("page", String(options.page ?? 1));
  params.set("pageSize", String(options.pageSize ?? DEFAULT_PAGE_SIZE));
  params.set("filter", options.filter ?? "all");
  if (options.q) params.set("q", options.q);

  return mapWorkspaceList(
    await adminFetch<WorkspaceListRaw>(`/api/admin/workspaces?${params.toString()}`, { signal }),
  );
};

/**
 * `GET /api/admin/workspaces/:orgId` and its eight tab routes — live (D3).
 *
 * The design's tab strip switches client-side and must not refetch, so one
 * `Workspace` is all nine payloads. They go out together, the way `getEmbed`
 * issues its three.
 *
 * `getWorkspace`, `getWorkspaceDetail` and `getWorkspaceEmbedRows` are three
 * accessors over **one** bundle: the page calls all three on the same render,
 * and issuing nine requests three times over would be nine requests too many.
 * `workspaceBundleOnce` shares the in-flight fetch exactly as
 * `embedDetailOnce` does — it is not a cache, and a second page-load fetches
 * again.
 */
export const getWorkspace = async (
  orgId: string,
  signal?: AbortSignal,
): Promise<WorkspaceDetailView> => mapWorkspaceDetail(await workspaceBundleOnce(orgId, signal));

/** The header KPI strip and the tab strip — the same bundle `getWorkspace` reads. */
export const getWorkspaceDetail = async (
  orgId: string,
): Promise<{ kpis: WorkspaceKpi[]; tabs: WorkspaceTab[] }> => {
  const { header } = await workspaceBundleOnce(orgId);
  return { kpis: mapKpis(header), tabs: mapTabs(header) };
};

/** @route GET /api/admin/workspaces/:orgId/embeds — D3 */
export const getWorkspaceEmbedRows = async (orgId: string): Promise<EmbedRow[]> =>
  (await workspaceBundleOnce(orgId)).embeds.map(mapWorkspaceEmbedRow);

/**
 * The nine reads, issued together and shared across the three accessors above.
 *
 * The header is awaited first and on its own: an unknown org is a `404
 * not_found` there, and firing eight tab requests at an org that does not exist
 * would answer eight empty arrays before anyone noticed. Every tab route is
 * independent of every other, so the eight go out in parallel once the org is
 * known to be real.
 *
 * The shared request carries no `AbortSignal` of its own — one caller
 * unmounting must not cancel another's. `useRemoteData` discards a result that
 * arrives after its own abort, so a dangling response is harmless.
 */
const inFlightWorkspace = new Map<string, Promise<RawWorkspaceBundle>>();

function workspaceBundleOnce(orgId: string, signal?: AbortSignal): Promise<RawWorkspaceBundle> {
  const existing = inFlightWorkspace.get(orgId);
  if (existing) return existing;

  const request = loadWorkspaceBundle(orgId, signal).finally(() => {
    inFlightWorkspace.delete(orgId);
  });
  inFlightWorkspace.set(orgId, request);
  return request;
}

async function loadWorkspaceBundle(orgId: string, signal?: AbortSignal): Promise<RawWorkspaceBundle> {
  const base = `/api/admin/workspaces/${encodeURIComponent(orgId)}`;
  const tab = <T,>(path: string) => adminFetch<T>(`${base}${path}`, { signal });

  const header = await adminFetch<RawWorkspaceHeader>(base, { signal });

  const [agents, apikeys, knowledgeBases, tools, members, usage, billing, embeds] = await Promise.all([
    tab<RawWorkspaceAgent[]>("/agents"),
    tab<RawWorkspaceApiKey[]>("/apikeys"),
    tab<RawWorkspaceKnowledgeBase[]>("/knowledge-bases"),
    tab<RawWorkspaceTool[]>("/tools"),
    tab<RawWorkspaceMember[]>("/members"),
    tab<RawWorkspaceUsage>("/usage?range=30d"),
    tab<RawWorkspaceBilling>("/billing"),
    tab<RawWorkspaceEmbed[]>("/embeds"),
  ]);

  return { header, agents, apikeys, knowledgeBases, tools, members, usage, billing, embeds };
}

/**
 * Just the org's name, for the header breadcrumb.
 *
 * It shares `getWorkspace`'s in-flight bundle rather than issuing nine reads of
 * its own, and answers `null` rather than throwing — a breadcrumb must never be
 * the thing that fails a page. The same treatment `getEmbedName` gets.
 *
 * @route GET /api/admin/workspaces/:orgId
 */
export const getWorkspaceName = async (orgId: string): Promise<string | null> => {
  try {
    return (await workspaceBundleOnce(orgId)).header.name;
  } catch {
    return null;
  }
};

/**
 * The org ids the Workspaces list opens on.
 *
 * It used to drive `generateStaticParams`, which is gone: the workspace
 * universe is msg91's live company list and a workspace's own page changes
 * whenever its traffic does, so `/workspaces/[orgId]` is rendered on request
 * now. Kept because the shape is part of the accessor contract.
 *
 * @route GET /api/admin/workspaces — D2
 */
export const getWorkspaceIds = async (signal?: AbortSignal): Promise<string[]> =>
  (await getWorkspaceRows({}, signal)).rows.map((w) => w.id);

/**
 * Live — D4. Mongo `blocked_orgs` joined with msg91 names (plan §4.1), mapped
 * into the design's `BlockedRow` by `mappers/blocked.ts`.
 *
 * @route GET /api/admin/blocked
 */
export const getBlockedRows = async (signal?: AbortSignal): Promise<BlockedRow[]> =>
  mapBlockedRows(await adminFetch<RawBlockedOrg[]>("/api/admin/blocked", { signal }));

/**
 * Live — D4. No page renders this; the control it feeds is on the Workspace
 * detail page and belongs to D3 (plan §5 item 11, revision 3). Exported so D3
 * reads membership from here rather than querying `internal_orgs` a second time.
 *
 * @route GET /api/admin/internal-orgs
 */
export const getInternalOrgs = async (signal?: AbortSignal): Promise<RawInternalOrg[]> =>
  adminFetch<RawInternalOrg[]>("/api/admin/internal-orgs", { signal });

/**
 * `GET /api/admin/embeds` — live (D5).
 *
 * Same treatment as `/workspaces`: the list is paginated (plan §5, Q48 — 25 a
 * page) and the heading counts the whole set rather than the page, so the
 * payload is `{ rows, total, page, pageSize }` around the same `EmbedRow[]`.
 * `embedRows` stays in `@/mocks/embeds` as the fixture `tests/embeds.test.ts`
 * asserts the mappers against.
 */
export const getEmbedRows = async (
  options: EmbedListQuery = {},
  signal?: AbortSignal,
): Promise<EmbedListPage> => {
  const params = new URLSearchParams();
  params.set("page", String(options.page ?? 1));
  params.set("pageSize", String(options.pageSize ?? EMBED_PAGE_SIZE));
  if (options.q) params.set("q", options.q);

  const raw = await adminFetch<RawEmbedList>(`/api/admin/embeds?${params.toString()}`, { signal });
  return { ...raw, rows: raw.rows.map(mapEmbedRow) };
};

/**
 * `GET /api/admin/embeds/:folderId` (+ `/agents`, `/end-users`) — live (D5).
 *
 * The design's `Embed` carries its agents and its top end users inside it, and
 * plan §5 keeps those on their own routes, so one `Embed` is three requests.
 * They are issued together.
 */
export const getEmbed = async (embedId: string, signal?: AbortSignal): Promise<Embed> => {
  const base = `/api/admin/embeds/${encodeURIComponent(embedId)}`;
  const [detail, agents, endUsers] = await Promise.all([
    embedDetailOnce(embedId),
    adminFetch<RawEmbedAgent[]>(`${base}/agents`, { signal }),
    adminFetch<RawEmbedEndUser[]>(`${base}/end-users`, { signal }),
  ]);
  return mapEmbed(detail, agents, endUsers);
};

/**
 * The header KPIs and the config panel's key order — the same
 * `GET /api/admin/embeds/:folderId` payload `getEmbed` reads.
 *
 * @route GET /api/admin/embeds/:folderId
 */
export const getEmbedDetail = async (embedId: string): Promise<EmbedDetailPanel> =>
  mapEmbedDetail(await embedDetailOnce(embedId));

/**
 * `getEmbed` and `getEmbedDetail` are called together by the detail page and
 * both need `/api/admin/embeds/:folderId`, so the in-flight request is shared
 * rather than issued twice. The entry lives exactly as long as the request: it
 * is not a cache, and a second page-load fetches again.
 *
 * The shared request carries no `AbortSignal` — one caller unmounting must not
 * cancel the other's. `useRemoteData` discards a result that arrives after its
 * own abort, so the dangling response is harmless.
 */
const inFlightEmbedDetail = new Map<string, Promise<RawEmbedDetail>>();

function embedDetailOnce(embedId: string): Promise<RawEmbedDetail> {
  const existing = inFlightEmbedDetail.get(embedId);
  if (existing) return existing;

  const request = adminFetch<RawEmbedDetail>(`/api/admin/embeds/${encodeURIComponent(embedId)}`).finally(
    () => {
      inFlightEmbedDetail.delete(embedId);
    },
  );
  inFlightEmbedDetail.set(embedId, request);
  return request;
}

/**
 * Just the folder's name, for the header breadcrumb.
 *
 * It shares `getEmbed`'s in-flight detail request rather than issuing the two
 * extra reads the full `Embed` needs, and answers `null` rather than throwing —
 * a breadcrumb must never be the thing that fails a page.
 *
 * @route GET /api/admin/embeds/:folderId
 */
export const getEmbedName = async (embedId: string): Promise<string | null> => {
  try {
    return (await embedDetailOnce(embedId)).name;
  } catch {
    return null;
  }
};

/** Plan §4.5 Q48 — 25 rows where the design does not specify. */
export const EMBED_PAGE_SIZE = 25;

/** The config panel's own payload shape, so the page can type its loader. */
export type { EmbedDetailPanel } from "@/lib/mappers/embeds";

export interface EmbedListQuery {
  page?: number;
  pageSize?: number;
  q?: string;
}

export interface EmbedListPage {
  rows: EmbedRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The embed ids on the first page.
 *
 * It used to drive `generateStaticParams`, which is gone: there are hundreds of
 * embed folders and their config changes, so `/embeds/[embedId]` is rendered on
 * request now. Kept because the shape is part of the accessor contract.
 *
 * @route GET /api/admin/embeds
 */
export const getEmbedIds = async (signal?: AbortSignal): Promise<string[]> =>
  (await getEmbedRows({}, signal)).rows.map((e) => e.id);

/**
 * `GET /api/admin/usage` — live (D6).
 *
 * `range` is a parameter because plan §4.5 Q22 makes the page's 7d/30d/90d
 * toggle a real filter; it defaults to the window the control opens on, so a
 * caller that passes nothing gets what the page shows on first paint.
 */
export const getUsage = async (
  range: UsageRange = DEFAULT_USAGE_RANGE,
  signal?: AbortSignal,
) =>
  mapUsage(
    await adminFetch<PlatformUsage>(`/api/admin/usage?range=${encodeURIComponent(range)}`, {
      signal,
    }),
  );

/**
 * `GET /api/admin/billing/plans` — live (D7).
 *
 * Mongo `billing_plans` joined with Lago for price, org count and MRR. The
 * route leaves every Lago-sourced field null when Lago is unreachable and
 * `mapPlanCards` renders those as em dashes, so the Mongo half of each card
 * still shows (plan §7).
 */
export const getPlans = async (signal?: AbortSignal): Promise<PlanCard[]> =>
  mapPlanCards(await adminFetch<RawPlans>("/api/admin/billing/plans", { signal }));

/**
 * The plan picker's options — the active plans, `billingPlan.service.js#listActivePlans`.
 * Same route as `getPlans`; the filter is the mapper's, not a second request.
 *
 * @route GET /api/admin/billing/plans
 */
export const getPlanChoices = async (signal?: AbortSignal): Promise<PlanChoice[]> =>
  mapPlanChoices(await adminFetch<RawPlans>("/api/admin/billing/plans", { signal }));

/**
 * `GET /api/admin/billing/invoices` — live (D7). Lago-only; there is no
 * database source for an invoice.
 */
export const getInvoices = async (
  limit = DEFAULT_INVOICE_LIMIT,
  signal?: AbortSignal,
): Promise<Invoice[]> =>
  mapInvoices(
    await adminFetch<RawInvoice[]>(`/api/admin/billing/invoices?limit=${encodeURIComponent(limit)}`, {
      signal,
    }),
  );

/** Plan §4.5 Q48 — 25 rows where the design does not specify. */
export const DEFAULT_INVOICE_LIMIT = 25;

/**
 * `GET /api/admin/platform-keys` — live (D8).
 *
 * Same `{ rows, missing }` payload the fixture accessor returned. The route
 * answers in raw values — a masked key, an ISO date, a call count — and
 * `mapPlatformKeys` turns them into the strings the design renders, including
 * the callout's comma-joined service list.
 */
export const getPlatformKeys = async (signal?: AbortSignal) =>
  mapPlatformKeys(await adminFetch<RawPlatformKeys>("/api/admin/platform-keys", { signal }));

/**
 * `GET /api/admin/admins` — live (D9).
 *
 * One row per user of the `ADMIN_REFERENCEID` msg91 project. The route answers raw —
 * `{ email, lastActiveAt }`, ISO-8601 or `null` — and `mapAdmins` turns
 * `lastActiveAt` into the IST timestamp, or "never" for an admin who has taken
 * no auditable action in this console.
 *
 * The payload type is deliberately **not** the old `AdminRow[]`: this is the one
 * page whose columns the board instructed us to cut down to e-mail and last
 * active. See `AdminAccessRow` in `@/mocks/types`.
 */
export const getAdmins = async (signal?: AbortSignal) =>
  mapAdmins(await adminFetch<RawAdminAccessRow[]>("/api/admin/admins", { signal }));

/**
 * `GET /api/admin/audit` — live (D10).
 *
 * Mongo `admin_audit_logs`, newest first, 25 a page (plan §5 page 10). Like
 * `/workspaces` and `/embeds` this is the second kind of accessor whose **return
 * type** carries a `total` alongside `rows`, because the design's heading counts
 * the whole log rather than the page. `rows` is still `AuditEntry[]` and
 * `src/mocks/types.ts` is still the contract for it.
 *
 * The three filters plan §5 names are parameters here even though no control on
 * the page sets them — the design has no filter bar and the UI does not change.
 * They exist so the route's contract and this accessor's agree, and so QA can
 * drive them.
 *
 * **Read-only.** There is no `writeAudit` counterpart in this module and there
 * must not be one: the log is appended to only by the four proxied actions in
 * `@/lib/data/actions`, server-side, after gtwy-node returns success.
 */
export const getAuditEntries = async (
  options: AuditQueryOptions = {},
  signal?: AbortSignal,
): Promise<AuditPage> => {
  const params = new URLSearchParams();
  params.set("page", String(options.page ?? 1));
  params.set("pageSize", String(options.pageSize ?? AUDIT_PAGE_SIZE));
  if (options.action) params.set("action", options.action);
  if (options.adminEmail) params.set("adminEmail", options.adminEmail);
  if (options.orgId) params.set("orgId", options.orgId);

  return mapAuditPage(
    await adminFetch<RawAuditPage>(`/api/admin/audit?${params.toString()}`, { signal }),
  );
};

export interface AuditQueryOptions {
  page?: number;
  pageSize?: number;
  action?: RawAuditAction;
  adminEmail?: string;
  orgId?: string;
}
