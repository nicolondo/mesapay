// @ts-check
/**
 * MESAPAY runtime error crawler (Playwright).
 *
 * Read-only health crawl: navigates (GET only) a curated list of page routes
 * in both a mobile and a desktop viewport, and records every runtime problem:
 *   - uncaught JS exceptions (pageerror)        → CRITICAL
 *   - main document 5xx / failed navigation      → CRITICAL
 *   - "Application error" client crash in body    → CRITICAL
 *   - console.error / failed sub-requests (4xx/5xx) → WARNING
 *   - console.warning (hydration, next-intl, etc.) → WARNING
 *   - auth-gated routes redirecting to /signin     → INFO (expected)
 *   - unexpected 404 on a route we expected to exist → WARNING
 *
 * It NEVER submits forms, logs in, or clicks action controls — pure GET
 * navigation, safe to run against production.
 *
 * Usage:  node e2e/crawl.mjs [baseURL]
 *         CRAWL_BASE=https://mesapay.co node e2e/crawl.mjs
 */
import { chromium, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.argv[2] || process.env.CRAWL_BASE || "https://mesapay.co").replace(/\/$/, "");
const SETTLE_MS = 2600; // SSE keeps the connection open, so we can't use networkidle.
const NAV_TIMEOUT = 25_000;

/** @typedef {{path:string, kind:"public"|"gated"|"diner"|"dynamic", note?:string}} Route */

/** @type {Route[]} */
const ROUTES = [
  // ---- Public ----
  { path: "/", kind: "public", note: "landing" },
  { path: "/signin", kind: "public" },
  { path: "/signup", kind: "public" },
  { path: "/signup/restaurant", kind: "public" },
  { path: "/nicolas", kind: "public", note: "contact card" },
  { path: "/nicolas/qr", kind: "public" },
  { path: "/t/pse-mock-bank", kind: "public", note: "PSE mock bank" },

  // ---- Auth-gated (expect redirect to /signin) ----
  { path: "/operator", kind: "gated" },
  { path: "/operator/menu", kind: "gated" },
  { path: "/operator/menus", kind: "gated" },
  { path: "/operator/menu/import", kind: "gated" },
  { path: "/operator/kitchen", kind: "gated" },
  { path: "/operator/bar", kind: "gated" },
  { path: "/operator/serve", kind: "gated" },
  { path: "/operator/payments", kind: "gated" },
  { path: "/operator/orders", kind: "gated" },
  { path: "/operator/tables", kind: "gated" },
  { path: "/operator/reservas", kind: "gated" },
  { path: "/operator/ratings", kind: "gated" },
  { path: "/operator/facturas", kind: "gated" },
  { path: "/operator/reports", kind: "gated" },
  { path: "/operator/reports/no-cobrados", kind: "gated" },
  { path: "/operator/wallet", kind: "gated" },
  { path: "/operator/insights", kind: "gated" },
  { path: "/operator/shifts", kind: "gated" },
  { path: "/operator/settings", kind: "gated" },
  { path: "/operator/settings/datafonos", kind: "gated" },
  { path: "/operator/settings/estaciones", kind: "gated" },
  { path: "/operator/settings/etiquetas", kind: "gated" },
  { path: "/operator/settings/identidad", kind: "gated" },
  { path: "/operator/settings/mesas", kind: "gated" },
  { path: "/operator/settings/meseros", kind: "gated" },
  { path: "/operator/settings/pagos", kind: "gated" },
  { path: "/operator/settings/reservas", kind: "gated" },
  { path: "/operator/settings/salon", kind: "gated" },
  { path: "/operator/settings/staff-policies", kind: "gated" },
  { path: "/operator/settings/traducciones", kind: "gated" },
  { path: "/operator/settings/usuarios", kind: "gated" },
  { path: "/admin", kind: "gated" },
  { path: "/admin/restaurants", kind: "gated" },
  { path: "/admin/restaurants/new", kind: "gated" },
  { path: "/admin/groups", kind: "gated" },
  { path: "/admin/plans", kind: "gated" },
  { path: "/admin/audit", kind: "gated" },
  { path: "/admin/comisiones", kind: "gated" },
  { path: "/admin/configuracion", kind: "gated" },
  { path: "/group", kind: "gated" },
  { path: "/group/razones-sociales", kind: "gated" },
  { path: "/group/restaurants/new", kind: "gated" },
  { path: "/comercial", kind: "gated" },
  { path: "/comercial/hoy", kind: "gated" },
  { path: "/comercial/crm", kind: "gated" },
  { path: "/comercial/calendario", kind: "gated" },
  { path: "/comercial/equipo", kind: "gated" },
  { path: "/comercial/mas", kind: "gated" },
  { path: "/me", kind: "gated" },
  { path: "/mesero", kind: "gated" },
  { path: "/mesero/mesas", kind: "gated" },
  { path: "/mesero/salon", kind: "gated" },
  { path: "/mesero/cobros", kind: "gated" },
  { path: "/mesero/yo", kind: "gated" },
  { path: "/terminal", kind: "gated" },
  { path: "/bar", kind: "gated" },
  { path: "/cocina", kind: "gated" },

  // ---- 404 handling probes (should render the not-found page, not 500) ----
  { path: "/t/__no_such_slug__", kind: "dynamic", note: "expect 404" },
  { path: "/factura/__no_such_id__", kind: "dynamic", note: "expect 404" },
  { path: "/restablecer/__bad_token__", kind: "dynamic", note: "reset-password bad token" },
  { path: "/this-route-does-not-exist", kind: "dynamic", note: "global 404" },
];

// Diner restaurant landing — best-effort slug guesses (200 = real menu found).
const DINER_SLUG_GUESSES = ["chefburger", "chef-burger", "casateresita", "casa-teresita", "teresita", "demo", "mesapay"];
for (const s of DINER_SLUG_GUESSES) ROUTES.push({ path: `/t/${s}`, kind: "diner", note: `slug guess: ${s}` });

const VIEWPORTS = [
  { name: "mobile", opts: devices["iPhone 13"] },
  { name: "desktop", opts: { viewport: { width: 1366, height: 900 }, userAgent: undefined } },
];

const NOISE = [
  /favicon/i,
  /Download the React DevTools/i,
  /web-vitals/i,
  /\[Fast Refresh\]/i,
  /Manifest:/i,
  /Service Worker/i,
];
const isNoise = (s) => NOISE.some((r) => r.test(String(s || "")));

/** @type {any[]} */
const results = [];

async function crawlOne(browser, vp, route) {
  const url = BASE + route.path;
  const context = await browser.newContext({ ...vp.opts, locale: "es-CO" });
  const page = await context.newPage();
  /** @type {{type:string,text:string}[]} */
  const consoleMsgs = [];
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {{url:string,status:number}[]} */
  const badResponses = [];
  /** @type {{url:string,err:string}[]} */
  const failedReqs = [];

  page.on("console", (m) => {
    const type = m.type();
    if (type !== "error" && type !== "warning") return;
    const text = m.text();
    if (isNoise(text)) return;
    consoleMsgs.push({ type, text: text.slice(0, 400) });
  });
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 400)));
  page.on("requestfailed", (r) => {
    const f = r.failure();
    const u = r.url();
    if (isNoise(u)) return;
    // aborted requests on navigation away are not real failures
    if (f && /ERR_ABORTED|net::ERR_ABORTED/.test(f.errorText)) return;
    failedReqs.push({ url: u.slice(0, 200), err: f?.errorText || "failed" });
  });
  page.on("response", (resp) => {
    const st = resp.status();
    if (st < 400) return;
    const u = resp.url();
    if (isNoise(u)) return;
    badResponses.push({ url: u.slice(0, 200), status: st });
  });

  let mainStatus = 0;
  let finalUrl = url;
  let navError = null;
  let bodyText = "";
  let title = "";
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    mainStatus = resp ? resp.status() : 0;
    await page.waitForTimeout(SETTLE_MS); // let client hydrate + fire any runtime errors
    finalUrl = page.url();
    title = await page.title().catch(() => "");
    bodyText = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(0, 4000);
  } catch (e) {
    navError = String(e?.message || e).slice(0, 300);
  }

  const redirected = finalUrl.replace(/\/$/, "") !== url.replace(/\/$/, "");
  const finalPath = (() => { try { return new URL(finalUrl).pathname; } catch { return finalUrl; } })();
  const clientCrash = /Application error|client-side exception|Internal Server Error|Unhandled Runtime Error/i.test(bodyText);
  const missingI18n = /MISSING_MESSAGE|IntlError/i.test(bodyText) || consoleMsgs.some((c) => /MISSING_MESSAGE|IntlError/i.test(c.text));

  // Severity
  const issues = [];
  if (navError) issues.push({ sev: "CRITICAL", msg: `navigation failed: ${navError}` });
  if (mainStatus >= 500) issues.push({ sev: "CRITICAL", msg: `main document ${mainStatus}` });
  for (const e of pageErrors) issues.push({ sev: "CRITICAL", msg: `pageerror: ${e}` });
  if (clientCrash) issues.push({ sev: "CRITICAL", msg: `client crash text in body` });
  if (missingI18n) issues.push({ sev: "WARNING", msg: `missing i18n message` });
  for (const c of consoleMsgs) issues.push({ sev: c.type === "error" ? "WARNING" : "WARNING", msg: `console.${c.type}: ${c.text}` });
  for (const b of badResponses) issues.push({ sev: b.status >= 500 ? "CRITICAL" : "WARNING", msg: `subreq ${b.status}: ${b.url}` });
  for (const r of failedReqs) issues.push({ sev: "WARNING", msg: `req failed (${r.err}): ${r.url}` });

  // Expectations
  if (route.kind === "gated") {
    if (!/\/signin/.test(finalPath) && mainStatus === 200 && !redirected) {
      issues.push({ sev: "INFO", msg: `gated route did NOT redirect to /signin (rendered ${mainStatus}) — auth gap?` });
    }
  }
  if (route.kind === "dynamic" && /expect 404/.test(route.note || "") && mainStatus >= 500) {
    issues.push({ sev: "CRITICAL", msg: `bad-id route 500'd instead of 404` });
  }

  results.push({
    viewport: vp.name,
    path: route.path,
    kind: route.kind,
    note: route.note || "",
    status: mainStatus,
    finalPath,
    redirected,
    title: title.slice(0, 80),
    issues,
  });

  await context.close();
}

async function main() {
  console.log(`\n🔎 MESAPAY crawl → ${BASE}\n`);
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    console.log(`\n──────── viewport: ${vp.name} ────────`);
    for (const route of ROUTES) {
      await crawlOne(browser, vp, route);
      const last = results[results.length - 1];
      const crit = last.issues.filter((i) => i.sev === "CRITICAL").length;
      const warn = last.issues.filter((i) => i.sev === "WARNING").length;
      const tag = crit ? "❌" : warn ? "⚠️ " : "✅";
      console.log(`${tag} [${String(last.status).padStart(3)}] ${route.path}${last.redirected ? ` → ${last.finalPath}` : ""}${crit ? `  (${crit} crit)` : ""}${warn ? ` (${warn} warn)` : ""}`);
      await new Promise((r) => setTimeout(r, 250)); // be gentle on prod
    }
  }
  await browser.close();

  // ---- Report ----
  const dir = path.join(process.cwd(), "e2e", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = process.env.CRAWL_STAMP || "latest";
  fs.writeFileSync(path.join(dir, `crawl-${stamp}.json`), JSON.stringify({ base: BASE, results }, null, 2));

  const all = results.flatMap((r) => r.issues.map((i) => ({ ...i, path: r.path, viewport: r.viewport, status: r.status })));
  const crit = all.filter((i) => i.sev === "CRITICAL");
  const warn = all.filter((i) => i.sev === "WARNING");
  const info = all.filter((i) => i.sev === "INFO");

  const md = [];
  md.push(`# MESAPAY crawl report`);
  md.push(`\n- Base: \`${BASE}\``);
  md.push(`- Routes × viewports: ${results.length}`);
  md.push(`- CRITICAL: ${crit.length} · WARNING: ${warn.length} · INFO: ${info.length}\n`);

  const group = (arr) => {
    const by = {};
    for (const i of arr) (by[i.path] ||= []).push(i);
    return by;
  };
  for (const [label, arr] of [["CRITICAL", crit], ["WARNING", warn], ["INFO", info]]) {
    md.push(`\n## ${label} (${arr.length})\n`);
    if (!arr.length) { md.push(`_none_`); continue; }
    const by = group(arr);
    for (const p of Object.keys(by)) {
      md.push(`\n### \`${p}\``);
      const seen = new Set();
      for (const i of by[p]) {
        const key = i.msg;
        if (seen.has(key)) continue;
        seen.add(key);
        md.push(`- (${i.viewport}, ${i.status}) ${i.msg}`);
      }
    }
  }
  fs.writeFileSync(path.join(dir, `crawl-${stamp}.md`), md.join("\n"));

  console.log(`\n📄 Report → e2e/reports/crawl-${stamp}.md`);
  console.log(`   CRITICAL ${crit.length} · WARNING ${warn.length} · INFO ${info.length}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
