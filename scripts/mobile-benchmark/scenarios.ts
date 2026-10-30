// ============================================================
// Mobile audit benchmark — gold scenarios
// Synthetic app journeys rendered from SVG (1080×2340, Android)
// with the issues each one deliberately contains.
//
// expected: issues the audit MUST find (recall is measured on these)
//   anyOf  — acceptable rule IDs (DP-*, WCAG "1.4.3", or "privacy:<category>")
//   screen — 1-based screen number where it should be reported
// allowed: extra rule IDs that are legitimate if reported (not false positives)
// A scenario with expected = [] and strict = true is a clean control:
// any critical/high finding there counts as a false positive.
// Extend this set with anonymised real client screens over time.
// ============================================================

export interface ExpectedIssue {
  anyOf: string[];
  screen: number;
  note: string;
}

export interface Scenario {
  id: string;
  appName: string;
  platform?: "android" | "ios";
  screens: { label: string; svg: string }[];
  /** Real-app scenario: load screenshots from a local audit in .audit-data (not committed) */
  fromAudit?: string;
  expected: ExpectedIssue[];
  allowed: string[];
  strict?: boolean;
  /** Real apps: unknown issues are not false positives; only "forbidden" hits are */
  openWorld?: boolean;
  /** Known false positives that must NOT be reported (rule + element text) */
  forbidden?: { ruleId: string; text: string[]; note: string }[];
}

const W = 1080;
const H = 2340;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (s: string, x: number, y: number, size: number, fill: string, bold = false) =>
  `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${fill}"${bold ? ' font-weight="bold"' : ""}>${esc(s)}</text>`;
const button = (s: string, x: number, y: number, w: number, h: number, bg: string, fg: string, size: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${bg}"/>${text(s, x + 40, y + h / 2 + size / 3, size, fg, true)}`;
const screen = (brand: string, body: string) =>
  `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#ffffff"/><rect width="${W}" height="220" fill="#1a73e8"/>${text(brand, 60, 150, 60, "#ffffff", true)}${body}</svg>`;
const checkbox = (x: number, y: number, checked: boolean) =>
  `<rect x="${x}" y="${y}" width="50" height="50" fill="#fff" stroke="#333" stroke-width="4"/>${checked ? text("✓", x + 8, y + 43, 48, "#1a73e8", true) : ""}`;

export const SCENARIOS: Scenario[] = [
  {
    // Real grocery app (5 iOS screenshots) reviewed by hand on 29 Oct 2026.
    // Screens live in the local audit file only — skipped when it is absent.
    id: "first-club-real",
    appName: "first club",
    platform: "ios",
    fromAudit: "78bdbf2e-c6bf-4e3d-b2fc-f91527fb0127",
    screens: [],
    openWorld: true,
    expected: [
      { anyOf: ["DP-NG-01", "DP-NG-04", "DP-NG-02"], screen: 1, note: "Rating modal / cashback bar interrupting browsing" },
      { anyOf: ["DP-MD-08"], screen: 2, note: "Struck-out reference prices on product cards" },
      { anyOf: ["DP-NG-01", "DP-NG-04", "DP-IF-04"], screen: 5, note: "Cashback bar overlaying content (repeats across screens)" },
    ],
    allowed: [],
    forbidden: [
      { ruleId: "1.4.3", text: ["Today", "Groceries", "Aisles", "Reorder", "Profile"], note: "Dark text on light chip/tab — readable (was measured 1.25–1.4:1)" },
      { ruleId: "2.5.8", text: ["Fresh Fruits", "Fresh Veggies", "Exotic Fruits"], note: "Labels inside full-size category tiles" },
    ],
  },
  {
    id: "shopfast",
    appName: "ShopFast",
    screens: [
      {
        label: "Welcome",
        svg: screen(
          "ShopFast",
          text("Welcome to ShopFast!", 60, 500, 70, "#111", true) +
            text("Deals near you, delivered fast.", 60, 600, 44, "#bbbbbb") +
            `<rect width="${W}" height="${H}" fill="rgba(0,0,0,0.5)"/><rect x="100" y="800" width="880" height="600" rx="24" fill="#fff"/>` +
            text('Allow "ShopFast" to access', 150, 920, 48, "#111", true) +
            text("this device's location?", 150, 990, 48, "#111", true) +
            button("Allow", 150, 1150, 780, 110, "#1a73e8", "#fff", 44) +
            text("Deny", 500, 1340, 24, "#cccccc"),
        ),
      },
      {
        label: "Plans",
        svg: screen(
          "ShopFast",
          text("Start your FREE trial", 60, 450, 72, "#111", true) +
            text("Unlimited free delivery", 60, 560, 44, "#333") +
            text("₹0 today", 60, 700, 90, "#0a8f3c", true) +
            text("Only 2 trials left at this price! Offer ends in 04:59", 60, 820, 40, "#d00", true) +
            button("Start Free Trial", 60, 1700, 960, 150, "#1a73e8", "#fff", 56) +
            text("* renews at ₹999/month automatically, cancel via email to support", 60, 1950, 22, "#cccccc"),
        ),
      },
      {
        label: "Checkout",
        svg: screen(
          "ShopFast",
          text("Checkout", 60, 400, 70, "#111", true) +
            text("Wireless earbuds", 60, 560, 44, "#333") + text("₹1,499", 800, 560, 44, "#333") +
            text("Convenience fee", 60, 650, 44, "#333") + text("₹149", 800, 650, 44, "#333") +
            text("Platform fee", 60, 740, 44, "#333") + text("₹49", 800, 740, 44, "#333") +
            text("Total", 60, 880, 54, "#111", true) + text("₹1,697", 800, 880, 54, "#111", true) +
            checkbox(60, 1000, true) + text("Add Device Protection Plan (₹299)", 140, 1040, 40, "#333") +
            button("Pay ₹1,996", 60, 1800, 960, 150, "#1a73e8", "#fff", 56),
        ),
      },
      {
        label: "Exit offer",
        svg: screen(
          "ShopFast",
          text("Wait! Don't leave yet", 60, 500, 70, "#111", true) +
            text("Get 10% off if you complete your order now", 60, 600, 40, "#333") +
            button("YES, GIVE ME 10% OFF", 60, 1500, 960, 170, "#e8002d", "#fff", 58) +
            text("No thanks, I like paying full price", 330, 1800, 26, "#bbbbbb") +
            text("×", 1010, 300, 30, "#dddddd"),
        ),
      },
    ],
    expected: [
      { anyOf: ["privacy:data-collection"], screen: 1, note: "Location prompt with no prior rationale" },
      { anyOf: ["1.4.3"], screen: 1, note: "'Deny' #ccc on white (1.6:1)" },
      { anyOf: ["2.5.8"], screen: 1, note: "'Deny' tap target ~41×12dp" },
      { anyOf: ["DP-AX-01", "DP-MD-09", "DP-IF-02", "DP-IF-01"], screen: 1, note: "Allow vs Deny asymmetry" },
      { anyOf: ["DP-SU-01", "DP-SU-02", "DP-SU-05", "DP-FS-01", "DP-SU-03"], screen: 2, note: "Fake countdown / only 2 left" },
      { anyOf: ["DP-SN-09", "DP-FA-04", "DP-PM-03"], screen: 2, note: "Free trial → ₹999/month in faint fine print" },
      { anyOf: ["DP-SN-02", "DP-SN-06", "DP-HC-01"], screen: 3, note: "Pay ₹1,996 ≠ total ₹1,697 (pre-ticked ₹299 add-on)" },
      { anyOf: ["DP-CS-01", "DP-CS-02", "DP-CS-05"], screen: 4, note: "Confirmshaming decline link" },
    ],
    allowed: ["1.4.11", "2.5.5", "DP-PM-04", "DP-SN-07", "DP-HC-01", "DP-OB-06", "DP-PM-05", "DP-NG-04", "DP-IF-04", "DP-AX-04", "DP-NG-02", "DP-SU-03", "privacy:privacy-policy", "privacy:consent-mechanism", "1.4.4", "DP-MD-09", "DP-SN-01"],
  },
  {
    id: "consent",
    appName: "NewsNow",
    screens: [
      {
        label: "Consent",
        svg: screen(
          "NewsNow",
          text("We value your privacy", 60, 500, 64, "#111", true) +
            text("We and 812 partners use your data for", 60, 600, 40, "#333") +
            text("personalised ads and content.", 60, 660, 40, "#333") +
            checkbox(60, 760, true) + text("Send me offers from partners", 140, 800, 38, "#333") +
            button("Accept all & continue", 60, 1600, 960, 160, "#1a73e8", "#fff", 56) +
            text("Manage options", 420, 1850, 26, "#bbbbbb"),
        ),
      },
      {
        label: "Sign up",
        svg: screen(
          "NewsNow",
          text("Create your account", 60, 450, 64, "#111", true) +
            text("Sign up to keep reading", 60, 540, 40, "#333") +
            button("Continue with Google", 60, 800, 960, 140, "#ffffff", "#111", 46) +
            `<rect x="60" y="800" width="960" height="140" rx="16" fill="none" stroke="#999" stroke-width="3"/>` +
            text("Full name", 60, 1100, 34, "#555") + `<rect x="60" y="1120" width="960" height="110" fill="#fff" stroke="#999" stroke-width="3"/>` +
            text("Date of birth", 60, 1300, 34, "#555") + `<rect x="60" y="1320" width="960" height="110" fill="#fff" stroke="#999" stroke-width="3"/>` +
            text("Mobile number", 60, 1500, 34, "#555") + `<rect x="60" y="1520" width="960" height="110" fill="#fff" stroke="#999" stroke-width="3"/>`,
        ),
      },
    ],
    expected: [
      { anyOf: ["DP-CC-01", "DP-IF-03", "privacy:consent-mechanism"], screen: 1, note: "No 'Reject all' on consent screen" },
      { anyOf: ["DP-SN-01", "DP-PZ-03", "DP-SN-08"], screen: 1, note: "Pre-ticked partner offers" },
      { anyOf: ["DP-AX-01", "DP-MD-09", "DP-IF-01", "DP-IF-02", "DP-IF-10"], screen: 1, note: "Accept all vs tiny faint Manage options" },
      { anyOf: ["DP-FA-01", "DP-FA-05"], screen: 2, note: "Forced sign-up to keep reading" },
    ],
    allowed: ["1.4.3", "2.5.8", "2.5.5", "privacy:data-minimization", "privacy:data-collection", "privacy:third-party-tracker", "privacy:privacy-policy", "DP-PZ-01", "DP-PZ-04", "DP-FA-06", "DP-FA-07", "DP-SN-08", "DP-CC-05", "1.3.1", "3.3.2"],
  },
  {
    id: "cancel",
    appName: "StreamPlus",
    screens: [
      {
        label: "Cancel subscription",
        svg: screen(
          "StreamPlus",
          text("Cancel subscription", 60, 450, 64, "#111", true) +
            text("To cancel your plan, please email", 60, 600, 40, "#333") +
            text("support@streamplus.example with your", 60, 660, 40, "#333") +
            text("account ID. Requests take 5–7 working days.", 60, 720, 40, "#333") +
            button("Keep my benefits", 60, 1600, 960, 160, "#1a73e8", "#fff", 56) +
            button("I don't care about my favourite shows", 60, 1820, 960, 140, "#eeeeee", "#555", 36),
        ),
      },
    ],
    expected: [
      { anyOf: ["DP-OB-06", "DP-PM-05", "DP-OB-04", "DP-OB-01"], screen: 1, note: "Cancellation only by email" },
      { anyOf: ["DP-CS-01", "DP-CS-02", "DP-CS-05"], screen: 1, note: "Shaming decline label" },
    ],
    allowed: ["DP-MD-09", "DP-AX-01", "DP-IF-02", "1.4.3", "DP-OB-03"],
  },
  {
    id: "clean-control",
    appName: "FairPay",
    strict: true,
    screens: [
      {
        label: "Checkout",
        svg: screen(
          "FairPay",
          text("Checkout", 60, 400, 70, "#111", true) +
            text("Notebook", 60, 560, 44, "#222") + text("₹250", 820, 560, 44, "#222") +
            text("Delivery", 60, 650, 44, "#222") + text("₹40", 820, 650, 44, "#222") +
            text("Total", 60, 800, 54, "#111", true) + text("₹290", 820, 800, 54, "#111", true) +
            checkbox(60, 920, false) + text("Add gift wrap (₹30)", 140, 960, 40, "#222") +
            text("Prices include all taxes and fees.", 60, 1100, 36, "#333") +
            button("Pay ₹290", 60, 1700, 960, 150, "#1a5bc4", "#fff", 56) +
            button("Back to cart", 60, 1890, 960, 150, "#ffffff", "#1a5bc4", 52) +
            `<rect x="60" y="1890" width="960" height="150" rx="16" fill="none" stroke="#1a5bc4" stroke-width="4"/>`,
        ),
      },
    ],
    expected: [],
    allowed: ["2.5.5", "privacy:privacy-policy"],
  },
];
