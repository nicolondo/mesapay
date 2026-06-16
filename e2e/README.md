# MESAPAY end-to-end / health checks (Playwright)

## Read-only health crawl

`crawl.mjs` navigates a curated list of page routes in mobile + desktop viewports
and reports every runtime problem: uncaught exceptions, 5xx, client crashes,
console errors/warnings, failed sub-requests, missing i18n messages, and whether
auth-gated routes redirect to `/signin` as expected.

It is **read-only**: GET navigation only, never submits forms / logs in / clicks
action controls. Safe to run against production.

```bash
npm run crawl                          # crawls https://mesapay.co
npm run crawl -- http://localhost:3300 # crawls a local instance
CRAWL_STAMP=mytag npm run crawl        # names the report file
```

Reports are written to `e2e/reports/crawl-<stamp>.{md,json}` (gitignored).

## Spec-based E2E

`npx playwright test` (or `npm run e2e`) runs `e2e/*.spec.ts` against
`PLAYWRIGHT_BASE_URL` (default `http://localhost:3300`).

**Authenticated flows must run against a LOCAL instance with a LOCAL database —
never production.** Note `.env.local` points `DATABASE_URL` at the prod VPS, so
to test locally you must run the app with a local `DATABASE_URL` override and a
seeded local DB (`npm run db:seed` → accounts use password `mesapay123`).
