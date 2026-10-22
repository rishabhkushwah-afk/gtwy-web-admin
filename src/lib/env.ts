import "server-only";

/**
 * Server-side environment, read in one place.
 *
 * Names only — no value ever appears here, in a comment, or in a commit.
 * Nothing in this file may be imported from a client component; `server-only`
 * turns that into a build error rather than a leaked secret.
 *
 * The names are gtwy-node's own (plan §14.3): exactly one name per value, so a
 * gtwy-node `.env` copies across unchanged and a key cannot drift between the
 * two files. The plan's earlier `MONGODB_URI` / `POSTGRES_*` / `TIMESCALE_URL`
 * aliases are retired — revision 3 renamed them and revision 4 removed the last
 * of them from `.env.local`.
 */

function read(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Throws with the variable name — never the value — when a required var is absent. */
function require_(...names: string[]): string {
  const value = read(...names);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
  }
  return value;
}

function int(fallback: number, ...names: string[]): number {
  const raw = read(...names);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  // Mongo — gtwy-node config/mongo_config.js.
  mongoUri: () => require_("MONGODB_CONNECTION_URI"),
  mongoDbName: () => require_("MONGODB_DATABASE_NAME"),

  // Postgres — gtwy-node config/config.js.
  postgres: () => ({
    host: require_("DB_HOST"),
    port: int(5432, "DB_PORT"),
    database: require_("DB_NAME"),
    user: require_("DB_USER"),
    password: require_("DB_PASS"),
  }),

  // Timescale — gtwy-node config/timescale_config.js takes a single service URL
  // (with SSL required). The discrete TIMESCALE_* names below are a real
  // alternative shape, not a retired alias: they serve a deployment that splits
  // the URL out rather than one that spells it differently.
  timescaleUrl: () => read("TIMESCALE_SERVICE_URL"),
  timescaleParts: () => ({
    host: read("TIMESCALE_HOST"),
    port: int(5432, "TIMESCALE_PORT"),
    database: read("TIMESCALE_DB"),
    user: read("TIMESCALE_USER"),
    password: read("TIMESCALE_PASSWORD"),
  }),

  adminSessionSecret: () => require_("ADMIN_SESSION_SECRET"),

  // msg91 — proxy.utils.js#getallOrgs and proxy.service.js#getProxyDetails.
  adminApiKey: () => require_("ADMIN_API_KEY"),
  publicReferenceId: () => require_("PUBLIC_REFERENCEID"),
  // The admin console's own msg91 project: its users are the Admin access list.
  adminReferenceId: () => require_("ADMIN_REFERENCEID"),
  msg91TimeoutMs: () => int(10_000, "MSG91_TIMEOUT_MS"),

  // Lago — lago.service.js.
  billingApiUrl: () => read("BILLING_API_URL"),
  billingApiKey: () => read("BILLING_API_KEY"),
  billingTimeoutMs: () => int(10_000, "BILLING_API_TIMEOUT_MS"),
  lagoCreditRateUsd: () => Number(read("LAGO_CREDIT_RATE_USD") ?? "0"),

  // The Lago plan_code ↔ slug map, exactly as gtwy-node's configs/billingPlans.js
  // reads it. Per-environment, so it can only come from env; when it is unset we
  // fall back to gtwy-node's own slug vocabulary — see `planSlugForCode`.
  lagoPlanCodeFree: () => read("LAGO_PLAN_CODE_FREE"),
  lagoPlanCodePaid: () => read("LAGO_PLAN_CODE_PAID"),

  // gtwy-node, the proxy target for the four live actions (plan §3).
  gtwyApiBase: () => require_("GTWY_API_BASE"),

  environment: () => read("ENVIRONMENT") ?? "unknown",

  /** True when the variable is set to a non-empty value. Never returns the value. */
  isSet: (...names: string[]) => read(...names) !== undefined,
} as const;

/** SQL statement timeout, plan §7. Applied to every Postgres and Timescale pool. */
export const SQL_STATEMENT_TIMEOUT_MS = 5_000;

/** Session cookie TTL, plan §2.2. */
export const SESSION_TTL_SECONDS = 15 * 60;

/** Server-side msg91 cache TTL, plan §4.1. */
export const MSG91_CACHE_TTL_MS = 5 * 60 * 1000;
