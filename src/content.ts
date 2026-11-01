// Content script: runs the priority-queue walk on supported domains and renders
// the promo UI. Ported from docs/extension-architecture.md / docs/business-logic.md.
import type { EventKind, LocalStore, PromoEntry, RankedCreator, SyncStore } from "./types.js";
import type { LogEventResult } from "./api.js";
import { isCheckout } from "./checkout.js";
import { showPromoBanner, showToast } from "./ui.js";

const DAY_MS = 86_400_000; // 24h

// In the dev checkout simulator, the page declares which merchant it stands in for via
// <meta name="widda-sim-domain">. Production ignores it: __DEV__ is false, so this always
// returns undefined and the meta lookup is stripped from the bundle.
function simDomain(): string | undefined {
  if (!__DEV__) return undefined;
  const meta = document.querySelector('meta[name="widda-sim-domain"]');
  return meta?.getAttribute("content")?.trim() || undefined;
}

// Supported sites are keyed by registrable domain (sites.domain), but checkouts often live on
// a subdomain (account.squarespace.com, secure.example.com) and the manifest matches *.domain.
// Walk up the host labels until one matches a key we know.
function resolveSiteDomain(hostname: string, known: Iterable<string>): string | undefined {
  const keys = new Set(known);
  const labels = hostname.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (keys.has(candidate)) return candidate;
  }
  return undefined;
}

async function handleSiteVisit(hostname: string): Promise<void> {
  const { promo_map = {}, dismissed = {}, sites = {} } = (await chrome.storage.local.get([
    "promo_map",
    "dismissed",
    "sites",
  ])) as LocalStore;
  const { ranked_creators = [] } = (await chrome.storage.sync.get("ranked_creators")) as SyncStore;

  const domain = resolveSiteDomain(hostname, [...Object.keys(promo_map), ...Object.keys(sites)]);
  if (!domain) return; // site not supported
  const sitePromos = promo_map[domain];
  if (!sitePromos) return; // supported, but none of this user's creators cover it

  // Only offer at checkout (generic, config-driven). With no rules, isCheckout returns true and
  // we offer anywhere. The dev simulator page IS the checkout, so it bypasses detection.
  const siteConfig = sites[domain];
  if (!simDomain() && siteConfig && !isCheckout(siteConfig.checkout, location, document)) return;

  // Walk in rank order: collect the creators we pass over (followed, no promo here) and
  // stop at the first with a promo — the winner. The skipped list is the "missed
  // opportunity" metric; the server records it but never bills it.
  const ordered = [...ranked_creators].sort((a, b) => a.rank - b.rank);
  const skipped: string[] = [];
  let winner: RankedCreator | undefined;
  let match: PromoEntry | undefined;
  for (const creator of ordered) {
    const m = sitePromos.find((p) => p.creator_id === creator.creator_id);
    if (!m) {
      skipped.push(creator.creator_id);
      continue;
    }
    winner = creator;
    match = m;
    break;
  }
  if (!winner || !match) return; // none of the user's creators cover this site

  // Respect an explicit dismissal (user silenced this site for 24h).
  if (recentlyDismissed(dismissed[domain])) return;

  const w = winner;
  const m = match;
  // Show the offer. Nothing is applied or billed until the user acts (CWS user-action gating);
  // the billable event fires from onApply, never from merely showing this banner.
  showPromoBanner({
    creatorName: w.name,
    code: m.type === "promo_code" ? m.value : undefined,
    affiliate: true,
    onApply: () => void applySupport(domain, w, m, skipped),
    onDismiss: () => void persistDismiss(domain),
  });
}

// applySupport runs on the user's explicit "Apply". For affiliate links it runs the network
// adapter in the worker; if an existing attribution cookie is present the adapter stands down
// (non-destructive) and we log `blocked_existing_cookie` (a metric) instead of `activated`.
// Promo codes are copied by the banner itself. Either way we log the event with the skipped list
// and thank the user based on the server's billing decision.
async function applySupport(
  domain: string,
  creator: RankedCreator,
  match: PromoEntry,
  skipped: string[],
): Promise<void> {
  let kind: EventKind = "activated";
  if (match.type === "affiliate_link") {
    try {
      const resp = (await chrome.runtime.sendMessage({
        kind: "apply_affiliate",
        domain,
        url: match.value,
        pageUrl: location.href,
      })) as { blocked?: boolean } | undefined;
      if (resp?.blocked) kind = "blocked_existing_cookie";
    } catch (err) {
      console.warn("[Widda] apply affiliate failed", err);
    }
  }

  try {
    // Route through the background worker: MV3 content scripts are bound by the page's
    // CORS, so a direct fetch to the API from a merchant page would be blocked. The worker
    // makes the request from the extension origin (which the API allows).
    const res = (await chrome.runtime.sendMessage({
      kind: "log_event",
      creatorId: creator.creator_id,
      domain,
      type: match.type,
      eventKind: kind,
      skipped,
    })) as LogEventResult;
    if (res.billed) {
      showToast(`Thank you for supporting ${creator.name}`);
    } else if (kind === "blocked_existing_cookie") {
      showToast(`Another referral is already active — we didn't override it`);
    } else if (res.reason === "cooldown") {
      showToast(`Already counted today — thanks for supporting ${creator.name}`);
    }
  } catch (err) {
    console.warn("[Widda] log event failed", err);
  }
}

function recentlyDismissed(iso: string | undefined): boolean {
  return !!iso && Date.now() - new Date(iso).getTime() < DAY_MS;
}

async function persistDismiss(domain: string): Promise<void> {
  const { dismissed = {} } = (await chrome.storage.local.get("dismissed")) as LocalStore;
  dismissed[domain] = new Date().toISOString();
  await chrome.storage.local.set({ dismissed });
}


void handleSiteVisit(simDomain() ?? location.hostname);
