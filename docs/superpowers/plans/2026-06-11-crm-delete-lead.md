# CRM Delete Lead Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "delete lead" action to the CRM with server-side guards (no converted clients), scope-gating, audit trail, and full i18n parity.

**Architecture:** Single DELETE handler added to the existing `route.ts` alongside GET/PATCH; a danger-zone button placed at the bottom of `CrmLeadDetailClient.tsx`; four new i18n keys in the `crm` namespace synced across es/en/pt.

**Tech Stack:** Next.js App Router (Route Handler), Prisma (transaction + cascade), next-intl, TypeScript

---

## Cascade Audit (pre-condition, already verified)

All child models already have `onDelete: Cascade` on their `leadId` FK:
- `CrmContact` (schema line 1583)
- `CrmActivity` (schema line 1599)
- `CrmAppointment` (schema line 1615)

**Conclusion:** A plain `db.crmLead.delete()` is safe — no explicit child deletion needed. No schema migration required.

---

## Branch Setup

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY
git fetch origin && git checkout -b feat/crm-delete-lead origin/main
```

---

## File Map

| Action | File |
|--------|------|
| **Modify** | `src/app/api/crm/leads/[id]/route.ts` — add `export async function DELETE` |
| **Modify** | `src/lib/auditLog.ts` — add `"crm.lead.delete"` to `AuditKind` union and `AUDIT_KIND_LABEL` map |
| **Modify** | `src/app/comercial/crm/[id]/CrmLeadDetailClient.tsx` — add danger-zone delete button at bottom of page |
| **Modify** | `messages/es.json` — add 4 keys to `crm` namespace |
| **Run** | `npm run i18n:sync` — auto-translate to `en.json` and `pt.json` |

---

## Task 1: Add `crm.lead.delete` to auditLog

**Files:**
- Modify: `src/lib/auditLog.ts`

- [ ] **Step 1: Add the kind to the AuditKind union**

In `src/lib/auditLog.ts`, find:
```typescript
  | "crm.lead.convert"
  | "crm.lead.reassign"
  | "crm.export"
```
Replace with:
```typescript
  | "crm.lead.convert"
  | "crm.lead.reassign"
  | "crm.lead.delete"
  | "crm.export"
```

- [ ] **Step 2: Add the human-readable label**

In `src/lib/auditLog.ts`, find:
```typescript
  "crm.lead.convert": "Convirtió lead en restaurante",
  "crm.lead.reassign": "Reasignó lead",
  "crm.export": "Exportó leads CRM",
```
Replace with:
```typescript
  "crm.lead.convert": "Convirtió lead en restaurante",
  "crm.lead.reassign": "Reasignó lead",
  "crm.lead.delete": "Eliminó lead",
  "crm.export": "Exportó leads CRM",
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npx tsc --noEmit 2>&1 | head -30
```
Expected: 0 errors (or pre-existing errors only — count must not increase).

---

## Task 2: Add DELETE handler to `/api/crm/leads/[id]/route.ts`

**Files:**
- Modify: `src/app/api/crm/leads/[id]/route.ts`

- [ ] **Step 1: Append the DELETE export at the end of the file**

Add the following after the closing brace of the `PATCH` export (at end of file):

```typescript
// ── DELETE /api/crm/leads/[id] ───────────────────────────────────────────────

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const lead = await getLeadInScope(id, ctx.visibleUserIds);
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Guard: converted leads (restaurantId set) or won leads cannot be deleted.
  if (lead.restaurantId !== null || lead.stage === "ganado") {
    return NextResponse.json({ error: "converted_lead" }, { status: 409 });
  }

  // All children (CrmContact, CrmActivity, CrmAppointment) cascade automatically.
  await db.crmLead.delete({ where: { id } });

  await recordAuditEvent({
    kind: "crm.lead.delete",
    summary: `Eliminó lead "${lead.name}" (${id})`,
    target: { type: "crm_lead", id },
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npx tsc --noEmit 2>&1 | head -30
```
Expected: 0 errors (or same baseline as before).

---

## Task 3: Add i18n keys to `es.json`

**Files:**
- Modify: `messages/es.json`

- [ ] **Step 1: Add 4 new keys to the `crm` namespace**

In `messages/es.json`, find the last key pair in the `crm` namespace (currently):
```json
    "pushBannerEnable": "Activar",
    "pushBannerEnabling": "Activando…"
  }
```
Replace with:
```json
    "pushBannerEnable": "Activar",
    "pushBannerEnabling": "Activando…",
    "deleteLeadBtn": "Eliminar lead",
    "deleteLeadConfirm": "¿Eliminar permanentemente el lead \"{name}\"? Esta acción no se puede deshacer.",
    "deleteLeadConverted": "Este lead ya tiene un restaurante vinculado y no puede eliminarse.",
    "deleteLeadError": "Error al eliminar el lead. Intenta de nuevo."
  }
```

- [ ] **Step 2: Sync translations to en + pt**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm run i18n:sync 2>&1 | tail -20
```
Expected: Script reports the 4 new keys translated for `en` and `pt`. Check that `messages/en.json` and `messages/pt.json` now contain `deleteLeadBtn`, `deleteLeadConfirm`, `deleteLeadConverted`, `deleteLeadError`.

- [ ] **Step 3: Verify parity**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm run i18n:sync -- --check 2>&1 | tail -10
```
Or manually confirm the key counts match across the three files:
```bash
grep -c '"deleteLeadBtn"' /Users/nicolas/Documents/APPS/MESAPAY/messages/es.json
grep -c '"deleteLeadBtn"' /Users/nicolas/Documents/APPS/MESAPAY/messages/en.json
grep -c '"deleteLeadBtn"' /Users/nicolas/Documents/APPS/MESAPAY/messages/pt.json
```
Expected: `1` in each file.

---

## Task 4: Add danger-zone delete button in `CrmLeadDetailClient.tsx`

**Files:**
- Modify: `src/app/comercial/crm/[id]/CrmLeadDetailClient.tsx`

The delete button must:
- Only render when `lead.restaurantId` is `null` AND `lead.stage !== "ganado"` (mirrors the API guard exactly)
- Live at the very bottom of the scrollable `flex-1 overflow-y-auto` div (after the Timeline section, before closing `</div>`)
- Use `window.confirm` with the i18n key `deleteLeadConfirm` (interpolated with `lead.name`)
- Navigate to `/comercial/crm` on success via `router.push`
- Show the `deleteLeadConverted` message if the API returns 409 (defensive; button should already be hidden)
- Show `deleteLeadError` on any other failure

- [ ] **Step 1: Add a `deleting` state variable**

In `CrmLeadDetailClient` (the main component, around line 1326), after:
```typescript
  const [editingContact, setEditingContact] = useState<ContactData | null>(null);
```
Add:
```typescript
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
```

- [ ] **Step 2: Add the `handleDelete` async function**

After the `isOverdue` function (around line 1346), add:
```typescript
  async function handleDelete() {
    const confirmed = window.confirm(t("deleteLeadConfirm", { name: lead.name }));
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/crm/leads/${lead.id}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/comercial/crm");
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 || json.error === "converted_lead") {
        setDeleteError(t("deleteLeadConverted"));
      } else {
        setDeleteError(t("deleteLeadError"));
      }
    } catch {
      setDeleteError(t("deleteLeadError"));
    } finally {
      setDeleting(false);
    }
  }
```

- [ ] **Step 3: Add the danger-zone section at the bottom of the scrollable area**

In the scrollable `<div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 pb-24">`, find the closing tag `</div>` that comes right before the sticky bar comment `{/* ── Sticky add activity... */}`. This is after the Timeline section closing `</section>`.

After the Timeline section's closing `</section>` and before the outer `</div>`, add:

```tsx
        {/* ── Danger zone ── */}
        {!lead.restaurantId && lead.stage !== "ganado" && (
          <section className="pt-4 border-t border-op-border">
            {deleteError && (
              <p className="text-sm text-rose-600 mb-3">{deleteError}</p>
            )}
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full py-3.5 rounded-xl border border-rose-200 text-rose-600 text-sm font-medium min-h-[44px] hover:bg-rose-50 transition-colors disabled:opacity-50"
            >
              {deleting ? <span className="flex justify-center"><Spinner /></span> : t("deleteLeadBtn")}
            </button>
          </section>
        )}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npx tsc --noEmit 2>&1 | head -30
```
Expected: 0 new errors.

---

## Task 5: Run tests and build

- [ ] **Step 1: Run tests**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm test 2>&1 | tail -30
```
Expected: All tests pass (or same failures as baseline — do not introduce new failures).

- [ ] **Step 2: Run full build**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm run build 2>&1 | tail -40
```
Expected: Build completes successfully with no TypeScript errors and no new warnings.

- [ ] **Step 3: Lint check**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm run lint 2>&1 | tail -20
```
Expected: No new lint errors. The `CrmLeadDetailClient.tsx` file is not in the MIGRATED glob so no literal-string lint applies.

---

## Task 6: Commit

- [ ] **Step 1: Stage only the modified files explicitly**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && git add \
  src/app/api/crm/leads/[id]/route.ts \
  src/lib/auditLog.ts \
  "src/app/comercial/crm/[id]/CrmLeadDetailClient.tsx" \
  messages/es.json \
  messages/en.json \
  messages/pt.json
```

- [ ] **Step 2: Commit**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && git commit -m "$(cat <<'EOF'
feat(crm): eliminar lead (con guardas para clientes convertidos)

- DELETE /api/crm/leads/[id]: scope-gated (visibleUserIds), returns 409
  when lead has restaurantId set or stage === ganado
- Children cascade automatically (CrmContact/Activity/Appointment all
  have onDelete: Cascade) — no explicit child deletion needed
- recordAuditEvent kind crm.lead.delete with lead name in summary
- Danger-zone button at bottom of CrmLeadDetailClient (hidden when
  converted/ganado); window.confirm with lead name interpolated
- router.push to /comercial/crm on success; 409 shows converted message
- i18n: 4 new keys in crm namespace, synced to en + pt via i18n:sync

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify commit**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && git log --oneline -3
```
Expected: The new commit appears at the top.

---

## Self-Review Checklist

### Spec coverage

| Requirement | Task |
|-------------|------|
| DELETE handler in route.ts | Task 2 |
| Gate: lead.assignedToUserId ∈ visibleUserIds (or admin) — via `getLeadInScope` | Task 2 (uses same helper as PATCH) |
| Guard: restaurantId != null OR stage === "ganado" → 409 `{error:"converted_lead"}` | Task 2 |
| Delete in transaction (cascade handles children) | Task 2 (single delete, cascade) |
| recordAuditEvent kind `crm.lead.delete` | Task 2 |
| Return `{ok:true}` | Task 2 |
| UI: button at bottom, danger zone style, red text | Task 4 |
| ≥44px touch target | Task 4 (min-h-[44px]) |
| window.confirm with lead name interpolation | Task 4 |
| On success → router.push("/comercial/crm") | Task 4 |
| 409 → show deleteLeadConverted message | Task 4 |
| Hide button when restaurantId set or stage ganado | Task 4 |
| i18n keys: deleteLeadBtn, deleteLeadConfirm{name}, deleteLeadConverted, deleteLeadError | Task 3 |
| en + pt parity | Task 3 (i18n:sync) |
| npm test green | Task 5 |
| npx tsc --noEmit clean | Tasks 1, 2, 4 (each step) |
| npm run build OK | Task 5 |
| Commit with explicit paths (no git add -A) | Task 6 |
| Kind `crm.lead.delete` in AuditKind + AUDIT_KIND_LABEL | Task 1 |

All requirements covered. No placeholders. No TBD items.
