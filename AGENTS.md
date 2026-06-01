<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# MESAPAY is trilingual — es / en / pt (MANDATORY)

Every user-facing string MUST go through i18n. **Never hardcode Spanish (or any language) text in JSX, pages, emails, receipts, toasts, or client-shown API messages.**

- Stack: `next-intl`, *no URL routing* — locale lives in the `MESAPAY_LOCALE` cookie (routing already uses subdomains). Catalogs in `messages/{es,en,pt}.json`; `es.json` is the source of truth.
- Server: `const t = await getTranslations("ns")`. Client: `const t = useTranslations("ns")`. Money/dates: use `@/lib/format` (`formatMoney`/`formatDate`) — never new `toLocaleString("es-CO")`. Currency = restaurant's country; locale = language. Keep them separate.
- After adding keys to `es.json`, fill the other two: `npm run i18n:sync` (needs `ANTHROPIC_API_KEY`). Never leave a key Spanish-only.
- Restaurant-entered DB content (dish names, etc.) is translated via `@/lib/translateContent` (`getContentTranslations`), not catalogs.
- Guardrail: `eslint.config.mjs` runs `i18next/no-literal-string` on the `MIGRATED` globs. When a file is fully migrated, add its glob there — then `npm run lint` blocks any re-introduced literal text.
- **Full workflow + checklist: invoke the `mesapay-i18n` skill.** Follow it whenever you add or edit UI.
