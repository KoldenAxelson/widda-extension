// Affiliate network adapters (background worker — needs `cookies`).
//
// One small registry keyed by network_key; most sites use the default `visit` adapter, so
// adding a merchant on an existing network is data, not code (docs/affiliate-adapters.md).
//
// HARD RULE — non-destructive: an adapter NEVER overwrites an existing affiliate cookie/param.
// If attribution is already present, it stands down and reports `blocked` (we don't strip a
// competitor's cookie — attribution belongs to whoever earned it). Adapters run only from the banner's Apply
// click; nothing here fires on its own.
import type { SiteConfig } from "./types.js";

export interface AffiliateContext {
  affiliateUrl: string; // the creator's affiliate link (creator_promos.value)
  pageUrl: string; // the merchant page the user is on
  domain: string;
  config: SiteConfig;
}

export interface AffiliateResult {
  applied: boolean;
  blocked: boolean; // existing attribution present → we stood down (non-destructive)
}

type Adapter = (ctx: AffiliateContext) => Promise<AffiliateResult>;

// visit (default): fetch the tracking link so the network sets its own cookies. If the
// network's `existing_cookie` is already present, stand down.
const visit: Adapter = async (ctx) => {
  const existing = strParam(ctx.config.affiliate, "existing_cookie");
  if (existing && (await cookieExists(ctx.affiliateUrl, existing))) {
    return { applied: false, blocked: true };
  }
  await safeVisit(ctx.affiliateUrl);
  return { applied: true, blocked: false };
};

// cookie (direct): set a first-party attribution cookie from config — only if absent.
const cookie: Adapter = async (ctx) => {
  const name = strParam(ctx.config.affiliate, "cookie_name");
  if (!name) return { applied: false, blocked: false };
  if (await cookieExists(ctx.affiliateUrl, name)) return { applied: false, blocked: true };

  const valueParam = strParam(ctx.config.affiliate, "value_param");
  const value = valueParam ? new URL(ctx.affiliateUrl).searchParams.get(valueParam) ?? "" : "";
  if (!value) return { applied: false, blocked: false };

  const ttlDays = numParam(ctx.config.affiliate, "ttl_days") ?? 30;
  await chrome.cookies.set({
    url: ctx.affiliateUrl,
    name,
    value,
    path: strParam(ctx.config.affiliate, "path") ?? "/",
    expirationDate: Date.now() / 1000 + ttlDays * 86_400,
  });
  return { applied: true, blocked: false };
};

// param (e.g. Amazon `tag`): attribution rides a URL parameter. If the current page URL
// already carries the param, someone else's attribution is active → stand down. Otherwise
// visit the tagged affiliate link so the program sets its cookie.
const param: Adapter = async (ctx) => {
  const name = strParam(ctx.config.affiliate, "param_name");
  if (name) {
    try {
      if (new URL(ctx.pageUrl).searchParams.get(name)) return { applied: false, blocked: true };
    } catch {
      // ignore an unparseable page URL
    }
  }
  await safeVisit(ctx.affiliateUrl);
  return { applied: true, blocked: false };
};

// network_key → adapter. Unknown networks fall back to `visit`.
const registry: Record<string, Adapter> = {
  impact: visit,
  cj: visit,
  rakuten: visit,
  awin: visit,
  amazon: param,
  direct: cookie,
};

export async function applyAffiliate(ctx: AffiliateContext): Promise<AffiliateResult> {
  const adapter = registry[ctx.config.network_key ?? ""] ?? visit;
  try {
    return await adapter(ctx);
  } catch (err) {
    console.warn("[Widda] affiliate adapter failed", ctx.config.network_key, err);
    return { applied: false, blocked: false };
  }
}

// ---- helpers ----

// safeVisit fetches an https tracking link with the user's credentials so the network can set
// its cookie. Non-https or malformed URLs are refused (defense-in-depth; the server validates too).
async function safeVisit(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn("[Widda] ignoring malformed affiliate url", url);
    return;
  }
  if (parsed.protocol !== "https:") {
    console.warn("[Widda] refusing non-https affiliate url", url);
    return;
  }
  try {
    await fetch(url, { credentials: "include", mode: "no-cors", redirect: "follow" });
  } catch (err) {
    console.warn("[Widda] affiliate visit failed", err);
  }
}

async function cookieExists(url: string, name: string): Promise<boolean> {
  try {
    const c = await chrome.cookies.get({ url, name });
    return !!c && !!c.value;
  } catch {
    return false;
  }
}

function strParam(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function numParam(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}
