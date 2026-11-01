// Background service worker: OAuth, subscription sync, promo-map cache refresh,
// privileged cookie injection, and the periodic sync alarm.
// See docs/extension-architecture.md.
import { authGoogle, deleteAccount, fetchPromoMap, fetchSites, logEvent, syncSubscriptions, type MatchedCreator } from "./api.js";
import { signIn, fetchSubscriptionChannelIds, QuotaError } from "./google.js";
import { SYNC_ALARM, SYNC_PERIOD_MINUTES, SYNC_RETRY_ALARM } from "./config.js";
import {
  assertManualRefreshAllowed,
  assertYouTubeAllowed,
  CooldownError,
  markSyncFailed,
  markSyncSucceeded,
} from "./quota.js";
import { applyAffiliate } from "./adapters.js";
import type { EventKind, LocalStore, PromoType, RankedCreator, SiteConfig, SyncStore } from "./types.js";

// ---- lifecycle ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  void refreshSites();
  void refreshPromoMap();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshSites();
  void refreshPromoMap();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM || alarm.name === SYNC_RETRY_ALARM) void periodicSync();
});

// ---- message routing ----

type Message =
  | { kind: "signin" }
  | { kind: "refresh_subscriptions" }
  | { kind: "delete_account" }
  | { kind: "apply_affiliate"; domain: string; url: string; pageUrl: string }
  | { kind: "log_event"; creatorId: string; domain: string; type: PromoType; eventKind: EventKind; skipped: string[] }
  | { kind: "dev_load_session"; token: string; userId: string; ranked: RankedCreator[] };

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.kind) {
        case "signin":
          await doSignIn();
          sendResponse({ ok: true });
          break;
        case "refresh_subscriptions":
          try {
            await doRefreshSubscriptions(true, true);
            sendResponse({ ok: true });
          } catch (err) {
            if (!(err instanceof CooldownError)) throw err;
            // Synced moments ago: nothing new to fetch, and no quota spent.
            sendResponse({ ok: true, cooldown_until: err.nextAllowedAt.toISOString() });
          }
          break;
        case "delete_account":
          // Server first (scrubs subscriptions, sessions, identifiers), then everything local.
          await deleteAccount();
          await chrome.storage.sync.clear();
          await chrome.storage.local.clear();
          await chrome.alarms.clear(SYNC_RETRY_ALARM);
          await refreshSites(); // public site config, not personal data
          sendResponse({ ok: true });
          break;
        case "apply_affiliate": {
          const result = await runAffiliateAdapter(msg.domain, msg.url, msg.pageUrl);
          sendResponse({ ok: true, ...result });
          break;
        }
        case "log_event": {
          // Content scripts route event logging here so the request is made from the
          // extension origin (MV3 content-script fetches are bound by the page's CORS).
          const result = await logEvent(msg.creatorId, msg.domain, msg.type, msg.eventKind, msg.skipped);
          sendResponse(result);
          break;
        }
        case "dev_load_session":
          if (__DEV__) {
            await devLoadSession(msg.token, msg.userId, msg.ranked);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false });
          }
          break;
      }
    } catch (err) {
      console.warn("[Widda] message handler failed", err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});

// ---- flows ----

async function doSignIn(): Promise<void> {
  const { idToken, accessToken } = await signIn(true);
  const auth = await authGoogle(idToken);

  const store: SyncStore["user"] = {
    google_id: "", // server-side identity is authoritative; we keep the token + id
    widda_user_id: auth.user_id,
    widda_token: auth.widda_token,
  };
  await chrome.storage.sync.set({ user: store });

  // Signing in succeeds even if YouTube's quota is used up: the session is stored, the
  // popup explains the delay, and the sync retries on its own.
  try {
    await syncFromAccessToken(accessToken);
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
  }
  await refreshPromoMap();
}

// doRefreshSubscriptions is the manual Refresh button (manual=true) and the periodic/retry
// alarms (manual=false). Quota guards run first, so a blocked refresh never opens a Google
// window or spends a YouTube call.
async function doRefreshSubscriptions(interactive: boolean, manual = false): Promise<void> {
  if (manual) await assertManualRefreshAllowed();
  await assertYouTubeAllowed();
  const { accessToken } = await signIn(interactive);
  await syncFromAccessToken(accessToken, { guarded: true });
  await refreshPromoMap();
}

// Only one sync runs at a time; a second request (double-click, alarm during sign-in) joins it.
let syncInFlight: Promise<void> | null = null;

// syncFromAccessToken pulls subscriptions and applies the server's deltas so the ranked
// list mirrors YouTube: unsubscribed creators are dropped, new matches appended at the
// bottom. Existing order is preserved either way.
function syncFromAccessToken(accessToken: string, opts: { guarded?: boolean } = {}): Promise<void> {
  if (!syncInFlight) {
    syncInFlight = (async () => {
      if (!opts.guarded) await assertYouTubeAllowed();
      try {
        const channelIds = await fetchSubscriptionChannelIds(accessToken);
        if (channelIds.length > 0) {
          const { matched, removedCreatorIds } = await syncSubscriptions(channelIds);
          await applyRankingDeltas(matched, removedCreatorIds);
        }
      } catch (err) {
        await markSyncFailed(err instanceof QuotaError ? "quota" : "error");
        throw err;
      }
      await markSyncSucceeded();
    })().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

async function applyRankingDeltas(matches: MatchedCreator[], removedCreatorIds: string[]): Promise<void> {
  if (matches.length === 0 && removedCreatorIds.length === 0) return;
  const { ranked_creators = [] } = (await chrome.storage.sync.get("ranked_creators")) as SyncStore;

  const removed = new Set(removedCreatorIds);
  const kept = ranked_creators.filter((c) => !removed.has(c.creator_id));
  const existing = new Set(kept.map((c) => c.creator_id));
  const additions = matches
    .filter((m) => !existing.has(m.creator_id))
    .map((m) => ({ creator_id: m.creator_id, channel_id: m.channel_id, name: m.name }));

  // Re-rank contiguously (1..n) so ranks stay dense after removals.
  const next: RankedCreator[] = [...kept, ...additions].map((c, i) => ({ ...c, rank: i + 1 }));
  await chrome.storage.sync.set({ ranked_creators: next });
}

async function refreshPromoMap(): Promise<void> {
  const { user } = (await chrome.storage.sync.get("user")) as SyncStore;
  if (!user?.widda_token) return; // not signed in yet
  try {
    const { map, generated_at } = await fetchPromoMap();
    const update: LocalStore = { promo_map: map, promo_map_fetched_at: generated_at };
    await chrome.storage.local.set(update);
  } catch (err) {
    console.warn("[Widda] promo map refresh failed", err);
  }
}

// refreshSites caches the public per-site adapter config (checkout rules + network params)
// used by checkout detection and the affiliate adapters. No auth required.
async function refreshSites(): Promise<void> {
  try {
    const sites = await fetchSites();
    const map: Record<string, SiteConfig> = {};
    for (const s of sites) map[s.domain] = s;
    await chrome.storage.local.set({ sites: map });
  } catch (err) {
    console.warn("[Widda] sites refresh failed", err);
  }
}

// devLoadSession injects a synthetic viewer's Widda session + rankings directly into
// storage, bypassing Google sign-in — for the admin checkout simulator only. Guarded by
// __DEV__ and reached only from the dev_load_session case, so it is stripped from prod.
async function devLoadSession(token: string, userId: string, ranked: RankedCreator[]): Promise<void> {
  await chrome.storage.sync.set({
    user: { google_id: "", widda_user_id: userId, widda_token: token },
    ranked_creators: ranked,
  });
  await refreshSites();
  await refreshPromoMap();
}

async function periodicSync(): Promise<void> {
  const { user } = (await chrome.storage.sync.get("user")) as SyncStore;
  if (!user?.widda_token) return;
  try {
    // Silent (non-interactive) refresh; if Google needs consent this no-ops
    // and the user can refresh manually from the popup.
    await doRefreshSubscriptions(false);
  } catch (err) {
    console.warn("[Widda] periodic sync skipped", err);
    // Quota paths already scheduled their own retry. Anything else (e.g. Google needs the user
    // to re-consent) retries daily so data never goes past YouTube's 30-day refresh limit.
    if (!(err instanceof QuotaError)) await markSyncFailed("error");
  }
}

// ---- affiliate application (adapter registry) ----
//
// Looks up the cached per-site config and runs the matching network adapter (non-destructive;
// see src/adapters.ts). Returns whether attribution was applied, or whether an existing cookie
// made us stand down (→ the content script logs `blocked_existing_cookie` instead of `activated`).
async function runAffiliateAdapter(
  domain: string,
  affiliateUrl: string,
  pageUrl: string,
): Promise<{ applied: boolean; blocked: boolean }> {
  const { sites = {} } = (await chrome.storage.local.get("sites")) as LocalStore;
  const config: SiteConfig = sites[domain] ?? { domain, checkout: {}, affiliate: {} };
  return applyAffiliate({ affiliateUrl, pageUrl, domain, config });
}
