// Google OAuth (implicit flow via chrome.identity) and YouTube Data API access.
//
// We use launchWebAuthFlow rather than getAuthToken because we need BOTH:
//   - an ID token (id_token) to authenticate to the Widda API (/auth/google)
//   - an access token (access_token) to call YouTube subscriptions.list
// The implicit flow ("token id_token") returns both in the redirect fragment.
import { GOOGLE_CLIENT_ID, OAUTH_SCOPES } from "./config.js";

export interface GoogleTokens {
  idToken: string;
  accessToken: string;
}

// randomNonce returns a URL-safe random string for the OIDC nonce.
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * signIn runs Google's implicit OAuth flow and returns the ID + access tokens.
 * @param interactive whether Chrome may show UI (true for explicit sign-in).
 */
export async function signIn(interactive: boolean): Promise<GoogleTokens> {
  const redirectUri = chrome.identity.getRedirectURL();
  const nonce = randomNonce();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "token id_token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("prompt", interactive ? "consent" : "none");

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive,
  });
  if (!redirect) {
    throw new Error("sign-in cancelled");
  }

  // Tokens come back in the URL fragment: #access_token=...&id_token=...
  const fragment = new URL(redirect).hash.slice(1);
  const params = new URLSearchParams(fragment);
  const idToken = params.get("id_token");
  const accessToken = params.get("access_token");
  if (!idToken || !accessToken) {
    throw new Error("missing tokens in OAuth response");
  }
  return { idToken, accessToken };
}

/**
 * fetchSubscriptionChannelIds pages through the user's YouTube subscriptions
 * and returns the subscribed channel ids.
 */
/** YouTube rejected the call because Widda's API quota (or a rate limit) is used up. */
export class QuotaError extends Error {
  constructor() {
    super("youtube quota exceeded");
    this.name = "QuotaError";
  }
}

const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]);

async function isQuotaResponse(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  try {
    const body = (await res.json()) as { error?: { errors?: Array<{ reason?: string }> } };
    return (body.error?.errors ?? []).some((e) => QUOTA_REASONS.has(e.reason ?? ""));
  } catch {
    return false;
  }
}

export async function fetchSubscriptionChannelIds(accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      if (await isQuotaResponse(res)) throw new QuotaError();
      throw new Error(`subscriptions.list failed: ${res.status}`);
    }
    const body = (await res.json()) as {
      items?: Array<{ snippet?: { resourceId?: { channelId?: string } } }>;
      nextPageToken?: string;
    };

    for (const item of body.items ?? []) {
      const channelId = item.snippet?.resourceId?.channelId;
      if (channelId) ids.push(channelId);
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  return ids;
}
