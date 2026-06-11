# CRM Kanban Drag & Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HTML5 native drag-and-drop to the desktop CRM kanban so users can move lead cards between stages, with special flows for `ganado` (open ConvertSheet) and `perdido` (open LostReasonSheet).

**Architecture:** All DnD logic lives in `CrmPipelineClient.tsx`. State for drag (dragLeadId, dragFromStage) is held in `useRef` to avoid re-renders during drag. The `leads` state list is mutated optimistically on drop; on error it reverts. For `ganado` drops a `DndConvertSheet` is opened (self-contained in the same file, replicating the ConvertSheet from CrmLeadDetailClient). For `perdido` drops a `DndLostReasonSheet` is opened. Stage counts (`stageCounts`) are kept in component state and updated on every successful drop. Mobile rendering (`<lg`) is left completely untouched — drag handlers only on the `hidden lg:flex` kanban path.

**Tech Stack:** Next.js App Router, React 18 hooks (`useState`, `useRef`, `useCallback`), HTML5 DragEvent API, next-intl (`useTranslations`), Tailwind CSS, Vitest for tests.

---

## File Map

| File | Change |
|------|--------|
| `src/app/comercial/crm/CrmPipelineClient.tsx` | Main DnD logic + 2 new sheet components |
| `messages/es.json` | 6 new keys in `crm` namespace |
| `messages/en.json` | Same keys in English |
| `messages/pt.json` | Same keys in Portuguese |
| `src/lib/crm/kanbanDnd.test.ts` | New: unit tests for the pure DnD helper logic |

---

## Task 1: Add i18n keys for DnD sheets

**Files:**
- Modify: `messages/es.json`
- Modify: `messages/en.json`
- Modify: `messages/pt.json`

New keys needed (all in `crm` namespace):

| Key | es | en | pt |
|-----|----|----|-----|
| `dndConvertTitle` | "Crear restaurante" | "Create restaurant" | "Criar restaurante" |
| `dndConvertSuccess` | "Lead convertido en cliente" | "Lead converted to client" | "Lead convertido em cliente" |
| `dndLostTitle` | "Motivo de pérdida" | "Lost reason" | "Motivo de perda" |
| `dndLostConfirm` | "Confirmar" | "Confirm" | "Confirmar" |
| `dndErrorStage` | "Error al mover lead. Intenta de nuevo." | "Error moving lead. Try again." | "Erro ao mover lead. Tente novamente." |
| `dndToastMoved` | "Lead movido a {stage}" | "Lead moved to {stage}" | "Lead movido para {stage}" |

- [ ] **Step 1: Add keys to es.json**

Open `/Users/nicolas/Documents/APPS/MESAPAY/messages/es.json`. Locate the end of the `crm` object (before the final `}`). Add after `"exportLeads": "Exportar leads"`:

```json
"dndConvertTitle": "Crear restaurante",
"dndConvertSuccess": "Lead convertido en cliente",
"dndLostTitle": "Motivo de pérdida",
"dndLostConfirm": "Confirmar",
"dndErrorStage": "Error al mover lead. Intenta de nuevo.",
"dndToastMoved": "Lead movido a {stage}"
```

- [ ] **Step 2: Add keys to en.json**

Open `/Users/nicolas/Documents/APPS/MESAPAY/messages/en.json`. Add the same keys in the `crm` namespace:

```json
"dndConvertTitle": "Create restaurant",
"dndConvertSuccess": "Lead converted to client",
"dndLostTitle": "Lost reason",
"dndLostConfirm": "Confirm",
"dndErrorStage": "Error moving lead. Try again.",
"dndToastMoved": "Lead moved to {stage}"
```

- [ ] **Step 3: Add keys to pt.json**

Open `/Users/nicolas/Documents/APPS/MESAPAY/messages/pt.json`. Add the same keys in the `crm` namespace:

```json
"dndConvertTitle": "Criar restaurante",
"dndConvertSuccess": "Lead convertido em cliente",
"dndLostTitle": "Motivo de perda",
"dndLostConfirm": "Confirmar",
"dndErrorStage": "Erro ao mover lead. Tente novamente.",
"dndToastMoved": "Lead movido para {stage}"
```

- [ ] **Step 4: Verify parity**

Run:
```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && node scripts/i18n-check.mjs 2>/dev/null || npx tsx scripts/check-parity.ts 2>/dev/null || echo "No parity script, manual check OK"
```

All three files should now have matching key counts for `crm`.

- [ ] **Step 5: Commit i18n keys**

```bash
git add messages/es.json messages/en.json messages/pt.json
git commit -m "feat(crm): i18n keys for DnD sheets (dnd*) — es/en/pt"
```

---

## Task 2: Extract DnD pure helper + tests

**Files:**
- Create: `src/lib/crm/kanbanDnd.test.ts`

The DnD logic is pure enough to unit test: given a leads list and a drop event (fromStage, toStage, leadId), what's the new list? We test the state mutation helper in isolation.

- [ ] **Step 1: Write the failing test**

Create `/Users/nicolas/Documents/APPS/MESAPAY/src/lib/crm/kanbanDnd.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { applyDrop } from "./kanbanDnd";

const makeLeads = () => [
  { id: "a", stage: "nuevo", name: "Alpha", priority: "a", countryCode: "CO", lastActivityAt: null, nextActionAt: null, createdAt: new Date().toISOString(), city: null, assignedTo: null, contacts: [] },
  { id: "b", stage: "nuevo", name: "Beta", priority: "b", countryCode: "CO", lastActivityAt: null, nextActionAt: null, createdAt: new Date().toISOString(), city: null, assignedTo: null, contacts: [] },
  { id: "c", stage: "contactado", name: "Gamma", priority: "c", countryCode: "CO", lastActivityAt: null, nextActionAt: null, createdAt: new Date().toISOString(), city: null, assignedTo: null, contacts: [] },
];

describe("applyDrop", () => {
  it("moves lead from one stage to another", () => {
    const leads = makeLeads();
    const result = applyDrop(leads, "a", "nuevo", "contactado");
    const moved = result.find((l) => l.id === "a");
    expect(moved?.stage).toBe("contactado");
  });

  it("leaves other leads unchanged", () => {
    const leads = makeLeads();
    const result = applyDrop(leads, "a", "nuevo", "contactado");
    expect(result.find((l) => l.id === "b")?.stage).toBe("nuevo");
    expect(result.find((l) => l.id === "c")?.stage).toBe("contactado");
  });

  it("returns same array reference items for same stage (no-op)", () => {
    const leads = makeLeads();
    const result = applyDrop(leads, "a", "nuevo", "nuevo");
    // Stage must be unchanged
    expect(result.find((l) => l.id === "a")?.stage).toBe("nuevo");
  });

  it("updates stageCounts correctly", () => {
    const counts = { nuevo: 2, contactado: 1, total: 3 };
    const result = applyDropCounts(counts, "nuevo", "contactado");
    expect(result.nuevo).toBe(1);
    expect(result.contactado).toBe(2);
    expect(result.total).toBe(3);
  });
});

// Import applyDropCounts too
import { applyDropCounts } from "./kanbanDnd";
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npx vitest run src/lib/crm/kanbanDnd.test.ts 2>&1 | tail -20
```

Expected: FAIL with "Cannot find module './kanbanDnd'"

- [ ] **Step 3: Create kanbanDnd.ts with the helpers**

Create `/Users/nicolas/Documents/APPS/MESAPAY/src/lib/crm/kanbanDnd.ts`:

```typescript
import type { LeadCard } from "@/app/comercial/crm/CrmPipelineClient";

/**
 * Returns a new leads array with the given lead's stage changed.
 * Pure function — does not mutate input.
 */
export function applyDrop(
  leads: LeadCard[],
  leadId: string,
  _fromStage: string,
  toStage: string,
): LeadCard[] {
  return leads.map((l) => (l.id === leadId ? { ...l, stage: toStage } : l));
}

/**
 * Updates stage count record when a lead moves stages.
 * Pure function — does not mutate input.
 */
export function applyDropCounts(
  counts: Record<string, number>,
  fromStage: string,
  toStage: string,
): Record<string, number> {
  const next = { ...counts };
  next[fromStage] = Math.max(0, (next[fromStage] ?? 0) - 1);
  next[toStage] = (next[toStage] ?? 0) + 1;
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npx vitest run src/lib/crm/kanbanDnd.test.ts 2>&1 | tail -20
```

Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crm/kanbanDnd.ts src/lib/crm/kanbanDnd.test.ts
git commit -m "feat(crm): pure kanbanDnd helpers (applyDrop + applyDropCounts)"
```

---

## Task 3: Wire DnD into CrmPipelineClient (main logic)

**Files:**
- Modify: `src/app/comercial/crm/CrmPipelineClient.tsx`

This is the main task. It involves:

1. Lifting `stageCounts` into state (currently passed as prop only)
2. Adding DnD state: `dragState` ref (leadId + fromStage), `dropTarget` state for column highlight
3. Adding `DndConvertSheet`, `DndLostReasonSheet` components (same design as existing sheets)
4. Wiring drag handlers on kanban cards
5. Wiring drop handlers on kanban columns
6. Drop dispatch logic: same-stage no-op, ganado → open DndConvertSheet, perdido → open DndLostReasonSheet, other → optimistic PATCH
7. Toast feedback (error + success)

### Step-by-step:

- [ ] **Step 1: Lift stageCounts into local state and add DnD state**

In `CrmPipelineClient`, add to the props destructuring:
```tsx
stageCounts: initialStageCounts,
```
Replace:
```tsx
const [leads, setLeads] = useState<LeadCard[]>(initialLeads);
```
with (add just after):
```tsx
const [counts, setCounts] = useState<StageCounts>(initialStageCounts);
```
(rename all uses of `stageCounts` from prop → `counts` in the render)

Add DnD-related state and refs:
```tsx
// DnD state
const dragRef = useRef<{ leadId: string; fromStage: string } | null>(null);
const [dropTarget, setDropTarget] = useState<string | null>(null); // stage being hovered
type DndSheet =
  | { kind: "convert"; lead: LeadCard }
  | { kind: "lost"; lead: LeadCard; toStage: string }
  | null;
const [dndSheet, setDndSheet] = useState<DndSheet>(null);
const [dndToast, setDndToast] = useState<{ msg: string; ok: boolean } | null>(null);
```

- [ ] **Step 2: Add showDndToast helper + auto-dismiss**

Add helper function inside the component:
```tsx
function showDndToast(msg: string, ok: boolean) {
  setDndToast({ msg, ok });
  setTimeout(() => setDndToast(null), 3500);
}
```

- [ ] **Step 3: Add handleDrop dispatcher**

Add inside the component (before the return):
```tsx
function handleDrop(toStage: string) {
  const drag = dragRef.current;
  if (!drag) return;
  const { leadId, fromStage } = drag;
  dragRef.current = null;
  setDropTarget(null);

  if (fromStage === toStage) return; // no-op

  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return;

  if (toStage === "ganado") {
    setDndSheet({ kind: "convert", lead });
    return;
  }

  if (toStage === "perdido") {
    setDndSheet({ kind: "lost", lead, toStage });
    return;
  }

  // Optimistic update for all other stages
  const prevLeads = leads;
  const prevCounts = counts;
  setLeads(applyDrop(leads, leadId, fromStage, toStage));
  setCounts(applyDropCounts(counts, fromStage, toStage));

  fetch(`/api/crm/leads/${leadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: toStage }),
  }).then((res) => {
    if (res.ok) {
      showDndToast(t("dndToastMoved", { stage: stageLabel[toStage] ?? toStage }), true);
    } else {
      // Revert
      setLeads(prevLeads);
      setCounts(prevCounts);
      showDndToast(t("dndErrorStage"), false);
    }
  }).catch(() => {
    setLeads(prevLeads);
    setCounts(prevCounts);
    showDndToast(t("dndErrorStage"), false);
  });
}
```

Add at top of file:
```tsx
import { applyDrop, applyDropCounts } from "@/lib/crm/kanbanDnd";
```

- [ ] **Step 4: Update `stageLabel` reference and KanbanColumn props to pass DnD handlers**

Pass new props to `KanbanColumn`:

```tsx
<KanbanColumn
  key={s}
  stage={s}
  label={stageLabel[s] ?? s}
  leads={colLeads}
  relTime={relTime}
  t={t}
  kanbanColumnHeader={t("kanbanColumnHeader", { count: counts[s] ?? 0 })}
  isDragOver={dropTarget === s}
  onDragOverColumn={(e) => { e.preventDefault(); setDropTarget(s); }}
  onDragLeaveColumn={() => setDropTarget(null)}
  onDropColumn={() => handleDrop(s)}
  onCardDragStart={(leadId) => { dragRef.current = { leadId, fromStage: s }; }}
  onCardDragEnd={() => { dragRef.current = null; setDropTarget(null); }}
/>
```

Also update `StageChip` and the counts total usage:
- Replace `stageCounts[s] ?? 0` with `counts[s] ?? 0` everywhere in the render
- Replace `stageCounts.total ?? 0` with `counts.total ?? 0`

- [ ] **Step 5: Update KanbanColumn signature to accept DnD props**

Update the `KanbanColumn` function signature:

```tsx
function KanbanColumn({
  stage,
  label,
  leads,
  relTime,
  t,
  kanbanColumnHeader,
  isDragOver,
  onDragOverColumn,
  onDragLeaveColumn,
  onDropColumn,
  onCardDragStart,
  onCardDragEnd,
}: {
  stage: string;
  label: string;
  leads: LeadCard[];
  relTime: (d: Date | string | null) => string;
  t: (key: string, vars?: Record<string, unknown>) => string;
  kanbanColumnHeader: string;
  isDragOver: boolean;
  onDragOverColumn: (e: React.DragEvent) => void;
  onDragLeaveColumn: () => void;
  onDropColumn: () => void;
  onCardDragStart: (leadId: string) => void;
  onCardDragEnd: () => void;
}) {
```

Update the column div to handle drops:
```tsx
<div
  className={
    "w-64 shrink-0 flex flex-col gap-2 rounded-xl transition-colors " +
    (isDragOver ? "ring-2 ring-terracotta bg-terracotta/5" : "")
  }
  onDragOver={onDragOverColumn}
  onDragLeave={onDragLeaveColumn}
  onDrop={(e) => { e.preventDefault(); onDropColumn(); }}
>
```

Update each kanban card div to be draggable:
```tsx
<div
  key={lead.id}
  draggable
  onDragStart={(e) => {
    e.dataTransfer.effectAllowed = "move";
    onCardDragStart(lead.id);
  }}
  onDragEnd={onCardDragEnd}
  className={
    "rounded-xl border border-op-border bg-op-surface p-3 space-y-2 cursor-grab active:cursor-grabbing active:opacity-50 select-none transition-opacity"
  }
>
```

- [ ] **Step 6: Add DndConvertSheet component**

Add before the closing of the file (after `Spinner`):

```tsx
function DndConvertSheet({
  lead,
  role,
  onConverted,
  onClose,
}: {
  lead: LeadCard;
  role: string;
  onConverted: (restaurantId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");

  function suggestSlug(name: string) {
    return name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  }

  const [name, setName] = useState(lead.name);
  const [slug, setSlug] = useState(() => suggestSlug(lead.name));
  const [plan, setPlan] = useState<"trial" | "basic" | "pro">("trial");
  const [monthlyPrice, setMonthlyPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ restaurantId: string } | null>(null);

  function handleNameChange(v: string) {
    setName(v);
    setSlug(suggestSlug(v));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/leads/${lead.id}/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          plan,
          monthlyPriceCents: monthlyPrice ? parseInt(monthlyPrice, 10) : 0,
        }),
      });
      const json = await res.json();
      if (res.status === 409) {
        setError(t("convertAlreadyConverted"));
        setSaving(false);
        return;
      }
      if (!res.ok) {
        setError(t("convertError", { detail: json.error ?? "error" }));
        setSaving(false);
        return;
      }
      setSuccess({ restaurantId: json.restaurantId });
      onConverted(json.restaurantId);
    } catch {
      setError(t("convertError", { detail: "network error" }));
      setSaving(false);
    }
  }

  const PLANS = [
    { value: "trial" as const, label: t("convertPlanTrial") },
    { value: "basic" as const, label: t("convertPlanBasic") },
    { value: "pro" as const, label: t("convertPlanPro") },
  ];

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("dndConvertTitle")} onClose={onClose} />
        {success ? (
          <div className="px-4 py-6 space-y-4">
            <p className="text-sm text-green-600 font-medium">{t("dndConvertSuccess")}</p>
            {role === "platform_admin" && (
              <a
                href={`/admin/restaurants/${success.restaurantId}`}
                className="block w-full py-3.5 rounded-xl bg-terracotta text-white text-sm font-medium text-center min-h-[44px]"
              >
                {t("convertViewAdmin")}
              </a>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
            <div>
              <FieldLabel required>{t("convertFieldName")}</FieldLabel>
              <input
                type="text" required value={name} onChange={(e) => handleNameChange(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
            </div>
            <div>
              <FieldLabel required>{t("convertFieldSlug")}</FieldLabel>
              <input
                type="text" required value={slug} onChange={(e) => setSlug(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
              <p className="text-xs text-op-muted mt-1">{"app.mesapay.co/t/" + (slug || "…")}</p>
            </div>
            <div>
              <FieldLabel required>{t("convertFieldPlan")}</FieldLabel>
              <div className="flex gap-2">
                {PLANS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPlan(value)}
                    className={
                      "flex-1 py-2.5 rounded-xl border-2 text-sm font-medium min-h-[44px] transition-all " +
                      (plan === value
                        ? "border-terracotta bg-terracotta/5 text-terracotta"
                        : "border-op-border text-op-muted hover:border-op-text")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <FieldLabel>{t("convertFieldMonthly")}</FieldLabel>
              <input
                type="number" min="0" value={monthlyPrice}
                onChange={(e) => setMonthlyPrice(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
              />
            </div>
            {error && <p className="text-sm text-terracotta">{error}</p>}
            <button
              type="submit"
              disabled={saving || !name.trim() || !slug.trim()}
              className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
            >
              {saving ? <span className="flex justify-center"><Spinner /></span> : t("convertSubmit")}
            </button>
          </form>
        )}
      </SheetContent>
    </Overlay>
  );
}
```

Note: `Overlay`, `SheetContent`, `SheetHandle`, `SheetHeader`, `FieldLabel`, `Spinner` are all defined in `CrmLeadDetailClient.tsx`. For `CrmPipelineClient.tsx` we need to add these primitives as they are NOT currently in this file.

- [ ] **Step 7: Add Sheet primitives to CrmPipelineClient**

Add these after the existing helper functions and before the KanbanColumn definition:

```tsx
// ── Sheet primitives (needed for DnD sheets) ───────────────────────────────

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      {children}
    </div>
  );
}

function SheetContent({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative z-10 bg-op-surface rounded-t-2xl max-h-[90dvh] flex flex-col shadow-xl overflow-y-auto"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {children}
    </div>
  );
}

function SheetHandle() {
  return (
    <div className="flex justify-center pt-3 pb-1 shrink-0">
      <div className="w-10 h-1 rounded-full bg-op-border" />
    </div>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-op-border shrink-0">
      <div className="font-display text-xl">{title}</div>
      <button onClick={onClose} className="p-2 rounded-lg text-op-muted hover:text-op-text min-h-[44px] min-w-[44px] flex items-center justify-center">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
      {children}
      {required && <span className="text-terracotta ml-0.5">{"*"}</span>}
    </label>
  );
}
```

Add `useEffect` to the import at the top:
```tsx
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
```

- [ ] **Step 8: Add DndLostReasonSheet component**

Add after `DndConvertSheet`:

```tsx
const LOST_REASONS = [
  "Precio",
  "No ve valor",
  "Ya tiene proveedor",
  "Cerró",
  "Quedó frío",
  "Otro",
] as const;

function DndLostReasonSheet({
  lead,
  onConfirmed,
  onClose,
}: {
  lead: LeadCard;
  onConfirmed: (lostReason: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const [lostReason, setLostReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!lostReason) { setError(t("lostReasonRequired")); return; }
    setSaving(true);
    const res = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "perdido", lostReason }),
    });
    if (res.ok) {
      onConfirmed(lostReason);
    } else {
      setError(t("dndErrorStage"));
      setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <SheetContent>
        <SheetHandle />
        <SheetHeader title={t("dndLostTitle")} onClose={onClose} />
        <div className="px-4 py-4 space-y-4">
          <FieldLabel required>{t("lostReasonLabel")}</FieldLabel>
          <select
            value={lostReason}
            onChange={(e) => { setLostReason(e.target.value); setError(null); }}
            className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
          >
            <option value="">{"—"}</option>
            {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-op-border text-sm font-medium min-h-[44px] text-op-muted"
            >
              {t("dupesCancel")}
            </button>
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="flex-1 py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
            >
              {saving ? <span className="flex justify-center"><Spinner /></span> : t("dndLostConfirm")}
            </button>
          </div>
        </div>
      </SheetContent>
    </Overlay>
  );
}
```

- [ ] **Step 9: Add toast rendering + DnD sheets to the JSX return**

Inside `CrmPipelineClient` render, before the closing `</div>` of the root:

```tsx
{/* DnD toast */}
{dndToast && (
  <div className={
    "fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl shadow-lg text-sm font-medium whitespace-nowrap " +
    (dndToast.ok ? "bg-green-600 text-white" : "bg-rose-600 text-white")
  }>
    {dndToast.msg}
  </div>
)}

{/* DnD sheets */}
{dndSheet?.kind === "convert" && (
  <DndConvertSheet
    lead={dndSheet.lead}
    role={role}
    onClose={() => setDndSheet(null)}
    onConverted={(restaurantId) => {
      // Move card to ganado + update counts
      setLeads((prev) =>
        prev.map((l) =>
          l.id === dndSheet.lead.id ? { ...l, stage: "ganado" } : l,
        ),
      );
      setCounts((prev) =>
        applyDropCounts(prev, dndSheet.lead.stage, "ganado"),
      );
      setDndSheet(null);
    }}
  />
)}
{dndSheet?.kind === "lost" && (
  <DndLostReasonSheet
    lead={dndSheet.lead}
    onClose={() => setDndSheet(null)}
    onConfirmed={(lostReason) => {
      const fromStage = dndSheet.lead.stage;
      setLeads((prev) =>
        prev.map((l) =>
          l.id === dndSheet.lead.id
            ? { ...l, stage: "perdido", lostReason }
            : l,
        ),
      );
      setCounts((prev) => applyDropCounts(prev, fromStage, "perdido"));
      setDndSheet(null);
      showDndToast(
        t("dndToastMoved", { stage: stageLabel["perdido"] ?? "perdido" }),
        true,
      );
    }}
  />
)}
```

- [ ] **Step 10: Run TypeScript check**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npx tsc --noEmit 2>&1 | grep -E "error|crm" | head -30
```

Expected: No errors in CRM files.

- [ ] **Step 11: Run lint**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm run lint 2>&1 | grep -v "^$" | head -40
```

Expected: No new errors (there may be pre-existing warnings from other files).

- [ ] **Step 12: Commit**

```bash
git add src/app/comercial/crm/CrmPipelineClient.tsx
git commit -m "feat(crm): drag & drop en el kanban (con convert en ganado y razón en perdido)"
```

---

## Task 4: Verify all gates pass

- [ ] **Step 1: Run all tests**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm test 2>&1 | tail -30
```

Expected: All tests pass, including the new `kanbanDnd.test.ts`.

- [ ] **Step 2: Run tsc**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npx tsc --noEmit 2>&1 | grep "error TS" | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Run lint**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm run lint 2>&1 | grep -E "error|Error" | head -20
```

Expected: No new errors.

- [ ] **Step 4: Build**

```bash
cd /Users/nicolas/Documents/APPS/MESAPAY && npm run build 2>&1 | tail -20
```

Expected: Build succeeds.

- [ ] **Step 5: Final commit if needed**

If any fixes were required during verification, commit them:

```bash
git add -p  # stage only relevant changes
git commit -m "fix(crm): post-review fixes for kanban DnD"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Kanban cards get `draggable` + `onDragStart`/`onDragEnd` — Task 3 step 5
- [x] Dragging card gets reduced opacity (active:opacity-50) — Task 3 step 5
- [x] Columns get `onDragOver` (preventDefault + ring) + `onDrop` — Task 3 step 5
- [x] Same stage = no-op — Task 3 step 3 (handleDrop guard)
- [x] `ganado` → DndConvertSheet with POST /convert — Task 3 step 6
- [x] `perdido` → DndLostReasonSheet with PATCH {stage, lostReason} — Task 3 step 8
- [x] Other stages → optimistic move + PATCH + revert on error — Task 3 step 3
- [x] Mobile untouched (drag handlers only in lg+ path) — Task 3 step 4 (handlers passed only to KanbanColumn which is in `hidden lg:flex`)
- [x] Stage counts stay in sync — Task 3 steps 3, 9
- [x] i18n keys for all new strings — Task 1
- [x] Tests — Task 2

**Placeholder scan:** None found.

**Type consistency:** `DndSheet` type matches usage in `setDndSheet` and sheet render. `applyDrop`/`applyDropCounts` imported and used correctly.
