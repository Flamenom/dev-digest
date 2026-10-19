/* lib/sign-in-redirect — the ONE way the client leaves the app for the sign-in
   screen (AC-35). Used by the global 401 handler (providers.tsx), <AuthGate>
   and sign-out. A module-level flag makes it fire at most once per page load,
   and it never fires while already on /sign-in — so a burst of parallel 401s
   yields exactly one navigation and the app cannot loop with the sign-in page.

   A full-page navigation (not router.push) on purpose: it drops every cached
   query of the signed-out user. */

export const SIGN_IN_PATH = "/sign-in";

/** Indirection over `window.location` so tests can observe navigations. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

let redirecting = false;

/** True for `/sign-in` and anything below it. */
export function isSignInPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === SIGN_IN_PATH || pathname.startsWith(`${SIGN_IN_PATH}/`);
}

/**
 * A same-origin, relative return target. Anything that is not a plain
 * `/path` (absolute URLs, protocol-relative `//host`, backslash tricks,
 * control chars, the sign-in page itself) collapses to `/`. The server
 * validates again (AC-16); this only keeps the client from forwarding junk.
 */
export function safeReturnTo(target: string | null | undefined): string {
  if (!target || !target.startsWith("/")) return "/";
  if (target.startsWith("//") || target.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return "/";
  if (isSignInPath(target.split(/[?#]/, 1)[0])) return "/";
  return target;
}

/** `/sign-in?return_to=<encoded path>` (no param when the target is `/`). */
export function buildSignInHref(returnTo?: string | null): string {
  const target = safeReturnTo(returnTo);
  return target === "/"
    ? SIGN_IN_PATH
    : `${SIGN_IN_PATH}?return_to=${encodeURIComponent(target)}`;
}

/** Current path + query of the page (the return target). */
function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Navigate to the sign-in screen, keeping `returnTo` (default: the current
 * page) as the return target. No-op when already redirecting or on /sign-in.
 * Returns whether a navigation was issued.
 */
export function redirectToSignIn(returnTo?: string): boolean {
  if (typeof window === "undefined") return false;
  if (redirecting || isSignInPath(window.location.pathname)) return false;
  redirecting = true;
  navigation.assign(buildSignInHref(returnTo ?? currentPath()));
  return true;
}

/** Leave the app for the sign-in screen without a return target (sign-out). */
export function goToSignIn(): void {
  if (typeof window === "undefined") return;
  redirecting = true;
  navigation.assign(SIGN_IN_PATH);
}

/** Test-only: clear the once-per-page-load flag. */
export function resetSignInRedirect(): void {
  redirecting = false;
}
