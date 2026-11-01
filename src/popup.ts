// Popup UI: sign-in, ranked creator list (drag to reorder), manual refresh.
// Ordering is the client-side source of truth and lives in chrome.storage.sync.
import { fetchStatus } from "./api.js";
import type { LocalStore, RankedCreator, SyncStore } from "./types.js";

const ERROR_MSG = "Couldn't refresh your subscriptions. Your saved creators still work at checkout. Try Refresh in a bit.";

function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? `around ${time}` : `${d.toLocaleDateString(undefined, { weekday: "long" })} around ${time}`;
}

function quotaMessage(retryAt: string): string {
  return (
    "YouTube is limiting how often Widda can check subscriptions right now, so new creators may take a while to appear. " +
    `Your saved creators still work at checkout. We'll check again automatically ${when(retryAt)}.`
  );
}

let actionError = ""; // last sign-in/refresh message that isn't a sync-status (shown until the next action)
let operatorNotice: string | null = null;

const statusEl = () => document.getElementById("status");
const listEl = () => document.getElementById("creators") as HTMLUListElement | null;
const signinBtn = () => document.getElementById("signin") as HTMLButtonElement | null;
const refreshBtn = () => document.getElementById("refresh") as HTMLButtonElement | null;
const deleteBtn = () => document.getElementById("delete") as HTMLButtonElement | null;

let dragFrom = -1;

async function getState(): Promise<{ signedIn: boolean; creators: RankedCreator[] }> {
  const { user, ranked_creators = [] } = (await chrome.storage.sync.get([
    "user",
    "ranked_creators",
  ])) as SyncStore;
  const creators = [...ranked_creators].sort((a, b) => a.rank - b.rank);
  return { signedIn: !!user?.widda_token, creators };
}

async function persistOrder(creators: RankedCreator[]): Promise<void> {
  // Reassign contiguous ranks (1..n) after a reorder.
  const reranked = creators.map((c, i) => ({ ...c, rank: i + 1 }));
  await chrome.storage.sync.set({ ranked_creators: reranked });
}

function renderList(creators: RankedCreator[]): void {
  const list = listEl();
  if (!list) return;
  list.innerHTML = "";

  creators.forEach((c, index) => {
    const li = document.createElement("li");
    li.className = "creator";
    li.draggable = true;
    li.dataset.index = String(index);

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 1);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.name;
    li.append(rank, name);

    li.addEventListener("dragstart", () => {
      dragFrom = index;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", async (e) => {
      e.preventDefault();
      const to = index;
      if (dragFrom < 0 || dragFrom === to) return;
      const next = [...creators];
      const [moved] = next.splice(dragFrom, 1);
      next.splice(to, 0, moved);
      await persistOrder(next);
      // storage.onChanged will trigger a re-render.
    });

    list.appendChild(li);
  });
}

async function render(): Promise<void> {
  const { signedIn, creators } = await getState();

  const status = statusEl();
  if (status) {
    status.textContent = signedIn
      ? `Signed in — ${creators.length} creator${creators.length === 1 ? "" : "s"}`
      : "Not signed in";
  }
  const signin = signinBtn();
  if (signin) signin.style.display = signedIn ? "none" : "";
  const refresh = refreshBtn();
  if (refresh) refresh.disabled = !signedIn;

  const del = deleteBtn();
  if (del) del.hidden = !signedIn;

  const empty = document.getElementById("empty");
  if (empty) empty.hidden = !(signedIn && creators.length === 0);

  const { sync_status } = (await chrome.storage.local.get("sync_status")) as LocalStore;
  setNotice("notice-operator", operatorNotice);
  setNotice(
    "notice-sync",
    actionError ||
      (sync_status?.state === "quota"
        ? quotaMessage(sync_status.retry_at)
        : sync_status?.state === "error" && signedIn
          ? ERROR_MSG
          : null),
  );

  renderList(creators);
}

function setNotice(id: string, text: string | null): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text ?? "";
  el.hidden = !text;
}

// runAction sends a message to the background worker and surfaces a failure in the popup.
async function runAction(kind: "signin" | "refresh_subscriptions"): Promise<void> {
  setBusy(true);
  actionError = "";
  try {
    const res = (await chrome.runtime.sendMessage({ kind })) as
      | { ok: boolean; cooldown_until?: string }
      | undefined;
    const { sync_status } = (await chrome.storage.local.get("sync_status")) as LocalStore;
    if (res?.cooldown_until) {
      const mins = Math.max(1, Math.ceil((new Date(res.cooldown_until).getTime() - Date.now()) / 60_000));
      actionError = `Already up to date. You can refresh again in ${mins} minute${mins === 1 ? "" : "s"}.`;
    } else if (!res?.ok && !sync_status) {
      actionError = kind === "signin" ? "Sign-in didn't complete. Please try again." : ERROR_MSG;
    }
  } finally {
    setBusy(false);
    void render();
  }
}

function setBusy(busy: boolean): void {
  const signin = signinBtn();
  const refresh = refreshBtn();
  if (signin) signin.disabled = busy;
  if (refresh) refresh.disabled = busy;
}

signinBtn()?.addEventListener("click", () => void runAction("signin"));
refreshBtn()?.addEventListener("click", () => void runAction("refresh_subscriptions"));

// Two-step delete: first click arms it for 5 s, second click deletes. No modal dialogs.
let disarmTimer: number | undefined;
deleteBtn()?.addEventListener("click", async () => {
  const btn = deleteBtn();
  if (!btn) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to delete everything";
    disarmTimer = window.setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = "Delete my data";
    }, 5000);
    return;
  }
  window.clearTimeout(disarmTimer);
  btn.disabled = true;
  btn.textContent = "Deleting…";
  const res = (await chrome.runtime.sendMessage({ kind: "delete_account" })) as { ok: boolean } | undefined;
  delete btn.dataset.armed;
  btn.disabled = false;
  btn.textContent = "Delete my data";
  actionError = res?.ok
    ? "Your Widda data is deleted. To also remove Widda's access to your Google account, visit myaccount.google.com/permissions."
    : "Couldn't delete your data. Please try again, or email support@widda.club.";
  void render();
});

// Re-render when storage changes (e.g. background sync appends creators or clears sync_status).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" || (area === "local" && "sync_status" in changes)) void render();
});

void render();
void fetchStatus().then(({ notice }) => {
  operatorNotice = notice;
  void render();
});

// ---- dev-only: sign in as a synthetic viewer for the checkout simulator ----
// Stripped from production (guarded by __DEV__, minified out). Paste the "dev extension
// setup" blob from the admin console to load a synthetic viewer session + rankings.
function buildDevPanel(): void {
  const panel = document.createElement("div");
  const label = document.createElement("div");
  label.textContent = "DEV — paste admin console session blob:";
  label.style.cssText = "font-size:11px;color:#a00;margin-top:10px";
  const ta = document.createElement("textarea");
  ta.placeholder = '{"token":"…","user_id":"…","ranked":[…]}';
  ta.rows = 3;
  ta.style.cssText = "width:100%;box-sizing:border-box;font-family:monospace;font-size:10px";
  const btn = document.createElement("button");
  btn.textContent = "Load dev session";
  btn.addEventListener("click", async () => {
    const status = statusEl();
    try {
      const blob = JSON.parse(ta.value);
      await chrome.runtime.sendMessage({
        kind: "dev_load_session",
        token: blob.token,
        userId: blob.user_id,
        ranked: blob.ranked ?? [],
      });
      void render();
    } catch {
      if (status) status.textContent = "Dev blob parse error";
    }
  });
  panel.append(label, ta, btn);
  document.body.appendChild(panel);
}

if (__DEV__) buildDevPanel();
