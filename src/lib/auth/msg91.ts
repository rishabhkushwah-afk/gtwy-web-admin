"use client";

/**
 * Loading and starting msg91's proxy-auth widget — the same handoff gtwy-ui
 * already owns (`components/Withauth.js` there) and GTWY-admin already shipped
 * (`utils/msg91.js`), with the same configuration shape and the same global
 * entry point. Reused, not re-derived (plan §14.2).
 *
 * **How the widget signals success is worth stating, because it is not the
 * `success` callback.** That callback fires for intermediate steps; the
 * completed sign-in arrives as a full-page navigation back to `redirect_path`
 * with `proxy_auth_token` in the query string. gtwy-ui relies on the redirect
 * and ignores the callback's payload, GTWY-admin does the same, and so does
 * this — rather than inventing a payload shape that nothing in either repo
 * documents. `success` is kept only to satisfy the widget's contract.
 *
 * Every value here is genuinely public: the widget runs in the browser, so it
 * could not be otherwise. The reference id is a public identifier both gtwy-ui
 * and GTWY-admin ship client-side; the bundle URL and the return path are not
 * secrets by any reading. Nothing server-side is exposed here, and no token of
 * any kind is stored by this module.
 *
 * The reference id is not read here. It arrives as an argument, read by the
 * login page on the server at request time (`env.msg91WidgetReferenceId`), so
 * that setting it on the host takes effect without a rebuild. It is
 * load-bearing twice over: the widget is configured with it, and it is also the
 * DOM id of the element the widget renders itself into.
 */

/** The query parameter msg91 appends on the way back. */
export const PROXY_AUTH_TOKEN_PARAM = "proxy_auth_token";

/** The widget bundle. gtwy-ui hardcodes this; here it stays overridable. */
export const MSG91_SCRIPT_SRC =
  process.env.NEXT_PUBLIC_MSG91_PROXY_AUTH_SRC || "https://36blocks.com/assets/proxy-auth/proxy-auth.js";

/** Where msg91 sends the browser back — the login page is entry and return leg both. */
export const MSG91_REDIRECT_PATH = process.env.NEXT_PUBLIC_MSG91_REDIRECT_PATH || "/login";

declare global {
  interface Window {
    initVerification?: (config: {
      referenceId: string;
      type: string;
      addInfo: Record<string, string>;
      theme?: "system" | "light" | "dark";
      success?: () => void;
      failure?: (error: unknown) => void;
    }) => void;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Inject the bundle once per page load; resolve when `initVerification` is callable. */
export function loadScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("The msg91 widget can only load in a browser."));
  }
  if (typeof window.initVerification === "function") return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = MSG91_SCRIPT_SRC;

    script.onload = () => {
      // The bundle defines `initVerification` shortly after it evaluates, not
      // during. gtwy-ui polls for it; so do we, but with a deadline so a bad
      // bundle surfaces as an error instead of a spinner that never ends.
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (typeof window.initVerification === "function") {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() - startedAt > 10_000) {
          clearInterval(poll);
          scriptPromise = null;
          reject(new Error("msg91 sign-in loaded but never became ready."));
        }
      }, 100);
    };

    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Could not load msg91 sign-in."));
    };

    document.body.appendChild(script);
  });

  return scriptPromise;
}

/**
 * Start the sign-in widget. It renders into the element whose DOM id **is** the
 * reference id, so that element must already be mounted (hidden is fine) before
 * this is called.
 *
 * `email` is passed to msg91 as a hint only — this console never decides
 * anything from it, and ships no allowlist to compare it against.
 */
export async function startMsg91SignIn({
  referenceId,
  email,
  onFailure,
}: { referenceId: string; email?: string; onFailure?: (error: unknown) => void }): Promise<void> {
  if (!referenceId) {
    throw new Error("NEXT_PUBLIC_REFERENCEID is not set, so msg91 sign-in cannot start.");
  }

  await loadScript();

  window.initVerification?.({
    referenceId,
    type: "authorization",
    // The widget defaults to "system" and turns its text white on a dark OS,
    // which vanishes against this console's light-only palette.
    theme: "light",
    addInfo: {
      redirect_path: MSG91_REDIRECT_PATH,
      ...(email ? { email } : {}),
    },
    success: () => {
      // Deliberately empty — the redirect is the real completion signal.
    },
    failure: (error) => {
      onFailure?.(error);
    },
  });
}

/** Pull the handoff token off the return URL. */
export function readProxyAuthToken(searchParams: URLSearchParams | null | undefined): string | null {
  const token = searchParams?.get(PROXY_AUTH_TOKEN_PARAM);
  return token ? token.trim() : null;
}

/**
 * Drop the handoff token from the address bar the moment it is read. It is a
 * live credential until the exchange spends it, and leaving it in the URL puts
 * it in history, in any copied link, and in the next page's referrer.
 */
export function stripProxyAuthTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PROXY_AUTH_TOKEN_PARAM)) return;
  url.searchParams.delete(PROXY_AUTH_TOKEN_PARAM);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}
