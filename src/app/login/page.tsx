"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  AdminFetchError,
  createSession,
  rememberDenial,
} from "@/lib/data/client";
import {
  MSG91_REFERENCE_ID,
  loadScript,
  readProxyAuthToken,
  startMsg91SignIn,
  stripProxyAuthTokenFromUrl,
} from "@/lib/auth/msg91";

/**
 * Sign-in, in three movements (plan §14.2):
 *
 *   1. The operator names their work e-mail and presses Continue. That mounts
 *      msg91's widget, which owns the credential step entirely.
 *   2. msg91 sends the browser back here with `?proxy_auth_token=…`. That value
 *      is stripped from the URL and traded — once, server-side, on
 *      `POST /api/admin/session` — for a session.
 *   3. That route asks gtwy-node whether this is an operator. Only a yes reaches
 *      `/`; a no reaches `/unauthorized`.
 *
 * The e-mail field is an input to msg91 and, if the answer is no, a string to
 * word the rejection with. **It is never compared against anything here:** this
 * client ships no allowlist, and the operator list lives only in gtwy-node's
 * admin msg91 project (`ADMIN_REFERENCEID`).
 *
 * No token of any kind is held by this component. The session JWT never reaches
 * JavaScript at all — it lives only in the httpOnly cookie the route sets.
 */

/** Survives the msg91 round trip, which is a full page navigation away and back. */
const REMEMBERED_EMAIL_KEY = "gtwy_admin_login_email";

function rememberEmail(email: string) {
  try {
    window.sessionStorage.setItem(REMEMBERED_EMAIL_KEY, email);
  } catch {
    // Storage can be unavailable. The address is only used to word an error.
  }
}

function recallEmail(): string {
  try {
    return window.sessionStorage.getItem(REMEMBERED_EMAIL_KEY) || "";
  } catch {
    return "";
  }
}

function LoginScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const proxyAuthToken = readProxyAuthToken(searchParams);

  const [email, setEmail] = React.useState("");
  const [phase, setPhase] = React.useState<
    "idle" | "widget" | "exchanging" | "retryable"
  >(proxyAuthToken ? "exchanging" : "idle");
  const [loginErr, setLoginErr] = React.useState("");
  // React mounts effects twice in development. The handoff token is single-use,
  // so a second exchange would fail against a token already spent. This only
  // gates the automatic first attempt — a manual "Try again" bypasses it.
  const exchangeStarted = React.useRef(false);
  // Held only when the token was never spent (the request never reached
  // gtwy-node), so a manual retry can reuse it without a new MSG91 round trip.
  const retainedToken = React.useRef<string | null>(null);

  React.useEffect(() => {
    setEmail(recallEmail());
  }, []);

  // Fetch the msg91 bundle as soon as the page is shown, so the click that
  // starts sign-in does not wait on it. A failure here is not surfaced: the
  // same load is retried (and reported) when the operator actually clicks.
  React.useEffect(() => {
    if (proxyAuthToken) return;
    loadScript().catch(() => {});
  }, [proxyAuthToken]);

  const exchangeToken = React.useCallback(
    (token: string) => {
      createSession(token)
        .then(() => {
          // A full navigation, not `router.push`: the session cookie has just
          // been set and every cached mock-era payload above is stale.
          window.location.assign("/");
        })
        .catch((err: unknown) => {
          const typed = recallEmail();

          if (err instanceof AdminFetchError && err.code === "forbidden") {
            // Signed in, but not an operator — or signed in with a session the
            // platform attached no e-mail to. The server's sentence already says
            // which, in the operator's language; `/unauthorized` renders it.
            retainedToken.current = null;
            rememberDenial({ message: err.message, email: typed });
            router.replace("/unauthorized");
            return;
          }

          if (
            err instanceof AdminFetchError &&
            (err.code === "upstream_unavailable" || err.code === "network")
          ) {
            // The request never reached gtwy-node, so the token was never
            // spent — keep it so "Try again" can reuse it with no new MSG91
            // round trip.
            retainedToken.current = token;
            setPhase("retryable");
            setLoginErr(
              "gtwy.ai's backend is not responding. Your sign-in link is still valid — try again."
            );
            return;
          }

          // Token now expired or spent (e.g. a retry came back `bad_request`).
          // No endless retry on a dead token — fall back to the idle form.
          retainedToken.current = null;
          setPhase("idle");
          setLoginErr(
            err instanceof AdminFetchError
              ? err.message
              : "Sign-in could not be completed. Try again."
          );
        });
    },
    [router]
  );

  React.useEffect(() => {
    if (!proxyAuthToken || exchangeStarted.current) return;
    exchangeStarted.current = true;

    // Spend it and get it out of the address bar, history and referrers.
    stripProxyAuthTokenFromUrl();
    exchangeToken(proxyAuthToken);
  }, [proxyAuthToken, exchangeToken]);

  function retryExchange() {
    const token = retainedToken.current;
    if (!token) return;
    setPhase("exchanging");
    setLoginErr("");
    exchangeToken(token);
  }

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (!em) {
      setLoginErr("Enter your work e-mail.");
      return;
    }

    setLoginErr("");
    rememberEmail(em);
    setPhase("widget");

    try {
      await startMsg91SignIn({
        email: em,
        onFailure: () => {
          setLoginErr("MSG91 could not sign you in. Try again.");
          setPhase("idle");
        },
      });
    } catch (err) {
      setLoginErr(
        err instanceof Error ? err.message : "MSG91 sign-in is unavailable."
      );
      setPhase("idle");
    }
  }

  const busy = phase === "exchanging";
  const widget = phase === "widget";
  const retryable = phase === "retryable";

  return (
    <div
      className="min-h-screen grid grid-cols-1 min-[769px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      style={{ background: "var(--color-bg)" }}
    >
      <div
        className="p-12 max-sm:p-6 flex flex-col justify-between gap-12 min-[769px]:border-r-2 max-[768px]:border-b-2"
        style={{ borderColor: "var(--color-divider)", borderStyle: "solid" }}
      >
        <div
          style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 800,
            fontSize: 18,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 14,
              height: 14,
              background: "var(--color-accent)",
            }}
          />
          gtwy.ai{" "}
          <span style={{ fontWeight: 400, color: "var(--color-neutral-600)" }}>
            / Admin
          </span>
        </div>
        <div>
          <h1
            className="max-sm:!text-[40px]"
            style={{
              fontSize: 56,
              lineHeight: 1,
              margin: "0 0 20px",
              maxWidth: 560,
              textWrap: "pretty",
            }}
          >
            Platform operations console.
          </h1>
          <p
            style={{
              fontSize: 16,
              maxWidth: 460,
              color: "var(--color-neutral-700)",
            }}
          >
            Workspaces, billing, embeds and observability for every organisation
            on gtwy.ai.
          </p>
        </div>
        <div
          className="flex gap-6 max-sm:flex-col max-sm:gap-1"
          style={{ fontSize: 12, color: "var(--color-neutral-600)" }}
        >
          <span>Internal · admin project only</span>
          <span>v2026.09</span>
        </div>
      </div>

      <div className="flex items-center justify-center p-12 max-sm:p-6">
        <form
          className="flex flex-col gap-5"
          style={{ width: "min(380px, 100%)" }}
          onSubmit={submitLogin}
        >
          <div>
            <h6 style={{ color: "var(--color-accent)", marginBottom: 12 }}>
              Invite-only access
            </h6>
            <h3 style={{ margin: "0 0 6px" }}>Sign in</h3>
            <p
              style={{
                fontSize: 13,
                color: "var(--color-neutral-700)",
                margin: 0,
              }}
            >
              Only users of the admin project can continue. There is no
              self-serve sign-up.
            </p>
          </div>

          {widget || retryable ? null : (
            <Field label="Work e-mail">
              <Input
                type="email"
                placeholder="you@walkover.in"
                value={email}
                autoFocus
                disabled={busy}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setLoginErr("");
                }}
              />
            </Field>
          )}

          {loginErr ? <div className="callout">{loginErr}</div> : null}

          {/*
            MSG91 renders its widget into the element whose DOM id IS the
            reference id, and that element must exist before initVerification
            runs — so it is always mounted and merely hidden until Continue.
          */}
          <div
            id={MSG91_REFERENCE_ID}
            style={{ display: widget ? "block" : "none" }}
          />

          {widget ? null : retryable ? (
            <button
              className="btn btn-primary"
              type="button"
              onClick={retryExchange}
              style={{
                justifyContent: "flex-start",
                padding: "12px 14px",
                fontSize: 14,
              }}
            >
              Try again
            </button>
          ) : (
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy}
              style={{
                justifyContent: "flex-start",
                padding: "12px 14px",
                fontSize: 14,
              }}
            >
              {busy ? "Completing sign-in…" : "Continue with MSG91 SSO"}
            </button>
          )}

          <div
            style={{
              fontSize: 12,
              color: "var(--color-neutral-600)",
              borderTop: "1px solid var(--color-divider)",
              paddingTop: 12,
            }}
          >
            Need access? Ask an existing admin to add you to{" "}
            the admin msg91 project.
          </div>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // `useSearchParams` needs a Suspense boundary to keep this route from opting
  // the whole app out of static rendering at build time.
  return (
    <React.Suspense fallback={null}>
      <LoginScreen />
    </React.Suspense>
  );
}
