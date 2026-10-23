/**
 * Signing in, for a host that has someone to sign in (`VIEW-24`).
 *
 * The same viewer runs in places that differ in exactly this:
 *
 * - **`yarn viewer`**, the Vite dev server, which serves the store from the repo's own file.
 * - **The loopback host**, opened by `open_viewer`, where reaching the port means already being on the machine.
 * - **A hosted server**, where `/api/store` is a whole account's plans and sits behind the same credential as
 *   the tools.
 *
 * The first two have nobody to sign in, and they are the only two this package serves. So the viewer knows
 * the *shape* of a session and nothing about any identity provider: a host that has accounts passes a
 * `SessionProvider` to `mountViewer`, and without one the session is `local` and requests go out bare.
 *
 * The credential is a bearer token, sent as `Authorization: Bearer`. There are no cookies and so no CSRF
 * machinery, which is most of why the hosted viewer stayed small - see `VIEW-20`.
 */

export type Session =
  /** Nothing to sign in to: the dev server or the loopback host. Requests go out bare. */
  | { mode: "local" }
  /** Hosted, and nobody is signed in. `signIn` starts the provider's flow; `signInLabel` is its button. */
  | { mode: "anonymous"; signIn: () => void; signInLabel: string }
  /** Hosted and signed in. `email` is shown so a person can tell which account they are looking at. */
  | { mode: "signed-in"; email: string; signOut: () => Promise<void> };

/**
 * How a host signs people in. `start` works out the current session and reports every later one through
 * `onChange` - a sign-in completing after a redirect, a token refresh, a sign-out in another tab - so the
 * shell re-renders rather than holding a stale answer. It keeps `setAccessToken` in step as it goes.
 */
export interface SessionProvider {
  start(onChange: (session: Session) => void): Promise<Session>;
}

/**
 * The current access token, or null when there is nothing to send.
 *
 * Module state rather than something threaded through every caller, because the alternative is passing a
 * token into each of `store.ts`'s fetches and their callers up the tree. The provider owns it; this module
 * only carries it to the requests.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Headers for a request to the server, empty when there is no session to prove. */
export const authHeaders = (): Record<string, string> =>
  accessToken === null ? {} : { authorization: `Bearer ${accessToken}` };

/** The session under `provider`, or `local` when this host has none. */
export function startSession(provider: SessionProvider | undefined, onChange: (session: Session) => void): Promise<Session> {
  return provider === undefined ? Promise.resolve({ mode: "local" }) : provider.start(onChange);
}
