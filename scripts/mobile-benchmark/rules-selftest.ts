// ============================================================
// Unit checks for lib/engines/mobile-rules.ts (no AI calls)
//   npm run test:mobile-rules
// Synthetic screenshots with known colours, sizes and prices,
// including regression cases from real-app false positives
// (dark text on a tinted chip, text over a photo).
// ============================================================

import sharp from "sharp";
import {
  annotatedCrop,
  decodeImage,
  deviceScale,
  measureContrast,
  runPermissionRules,
  runPriceRules,
  runScreenRules,
  runConsumerTextRules,
  componentOf,
  type Advisory,
  type ScreenInventory,
} from "../../lib/engines/mobile-rules";

let failures = 0;
const check = (name: string, cond: boolean, info?: unknown) => {
  if (!cond) failures++;
  console.log(cond ? "PASS" : "FAIL", name, info === undefined ? "" : JSON.stringify(info));
};

// Box helper: pixel rect on a 1080×2340 canvas → [ymin, xmin, ymax, xmax] 0–1000
const B = (x: number, y: number, w: number, h: number): [number, number, number, number] => [
  Math.round((y / 2340) * 1000), Math.round((x / 1080) * 1000), Math.round(((y + h) / 2340) * 1000), Math.round(((x + w) / 1080) * 1000),
];

(async () => {
  const photo = Array.from({ length: 40 }, (_, i) => `<rect x="${600 + (i % 8) * 50}" y="${1950 + Math.floor(i / 8) * 40}" width="50" height="40" fill="hsl(${i * 37},70%,${30 + (i % 5) * 12}%)"/>`).join("");
  const svg = `<svg width="1080" height="2340" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="2340" fill="#fff"/>
  <text x="60" y="500" font-size="44" font-family="Arial" fill="#cccccc">Deny tracking please</text>
  <text x="60" y="800" font-size="44" font-family="Arial" fill="#333333">Readable dark text here</text>
  <rect x="40" y="1000" width="300" height="110" rx="55" fill="#e3efe2"/><text x="110" y="1072" font-size="40" font-family="Arial" fill="#1d4d2b">Today</text>
  <rect x="400" y="1000" width="360" height="110" rx="55" fill="#f4ecdf"/><text x="460" y="1072" font-size="40" font-family="Arial" font-weight="bold" fill="#2a2a2a">Groceries</text>
  <rect x="60" y="1500" width="960" height="150" fill="#1a73e8"/><text x="100" y="1590" font-size="56" fill="#fff">Allow</text>
  <text x="500" y="1800" font-size="24" fill="#cccccc">Deny</text>
  ${photo}<text x="640" y="2060" font-size="40" font-family="Arial" fill="#ffffff">Sale</text></svg>`;
  const png = (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
  const img = await decodeImage(png);
  check("decodes screenshot", !!img && img.width === 1080);
  if (!img) process.exit(1);

  const low = measureContrast(img, B(60, 462, 430, 50));
  check("#ccc on white ≈ 1.61:1", low.ok && Math.abs(low.ratio - 1.61) < 0.2, low);
  const high = measureContrast(img, B(60, 762, 500, 50));
  check("#333 on white ≈ 12.6:1", high.ok && Math.abs(high.ratio - 12.63) < 1.2, high);
  const today = measureContrast(img, B(108, 1040, 116, 42));
  check("REGRESSION dark text on tinted pill passes (was 1.25:1)", today.ok && today.ratio > 7, today);
  const groceries = measureContrast(img, B(458, 1040, 200, 42));
  check("REGRESSION near-black text on cream chip passes (was 1.36:1)", groceries.ok && groceries.ratio > 10, groceries);
  const overPhoto = measureContrast(img, B(636, 2025, 90, 45));
  check("text over a photo is unmeasurable, not a finding", !overPhoto.ok, overPhoto);

  const inv: ScreenInventory = {
    elements: [
      { id: "a", type: "button", role: "accept", text: "Allow", box: B(100, 1550, 140, 55), tapBox: B(60, 1500, 960, 150), component: "permission dialog button" },
      { id: "d", type: "link", role: "decline", text: "Deny", box: B(500, 1778, 55, 28), component: "permission dialog button" },
      { id: "d2", type: "link", role: "other", text: "Later", box: B(570, 1778, 60, 28), component: "permission dialog button" },
      { id: "t", type: "button", text: "Today", box: B(108, 1040, 116, 42), tapBox: B(40, 1000, 300, 110), component: "bottom tab" },
      { id: "c", type: "checkbox", role: "addon", box: B(60, 1000, 50, 50), checked: true },
      { id: "cl", type: "text", text: "Protection plan (₹299)", box: B(140, 1005, 400, 45) },
      { id: "p", type: "button", role: "primary-cta", text: "Pay ₹1,996", box: B(400, 1850, 300, 60), tapBox: B(60, 1800, 960, 150) },
      { id: "iso", type: "icon", role: "close", box: B(1000, 280, 30, 30), component: "modal close" },
      { id: "logo", type: "text", role: "logo", text: "BrandCo", box: B(60, 462, 430, 50) },
    ],
    amounts: [
      { label: "Earbuds", value: 1499, currency: "₹", role: "line-item" },
      { label: "Convenience fee", value: 149, currency: "₹", role: "fee" },
      { label: "Platform fee", value: 49, currency: "₹", role: "fee" },
      { label: "Total", value: 1697, currency: "₹", role: "total" },
      { label: "Protection", value: 299, currency: "₹", role: "addon", elementId: "c" },
      { label: "Pay", value: 1996, currency: "₹", role: "pay-button", elementId: "p" },
    ],
  };
  const advisories: Advisory[] = [];
  const f = runScreenRules(0, inv, img, "android", deviceScale("android", 1080, 2340), advisories);
  check("low-contrast decline flagged (1.4.3)", f.some((x) => x.ruleId === "1.4.3" && x.elementId === "d"));
  check("contrast finding title is per component (for grouping)", f.filter((x) => x.ruleId === "1.4.3").every((x) => !x.title.includes('"')), f.filter((x) => x.ruleId === "1.4.3").map((x) => x.title));
  check("no contrast finding on dark-on-pill tab", !f.some((x) => x.ruleId === "1.4.3" && x.elementId === "t"));
  check("logo text exempt from 1.4.3", !f.some((x) => x.elementId === "logo"));
  check("crowded tiny decline link → verify-on-device (medium, low confidence)", f.some((x) => x.ruleId === "2.5.8" && x.elementId === "d" && x.severity === "medium" && x.confidence === "low"));
  check("isolated small close icon → spacing-exception advisory, not a finding", !f.some((x) => x.elementId === "iso" && x.ruleId === "2.5.8") && advisories.some((a) => a.ruleId === "2.5.8"));
  check("tab with full tap area not flagged for size", !f.some((x) => x.ruleId === "2.5.8" && x.elementId === "t"));
  check("accept/decline asymmetry flagged", f.some((x) => x.ruleId === "DP-AX-01" || x.ruleId === "DP-MD-09"));
  check("pre-ticked paid add-on flagged (DP-SN-02)", f.some((x) => x.ruleId === "DP-SN-02"));
  check("no AAA findings — platform-size items are advisories", !f.some((x) => x.ruleId === "2.5.5"));

  const prices = runPriceRules([{ elements: [], amounts: [{ label: "Trial", value: 0, role: "price", currency: "₹" }] }, inv]);
  check("pay ≠ total explained by pre-ticked add-on", prices.some((x) => x.ruleId === "DP-SN-02" && x.measurements.difference === 299));
  check("fees revealed later → drip pricing", prices.some((x) => x.ruleId === "DP-PM-04" && x.screens.join() === "0,1"));
  const clean = runPriceRules([{ elements: [], amounts: [
    { label: "a", value: 100, role: "line-item" }, { label: "b", value: 20, role: "fee" },
    { label: "t", value: 120, role: "total" }, { label: "p", value: 120, role: "pay-button" },
  ] }]);
  check("consistent prices produce no finding", clean.length === 0, clean.map((p) => p.title));

  check("permission prompt without rationale flagged", runPermissionRules([
    { elements: [{ id: "x", type: "text", role: "permission-prompt", text: "Allow location?", box: [300, 100, 400, 900] }], amounts: [] },
  ]).length === 1);
  check("permission prompt after rationale not flagged", runPermissionRules([
    { elements: [{ id: "r", type: "text", role: "permission-rationale", text: "We use location to…", box: [1, 1, 2, 2] }], amounts: [] },
    { elements: [{ id: "x", type: "text", role: "permission-prompt", text: "Allow?", box: [1, 1, 2, 2] }], amounts: [] },
  ]).length === 0);

  // ── Review regressions (29 Oct report) ──
  const covered: ScreenInventory = {
    elements: [
      { id: "bar", type: "button", role: "fixed-bar", overlay: true, text: "Today", box: B(0, 1700, 1080, 200), component: "bottom tab bar" },
      { id: "under", type: "text", text: "Readable dark text here", box: B(60, 762, 500, 50), occluded: true, component: "product unit" },
      { id: "faint", type: "text", text: "Deny tracking please", box: B(60, 462, 430, 50), component: "fine print" },
      { id: "stars", type: "button", role: "rating-prompt", box: B(100, 1200, 700, 60), tapBox: B(100, 1200, 700, 60), component: "rating star button" },
    ],
    amounts: [],
  };
  const adv2: Advisory[] = [];
  const f2 = runScreenRules(0, covered, img, "ios", deviceScale("ios", 1080, 2340), adv2);
  check("occluded text skipped for contrast and listed as advisory", !f2.some((x) => x.elementId === "under") && adv2.some((a) => a.ruleId === "content-obscured"));
  check("rating row is not measured as one wide target", !f2.some((x) => x.elementId === "stars"));
  const veryFaint = f2.find((x) => x.elementId === "faint");
  // #ccc on white (1.61:1) is genuinely faint text, above the 1.5 implausibility cut-off → stays high
  check("real faint text (1.61:1) is still reported as high", !!veryFaint && veryFaint.severity === "high" && veryFaint.confidence !== "low", veryFaint && { r: veryFaint.measurements.contrastRatio, s: veryFaint.severity, c: veryFaint.confidence });
  check("component name drops the element's own text", componentOf({ id: "x", type: "button", text: "Cafe", component: "category chip cafe", box: [0, 0, 1, 1] }) === "category chip");

  // Real-run regressions: evenly spaced stars, card text with tap boxes, glyph-sized icon taps
  const starsInv: ScreenInventory = {
    elements: [0, 1, 2, 3, 4].map((k) => ({
      id: `st${k}`, type: "button" as const, role: "rating-star" as const, component: `rating star ${k + 1}`,
      box: B(300 + k * 100, 1200, 60, 60), tapBox: B(300 + k * 100, 1200, 60, 60),
    })),
    amounts: [],
  };
  starsInv.elements.push(
    { id: "w1", type: "text", text: "40 g", box: B(60, 1500, 80, 30), tapBox: B(60, 1500, 80, 30), component: "product weight" },
    { id: "heart", type: "icon", role: "other", component: "wishlist button", box: B(900, 1500, 40, 40), tapBox: B(900, 1500, 42, 42) },
    { id: "plus", type: "button", component: "add-to-cart button", box: B(950, 1500, 40, 40), tapBox: B(950, 1500, 40, 40) },
  );
  const adv3: Advisory[] = [];
  const f3 = runScreenRules(0, starsInv, img, "ios", deviceScale("ios", 1080, 2340), adv3);
  check("evenly spaced stars pass via spacing exception (no 2.5.8 violation)", !f3.some((x) => x.ruleId === "2.5.8" && x.elementId?.startsWith("st")), f3.filter((x) => x.elementId?.startsWith("st")).map((x) => x.title));
  check("plain card text with a tap box is not a target", !f3.some((x) => x.elementId === "w1"));
  check("crowded glyph-sized icon is 'verify on device', not high", !f3.some((x) => x.elementId === "heart" && x.severity === "high"));
  check("numbers stripped from component names", componentOf({ id: "x", type: "button", component: "rating star 3", box: [0, 0, 1, 1] }) === "rating star");

  const consumer = runConsumerTextRules([
    { elements: [
      { id: "r", type: "text", text: "HOW WAS YOUR APP EXPERIENCE?", box: [800, 100, 820, 900] },
      { id: "s", type: "text", text: "Powered by COSMIX", box: [300, 600, 320, 900] },
      { id: "b", type: "button", role: "promo-banner", overlay: true, text: "Get 10% cashback on your first three orders", box: [780, 0, 800, 1000] },
      { id: "u", type: "text", text: "Hurry! Only 2 left in stock", box: [400, 50, 420, 600] },
    ], amounts: [{ label: "MRP", value: 99, currency: "₹", role: "reference", elementId: "s" }] },
    { elements: [
      { id: "b2", type: "button", role: "promo-banner", overlay: true, text: "Get 10% cashback on your first three orders", box: [780, 0, 800, 1000] },
      { id: "ad", type: "text", text: "Sponsored", box: [100, 100, 110, 200] },
      { id: "s2", type: "text", text: "Featured brands", box: [200, 100, 220, 400] },
    ], amounts: [] },
  ]);
  const has = (rule: string, screen: number) => consumer.some((x) => x.ruleId === rule && x.screens.includes(screen));
  check("rating prompt detected (DP-NG-01)", has("DP-NG-01", 0));
  check("unlabelled partner placement detected (DP-MD-05)", has("DP-MD-05", 0));
  check("labelled placement not flagged", !has("DP-MD-05", 1));
  check("struck-out reference price detected (DP-MD-08)", has("DP-MD-08", 0));
  check("banner repeated across screens detected (DP-NG-04)", consumer.some((x) => x.ruleId === "DP-NG-04" && x.screens.length === 2));
  check("urgency copy detected via shared pattern library", consumer.some((x) => x.ruleId === "DP-SU-03"));

  const crop = await annotatedCrop(png, B(500, 1778, 55, 28));
  check("annotated evidence crop is a small PNG", !!crop && Buffer.from(crop, "base64").subarray(1, 4).toString() === "PNG" && crop.length < 200_000);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exitCode = failures ? 1 : 0;
})();
