// Thin client for the Widda API. See docs/api-surface.md.
import { API_BASE } from "./config.js";
import type { EventKind, PromoMap, PromoType, SiteConfig } from "./types.js";

export interface AuthResponse {
  widda_token: string;
  account_type: "creator" | "user";
  user_id: string;
}

export interface MatchedCreator {
  creator_id: string;
  channel_id: string;
  name: string;
}

async function authToken(): Promise<string | undefined> {
  const { user } = await chrome.storage.sync.get("user");
  return user?.widda_token;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await authToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

/** POST /auth/google — exchange a Google ID token for a Widda session. */
export async function authGoogle(googleIdToken: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ google_id_token: googleIdToken, account_type: "user" }),
  });
  if (!res.ok) throw new Error(`auth failed: ${res.status}`);
  return res.json() as Promise<AuthResponse>;
}

export interface SyncResult {
  matched: MatchedCreator[]; // newly matched creators (append at the bottom)
  removedCreatorIds: string[]; // no longer subscribed (drop from the ranking)
}

/** POST /users/sync-subscriptions — the deltas that make the ranked list mirror YouTube. */
export async function syncSubscriptions(channelIds: string[]): Promise<SyncResult> {
  const res = await authedFetch("/users/sync-subscriptions", {
    method: "POST",
    body: JSON.stringify({ channel_ids: channelIds }),
  });
  if (!res.ok) throw new Error(`sync failed: ${res.status}`);
  const body = (await res.json()) as { matched_creators: MatchedCreator[]; removed_creator_ids?: string[] };
  return { matched: body.matched_creators, removedCreatorIds: body.removed_creator_ids ?? [] };
}

/** DELETE /users/me — scrubs this viewer's Widda data server-side. */
export async function deleteAccount(): Promise<void> {
  const res = await authedFetch("/users/me", { method: "DELETE" });
  if (!res.ok && res.status !== 401) throw new Error(`delete failed: ${res.status}`);
}

/** GET /promo-map — domain→promos for the user's matched creators. */
export async function fetchPromoMap(): Promise<{ map: PromoMap; generated_at: string }> {
  const res = await authedFetch("/promo-map");
  if (!res.ok) throw new Error(`promo-map failed: ${res.status}`);
  return res.json() as Promise<{ map: PromoMap; generated_at: string }>;
}

export interface ServiceStatus {
  /** Operator notice shown in the popup, or null. */
  notice: string | null;
  /** Don't call the YouTube Data API before this ISO time (project-wide breaker), or null. */
  youtubePausedUntil: string | null;
}

/** GET /status. Never throws: if our API is unreachable, report "no notice, not paused". */
export async function fetchStatus(): Promise<ServiceStatus> {
  try {
    const res = await fetch(`${API_BASE}/status`, { cache: "no-store" });
    if (!res.ok) return { notice: null, youtubePausedUntil: null };
    const body = (await res.json()) as { notice?: string | null; youtube_paused_until?: string | null };
    return { notice: body.notice || null, youtubePausedUntil: body.youtube_paused_until || null };
  } catch {
    return { notice: null, youtubePausedUntil: null };
  }
}

/** GET /sites — public per-site adapter config (checkout rules + network params). */
export async function fetchSites(): Promise<SiteConfig[]> {
  const res = await fetch(`${API_BASE}/sites`);
  if (!res.ok) throw new Error(`sites failed: ${res.status}`);
  const body = (await res.json()) as { sites: SiteConfig[] };
  return body.sites ?? [];
}

export interface LogEventResult {
  logged: boolean;
  billed: boolean;
  reason?: string;
}

/**
 * POST /events — the server decides billability (activated + real promo + cooldown).
 * @param kind             activated (billable) | shown_not_activated | blocked_existing_cookie
 * @param skippedCreators  higher-ranked creators walked past for lacking a promo here (metric)
 */
export async function logEvent(
  creatorId: string,
  siteDomain: string,
  type: PromoType,
  kind: EventKind,
  skippedCreators: string[],
): Promise<LogEventResult> {
  const res = await authedFetch("/events", {
    method: "POST",
    body: JSON.stringify({
      creator_id: creatorId,
      site_domain: siteDomain,
      type,
      kind,
      skipped_creators: skippedCreators,
    }),
  });
  return res.json() as Promise<LogEventResult>;
}
