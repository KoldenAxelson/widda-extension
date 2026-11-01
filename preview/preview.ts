// Preview harness logic — NOT shipped in the extension.
// Renders the real banner/toast UI (from src/ui.ts) so the visuals can be
// iterated in a plain browser without loading the extension in Chrome.
import { showPromoBanner, showToast } from "../src/ui.js";

const samples = [
  { code: "ADA10", creator: "Ada Builds" },
  { code: "TOMS15", creator: "Tom's Workshop" },
  { code: "SAVE20", creator: "A Creator With A Rather Long Channel Name" },
];
let i = 0;

document.getElementById("show-banner")?.addEventListener("click", () => {
  const s = samples[i % samples.length];
  i++;
  showPromoBanner({
    code: s.code,
    creatorName: s.creator,
    onApply: () => showToast(`Applied ${s.code} — thank you for supporting ${s.creator}`),
    onDismiss: () => showToast("Banner dismissed (would suppress 24h)"),
  });
});

document.getElementById("show-toast")?.addEventListener("click", () => {
  showToast("Thank you for supporting Ada Builds");
});
