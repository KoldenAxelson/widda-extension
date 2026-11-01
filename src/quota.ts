// YouTube quota protection for every code path that calls the YouTube Data API
// (sign-in sync, manual Refresh, the periodic alarm and the retry alarm).
//
// Our daily quota is shared by all installs, so once it's gone every extra call is wasted and
// every install should wait for the reset. Three layers:
//   1. Server breaker — GET /status `youtube_paused_until` (tripped by the API on a quota error,
//      or manually with `make youtube:pause`). Checked before each sync.
//   2. Local backoff — after a quota error this install waits until midnight Pacific plus a
//      random delay (spreads the post-reset load), then retries once via an alarm.
//   3. Manual-refresh cooldown — Refresh is a no-op if we synced in the last few minutes.
// Saved creators and the cached promo map are never touched, so checkout keeps working.
import { fetchStatus } from "./api.js";
import { QuotaError } from "./google.js";
import {
  ERROR_RETRY_MINUTES,
  MANUAL_REFRESH_COOLDOWN_MINUTES,
  RESET_JITTER_MINUTES,
  SYNC_RETRY_ALARM,
} from "./config.js";
import type { LocalStore } from "./types.js";

const MINUTE = 60_000;

/** Thrown when a manual Refresh arrives inside the cooldown window. Not an error for the user. */
export class CooldownError extends Error {
  constructor(public readonly nextAllowedAt: Date) {
    super("refresh cooldown");
    this.name = "CooldownError";
  }
}

/** The next midnight in America/Los_Angeles after `now` (when YouTube's daily quota resets). */
export function nextPacificMidnight(now: Date): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const sinceMidnight =
    ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  // Off by an hour on the two DST-change days; the jitter window absorbs that.
  return new Date(now.getTime() - sinceMidnight + 24 * 60 * MINUTE);
}

/** When to retry after a quota error: after the reset, at a random point in the jitter window. */
export function quotaRetryAt(resetAt: Date, random: () => number = Math.random): Date {
  return new Date(resetAt.getTime() + Math.floor(random() * RESET_JITTER_MINUTES * MINUTE));
}

/**
 * Throws QuotaError (without calling YouTube) if this install is backing off or the server
 * breaker is open. Call before every subscription sync.
 */
export async function assertYouTubeAllowed(now = new Date()): Promise<void> {
  const { sync_status } = (await chrome.storage.local.get("sync_status")) as LocalStore;
  if (sync_status?.state === "quota" && new Date(sync_status.retry_at) > now) {
    throw new QuotaError();
  }
  const { youtubePausedUntil } = await fetchStatus();
  if (youtubePausedUntil && new Date(youtubePausedUntil) > now) {
    await markSyncFailed("quota", new Date(youtubePausedUntil));
    throw new QuotaError();
  }
}

/** Throws CooldownError if a manual Refresh comes too soon after the last successful sync. */
export async function assertManualRefreshAllowed(now = new Date()): Promise<void> {
  const { last_sync_at } = (await chrome.storage.local.get("last_sync_at")) as LocalStore;
  if (!last_sync_at) return;
  const next = new Date(new Date(last_sync_at).getTime() + MANUAL_REFRESH_COOLDOWN_MINUTES * MINUTE);
  if (next > now) throw new CooldownError(next);
}

/** Records a failed sync for the popup and schedules one retry alarm. */
export async function markSyncFailed(state: "quota" | "error", resetAt?: Date): Promise<void> {
  const now = new Date();
  const retryAt =
    state === "quota"
      ? quotaRetryAt(resetAt && resetAt > now ? resetAt : nextPacificMidnight(now))
      : new Date(now.getTime() + ERROR_RETRY_MINUTES * MINUTE);
  const update: LocalStore = {
    sync_status: { state, at: now.toISOString(), retry_at: retryAt.toISOString() },
  };
  await chrome.storage.local.set(update);
  chrome.alarms.create(SYNC_RETRY_ALARM, { when: retryAt.getTime() });
}

/** Clears any failure state after a successful sync. */
export async function markSyncSucceeded(): Promise<void> {
  await chrome.storage.local.remove("sync_status");
  await chrome.storage.local.set({ last_sync_at: new Date().toISOString() });
  await chrome.alarms.clear(SYNC_RETRY_ALARM);
}
