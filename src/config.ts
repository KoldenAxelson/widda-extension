// Extension configuration.
//
// For local development against a dev API, change API_BASE to http://localhost:8080.
// GOOGLE_CLIENT_ID comes from the Google Cloud Console (see ROADMAP Phase G) and must
// match an OAuth client authorized for chrome.identity redirect URIs.

export const API_BASE = "https://api.widda.club";

export const GOOGLE_CLIENT_ID = "787902971134-46ulghq8gqsk1c2satbk9tikuhalee63.apps.googleusercontent.com";

// OIDC + YouTube read scope. openid+email yield an ID token; youtube.readonly
// yields an access token that can call subscriptions.list.
export const OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/youtube.readonly",
];

// How often to auto-refresh subscriptions and the promo map.
export const SYNC_ALARM = "widda-monthly-sync";
// One-shot retry after a failed sync. Quota errors retry sooner (YouTube's daily quota
// resets at midnight Pacific); other failures retry daily so data never goes >30 days stale.
export const SYNC_RETRY_ALARM = "widda-sync-retry";
export const ERROR_RETRY_MINUTES = 60 * 24;
// After a quota error every install waits for the daily reset (midnight Pacific), then retries
// at a random point in this window so thousands of extensions don't all sync at 12:00:00.
export const RESET_JITTER_MINUTES = 60 * 4;
// Manual Refresh is ignored if the last successful sync was this recent (button-mashing guard).
export const MANUAL_REFRESH_COOLDOWN_MINUTES = 10;
export const SYNC_PERIOD_MINUTES = 60 * 24 * 25; // every 25 days — keeps YouTube data inside the 30-day refresh limit (YouTube Developer Policies III.E.4)
