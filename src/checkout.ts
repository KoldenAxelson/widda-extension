// Generic, data-driven checkout detection — no per-merchant code.
// Rules come from the site's `checkout` config (docs/affiliate-adapters.md); a match on any
// url_pattern or selector means we're at checkout. Pure (no chrome.*), so it's unit- and
// preview-testable.
import type { CheckoutConfig } from "./types.js";

// globToRegExp turns a shell-style glob ("*/checkout*") into a RegExp, escaping regex
// metacharacters and treating only "*" as a wildcard.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped);
}

/**
 * isCheckout reports whether the current page looks like a checkout for this site.
 * With no rules configured we can't gate, so we allow (return true) rather than hide a promo.
 */
export function isCheckout(cfg: CheckoutConfig, loc: Location, doc: Document): boolean {
  const patterns = cfg.url_patterns ?? [];
  const selectors = cfg.selectors ?? [];
  if (patterns.length === 0 && selectors.length === 0) return true;

  for (const p of patterns) {
    if (globToRegExp(p).test(loc.href)) return true;
  }
  for (const sel of selectors) {
    try {
      if (doc.querySelector(sel)) return true;
    } catch {
      // ignore malformed selectors from config
    }
  }
  return false;
}
