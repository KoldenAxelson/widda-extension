// Shared types for the Widda extension.
// Mirrors docs/extension-architecture.md storage shapes and docs/api-surface.md.

export type PromoType = "promo_code" | "affiliate_link";

/** Event outcome sent to POST /events (mirrors events.kind server-side). */
export type EventKind = "activated" | "shown_not_activated" | "blocked_existing_cookie";

export interface RankedCreator {
  creator_id: string;
  channel_id: string;
  name: string;
  rank: number; // lower = higher priority
}

export interface PromoEntry {
  creator_id: string;
  type: PromoType;
  value: string; // code string or full affiliate URL
}

/** domain -> list of promos. Cached in chrome.storage.local. */
export type PromoMap = Record<string, PromoEntry[]>;

/** Generic checkout-detection rules (any match ⇒ at checkout). */
export interface CheckoutConfig {
  url_patterns?: string[];
  selectors?: string[];
}

/** Per-site adapter config from GET /sites, cached in chrome.storage.local. */
export interface SiteConfig {
  id?: string;
  domain: string;
  name?: string;
  network_key?: string | null; // which network adapter; null = promo-code-only
  checkout: CheckoutConfig;
  affiliate: Record<string, unknown>;
}

/** chrome.storage.sync shape. */
export interface SyncStore {
  user?: {
    google_id: string;
    widda_user_id: string;
    widda_token: string;
  };
  ranked_creators?: RankedCreator[];
}

/** chrome.storage.local shape. */
export interface LocalStore {
  promo_map?: PromoMap;
  promo_map_fetched_at?: string;
  /** domain -> per-site adapter config (from GET /sites). */
  sites?: Record<string, SiteConfig>;
  /** domain -> ISO timestamp the user last dismissed the banner. */
  dismissed?: Record<string, string>;
  /** Set when the last subscription sync failed; cleared on success. Drives the popup notice. */
  sync_status?: { state: "quota" | "error"; at: string; retry_at: string };
  /** ISO timestamp of the last successful subscription sync (manual-refresh cooldown). */
  last_sync_at?: string;
}
