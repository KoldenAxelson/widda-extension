// Content-script UI: the promo banner and the "thank you" toast.
//
// Pure DOM, no chrome.* dependency — so it can be previewed in a plain browser
// (see extension/preview/). Persistence/decisions live in the content script,
// which passes an onDismiss callback.

const BANNER_ID = "widda-banner";

// Shared visual tokens (mirrors popup.css so the banner and popup read as one product).
const FONT = `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const C = {
  fg: "#18181b",
  muted: "#71717a",
  faint: "#a1a1aa",
  line: "#e4e4e7",
  surface: "#fafafa",
  accent: "#18181b",
  accentHover: "#27272a",
  ok: "#059669",
};
// The brand mark: Fredoka Bold "W", white on YouTube red, baked to a path so no font loads on merchant pages.
const MARK_SVG =
  `<svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#FF0000"/><path d="M11.77 24.13Q11.04 24.13 10.62 23.83Q10.21 23.53 10.02 23.17Q9.84 22.81 9.79 22.7L5.64 10.81Q5.3 9.65 5.54 9.09Q5.78 8.52 6.98 8.13Q7.76 7.88 8.25 7.9Q8.73 7.92 9.05 8.29Q9.38 8.66 9.63 9.45L12.03 16.45L13.92 9.56Q13.99 9.33 14.16 8.96Q14.33 8.59 14.75 8.31Q15.16 8.02 15.95 8.02Q16.82 8.02 17.25 8.34Q17.67 8.66 17.84 9.03Q18 9.4 18.07 9.58L19.96 16.5L22.35 9.45Q22.61 8.69 22.92 8.31Q23.23 7.92 23.74 7.88Q24.24 7.83 25.03 8.11Q25.86 8.41 26.2 8.74Q26.55 9.08 26.56 9.56Q26.57 10.05 26.34 10.81L22.21 22.7Q22.17 22.84 22 23.18Q21.82 23.53 21.41 23.83Q20.99 24.13 20.21 24.13Q19.43 24.13 18.99 23.77Q18.55 23.41 18.37 23.03Q18.18 22.65 18.16 22.58L15.99 15.48L13.83 22.56Q13.8 22.68 13.62 23.06Q13.43 23.44 13.01 23.78Q12.58 24.13 11.77 24.13Z" fill="#ffffff"/></svg>`;
const CHECK_SVG =
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M3 8.5l3 3 7-7"/></svg>`;

export interface BannerOptions {
  creatorName: string;
  code?: string; // present for a promo_code; omit for an affiliate_link
  affiliate?: boolean; // show the affiliate-program disclosure line (CWS Affiliate Ads policy)
  onApply?: () => void; // the user's explicit action — the billable trigger (CWS user-action gating)
  onDismiss?: () => void;
}

/** Show the support banner. No-op if one is already on the page. The billable event fires
 *  from onApply (the user's click), never from merely showing this. */
export function showPromoBanner(opts: BannerOptions): void {
  if (document.getElementById(BANNER_ID)) return;

  const card = el("div", {
    id: BANNER_ID,
    role: "dialog",
    "aria-label": `Support ${opts.creatorName}`,
  });
  style(card, {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: "2147483647",
    width: "320px",
    maxWidth: "calc(100vw - 32px)",
    padding: "12px 12px 12px 14px",
    background: "#ffffff",
    color: C.fg,
    font: `13px/1.45 ${FONT}`,
    textAlign: "left",
    borderRadius: "10px",
    border: `1px solid ${C.line}`,
    boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -8px rgba(0,0,0,0.18)",
    boxSizing: "border-box",
  });

  // Header: brand mark + name, dismiss on the right.
  const head = el("div");
  style(head, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" });
  const mark = el("span", { "aria-hidden": "true" });
  mark.innerHTML = MARK_SVG;
  style(mark, { width: "16px", height: "16px", display: "inline-block", flex: "none", lineHeight: "0" });
  const brand = el("span");
  brand.textContent = "Widda";
  style(brand, { fontSize: "11px", fontWeight: "500", color: C.muted, flex: "1" });

  const close = el("button", { type: "button", "aria-label": "Dismiss" });
  close.innerHTML =
    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
  style(close, {
    background: "transparent", color: C.faint, border: "0", cursor: "pointer", padding: "4px",
    margin: "-4px -4px -4px 0", borderRadius: "5px", display: "inline-flex", lineHeight: "0",
  });
  // Hover states are wired as listeners: the card is styled inline (no stylesheet is
  // injected into the merchant page), and inline styles can't express :hover.
  close.addEventListener("mouseenter", () => { close.style.color = C.fg; close.style.background = C.surface; });
  close.addEventListener("mouseleave", () => { close.style.color = C.faint; close.style.background = "transparent"; });
  close.addEventListener("click", () => {
    opts.onDismiss?.();
    dismiss(card);
  });
  head.append(mark, brand, close);

  // Title + one-line explanation.
  const title = el("div");
  title.innerHTML = `Support <strong style="font-weight:600">${escapeHtml(opts.creatorName)}</strong>`;
  style(title, { fontSize: "14px", fontWeight: "500", letterSpacing: "-0.01em", color: C.fg });
  const sub = el("div");
  sub.textContent = opts.code
    ? "Their promo code, ready for this checkout."
    : "Apply their referral to this order.";
  style(sub, { fontSize: "12px", color: C.muted, marginTop: "2px" });

  // Action row: code chip (if any) + apply button.
  const row = el("div");
  style(row, { display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" });

  if (opts.code) {
    const codeEl = el("code");
    codeEl.textContent = opts.code;
    style(codeEl, {
      flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      height: "32px", lineHeight: "30px", padding: "0 10px", boxSizing: "border-box",
      background: C.surface, color: C.fg, border: `1px solid ${C.line}`, borderRadius: "6px",
      font: `600 13px/30px ${MONO}`, letterSpacing: "0.04em",
    });
    row.append(codeEl);
  }

  const apply = el("button", { type: "button" });
  apply.textContent = opts.code ? "Copy & apply" : "Apply";
  apply.setAttribute("aria-label", opts.code ? "Copy promo code and apply" : "Apply support");
  style(apply, btnStyle(C.accent, "#fff"));
  if (!opts.code) apply.style.flex = "1";
  apply.addEventListener("mouseenter", () => { apply.style.background = C.accentHover; });
  apply.addEventListener("mouseleave", () => { apply.style.background = C.accent; });
  apply.addEventListener("click", () => {
    if (opts.code) void navigator.clipboard?.writeText(opts.code);
    opts.onApply?.();
    apply.innerHTML = `${CHECK_SVG}<span>Applied</span>`;
    apply.style.background = C.ok;
    apply.style.pointerEvents = "none";
    setTimeout(() => dismiss(card), 1100);
  });
  row.append(apply);

  card.append(head, title, sub, row);

  // CWS Affiliate Ads policy: disclose the affiliate relationship in the UI.
  if (opts.affiliate) {
    const disclosure = el("div");
    disclosure.textContent = "Affiliate offer · No extra cost to you";
    // One line, always: short enough to fit the 320px card, and clipped rather than wrapped if a
    // narrow window ever squeezes it.
    style(disclosure, { color: C.faint, fontSize: "11px", marginTop: "10px", paddingTop: "8px", borderTop: `1px solid ${C.line}`,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    card.append(disclosure);
  }

  document.body.appendChild(card);

  // Slide + fade in.
  card.animate(
    [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "translateY(0)" }],
    { duration: 180, easing: "ease-out" }
  );
}

/** Brief success toast (auto-dismisses). */
export function showToast(message: string): void {
  const t = el("div", { role: "status", "aria-live": "polite" });
  t.innerHTML = `${CHECK_SVG}<span></span>`;
  (t.lastElementChild as HTMLElement).textContent = message;
  style(t, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    maxWidth: "calc(100vw - 32px)",
    padding: "9px 14px 9px 11px",
    background: C.accent,
    color: "#fff",
    font: `500 13px/1.3 ${FONT}`,
    borderRadius: "999px",
    boxShadow: "0 8px 24px -6px rgba(0,0,0,0.35)",
    boxSizing: "border-box",
  });
  (t.firstElementChild as HTMLElement).style.color = "#34d399";
  document.body.appendChild(t);
  t.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 160, easing: "ease-out" });
  setTimeout(() => dismiss(t), 4000);
}

// ---- helpers ----

function dismiss(node: HTMLElement): void {
  const anim = node.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-6px)" }], { duration: 160, easing: "ease-in" });
  anim.onfinish = () => node.remove();
}

function btnStyle(bg: string, fg: string): Record<string, string> {
  return {
    background: bg, color: fg, border: "0", borderRadius: "6px", height: "32px", padding: "0 12px",
    cursor: "pointer", font: `500 12.5px/1 ${FONT}`, display: "inline-flex", alignItems: "center",
    justifyContent: "center", gap: "6px", whiteSpace: "nowrap", flex: "none", transition: "background .1s",
  };
}

function el(tag: string, attrs?: Record<string, string>): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function style(node: HTMLElement, styles: Record<string, string>): void {
  Object.assign(node.style, styles);
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
