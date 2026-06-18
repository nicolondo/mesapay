"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";
import type { CashSnapshot } from "@/lib/cashBox";

/**
 * Vista de caja en vivo, compartida por operator (Cierre) y admin
 * (detalle del comercio). Se suscribe al bus SSE del comercio y
 * re-fetchea el snapshot ante cualquier evento (cobro, egreso, turno).
 *
 * `snapshotUrl` / `movementUrl` cambian según la superficie:
 *   operator → /api/operator/cash/{snapshot,movement}
 *   admin    → /api/admin/restaurants/[id]/cash/{snapshot,movement}
 */
export function CashBox({
  initial,
  snapshotUrl,
  movementUrl,
  baseUrl,
  tenantSlug,
}: {
  initial: CashSnapshot;
  snapshotUrl: string;
  movementUrl: string;
  // Cuando se pasa, habilita editar la base del local y de cada mesero
  // (solo operator). Admin no lo pasa → la caja queda en solo-lectura.
  baseUrl?: string;
  tenantSlug: string;
}) {
  const t = useTranslations("cashBox");
  const [snap, setSnap] = useState<CashSnapshot>(initial);
  const lastRef = useRef(0);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch(snapshotUrl);
      if (r.ok) setSnap((await r.json()) as CashSnapshot);
    } catch {}
  }, [snapshotUrl]);

  // Refresco instantáneo por SSE: ante cualquier evento del comercio
  // (cobro, egreso/ingreso, apertura/cierre de turno) re-fetcheamos.
  useVisibleEventSource(
    `/api/tenant/${tenantSlug}/events`,
    (es) =>
      es.addEventListener("message", () => {
        const now = Date.now();
        if (now - lastRef.current < 600) return;
        lastRef.current = now;
        void refetch();
      }),
    () => void refetch(),
  );

  const byWaiter = snap.shiftPolicy === "by_waiter";
  const g = snap.general;

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          {t("title")}
        </div>
        {snap.open && (
          <EgresoButton movementUrl={movementUrl} onDone={refetch} t={t} />
        )}
      </div>

      {!snap.open ? (
        <div className="text-sm text-op-muted">{t("closed")}</div>
      ) : (
        <>
          {/* Caja general */}
          <div className="rounded-xl border border-op-border bg-op-bg/40 p-4">
            <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
              {t("balance")}
            </div>
            <div className="font-display text-3xl tabular mt-0.5">
              {fmtCOP(g.balanceCents)}
            </div>
            <div className="mt-3 space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-op-muted">{t("opening")}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono tabular">
                    {fmtCOP(g.openingCents)}
                  </span>
                  {baseUrl && (
                    <BaseEditButton
                      baseUrl={baseUrl}
                      shiftId={null}
                      title={t("editBaseLocalTitle")}
                      amountCents={g.openingCents}
                      onDone={refetch}
                      t={t}
                    />
                  )}
                </span>
              </div>
              <Line
                label={t("collected")}
                value={`+ ${fmtCOP(g.collectedCashCents)}`}
              />
              {g.ingresoCents > 0 && (
                <Line label={t("ingresos")} value={`+ ${fmtCOP(g.ingresoCents)}`} />
              )}
              {g.egresoCents > 0 && (
                <Line
                  label={t("egresos")}
                  value={`− ${fmtCOP(g.egresoCents)}`}
                  tone="bad"
                />
              )}
              {byWaiter && g.basesOutCents > 0 && (
                <Line
                  label={t("basesOut")}
                  value={`− ${fmtCOP(g.basesOutCents)}`}
                />
              )}
              {byWaiter && g.returnedCashCents > 0 && (
                <Line
                  label={t("returned")}
                  value={`+ ${fmtCOP(g.returnedCashCents)}`}
                />
              )}
            </div>
          </div>

          {/* Cajas de meseros + consolidado (solo by_waiter) */}
          {byWaiter && (
            <div className="mt-4">
              <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-2">
                {t("meserosTitle")}
              </div>
              {snap.meseros.length === 0 ? (
                <div className="text-xs text-op-muted">{t("noMeseros")}</div>
              ) : (
                <ul className="space-y-2">
                  {snap.meseros.map((m) => (
                    <li
                      key={m.userId}
                      className="rounded-xl border border-op-border bg-op-bg/40 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{m.name}</span>
                        <span className="font-display text-lg tabular">
                          {fmtCOP(m.mustReturnCents)}
                        </span>
                      </div>
                      <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-op-muted font-mono tabular">
                        <span className="flex items-center gap-1.5">
                          <span>
                            {t("mBase")} {fmtCOP(m.baseCents)}
                          </span>
                          {baseUrl && (
                            <BaseEditButton
                              baseUrl={baseUrl}
                              shiftId={m.shiftId}
                              title={t("editBaseMeseroTitle", { name: m.name })}
                              amountCents={m.baseCents}
                              maxCents={g.openingCents}
                              onDone={refetch}
                              t={t}
                            />
                          )}
                        </span>
                        <span>
                          {t("mCollected")} {fmtCOP(m.collectedCashCents)}
                        </span>
                        <span className="text-right">{t("mMustReturn")}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex items-center justify-between rounded-xl border border-ink/20 bg-ink/5 px-4 py-3">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
                  {t("consolidated")}
                </span>
                <span className="font-display text-xl tabular">
                  {fmtCOP(snap.consolidatedCents)}
                </span>
              </div>
            </div>
          )}

          {/* Movimientos */}
          <div className="mt-4">
            <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-2">
              {t("movementsTitle")}
            </div>
            {snap.movements.length === 0 ? (
              <div className="text-xs text-op-muted">{t("noMovements")}</div>
            ) : (
              <ul className="divide-y divide-op-border">
                {snap.movements.map((mv) => (
                  <li
                    key={mv.id}
                    className="py-2 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm truncate">{mv.concept}</div>
                      {mv.byName && (
                        <div className="text-[11px] text-op-muted">
                          {t("byLine", { name: mv.byName })}
                        </div>
                      )}
                    </div>
                    <span
                      className={
                        "font-mono tabular text-sm shrink-0 " +
                        (mv.kind === "egreso" ? "text-danger" : "text-ok")
                      }
                    >
                      {mv.kind === "egreso" ? "−" : "+"} {fmtCOP(mv.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bad";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-op-muted">{label}</span>
      <span
        className={
          "font-mono tabular " + (tone === "bad" ? "text-danger" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Botón "Editar" + modal para corregir la base (openingCashCents) de un
 * turno YA abierto. `shiftId=null` → base del local; con shiftId → base de
 * ese mesero. La regla base_mesero ≤ base_local la valida el servidor;
 * acá traducimos sus errores a mensajes claros.
 */
function BaseEditButton({
  baseUrl,
  shiftId,
  title,
  amountCents,
  maxCents,
  onDone,
  t,
}: {
  baseUrl: string;
  shiftId: string | null;
  title: string;
  amountCents: number;
  maxCents?: number;
  onDone: () => void | Promise<void>;
  t: ReturnType<typeof useTranslations<"cashBox">>;
}) {
  const [open, setOpen] = useState(false);
  const [pesos, setPesos] = useState(String(Math.round(amountCents / 100)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cents = (parseInt(pesos.replace(/\D/g, ""), 10) || 0) * 100;

  async function submit() {
    setBusy(true);
    setErr(null);
    const r = await fetch(baseUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shiftId, openingCashCents: cents }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        maxCents?: number;
        minCents?: number;
        meseroName?: string | null;
      };
      if (j.error === "base_exceeds_local") {
        setErr(t("editBaseExceedsLocal", { amount: fmtCOP(j.maxCents ?? 0) }));
      } else if (j.error === "base_below_mesero") {
        setErr(
          t("editBaseBelowMesero", {
            name: j.meseroName ?? "",
            amount: fmtCOP(j.minCents ?? 0),
          }),
        );
      } else {
        setErr(t("saveFailed"));
      }
      return;
    }
    setOpen(false);
    await onDone();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] underline text-op-muted hover:text-op-text shrink-0"
      >
        {t("editBase")}
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full md:max-w-sm bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-2xl">{title}</h2>
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5">
            {t("formAmount")}
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-op-border bg-op-bg px-3 h-11">
            <span className="text-op-muted">$</span>
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              value={pesos ? Number(pesos).toLocaleString("es-CO") : ""}
              onChange={(e) => setPesos(e.target.value.replace(/\D/g, ""))}
              placeholder="0"
              className="flex-1 bg-transparent outline-none font-display text-xl tabular min-w-0"
            />
          </div>
          {maxCents !== undefined && (
            <p className="text-[11px] text-op-muted mt-1">
              {t("editBaseMax", { amount: fmtCOP(maxCents) })}
            </p>
          )}
        </div>
        {err && <div className="text-xs text-danger">{err}</div>}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="h-10 px-4 rounded-full border border-op-border text-sm font-medium disabled:opacity-50"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function EgresoButton({
  movementUrl,
  onDone,
  t,
}: {
  movementUrl: string;
  onDone: () => void | Promise<void>;
  t: ReturnType<typeof useTranslations<"cashBox">>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"egreso" | "ingreso">("egreso");
  const [pesos, setPesos] = useState("");
  const [concept, setConcept] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const amountCents = (parseInt(pesos.replace(/\D/g, ""), 10) || 0) * 100;
  const canSave = amountCents > 0 && concept.trim().length > 0 && !busy;

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(movementUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, amountCents, concept: concept.trim() }),
    });
    setBusy(false);
    if (!r.ok) {
      setErr(t("saveFailed"));
      return;
    }
    setOpen(false);
    setPesos("");
    setConcept("");
    setKind("egreso");
    await onDone();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 px-4 rounded-full border border-op-border text-sm font-medium hover:bg-op-bg shrink-0"
      >
        {t("addEgreso")}
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full md:max-w-sm bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-2xl">{t("addEgreso")}</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setKind("egreso")}
            className={
              "flex-1 h-10 rounded-full text-sm font-medium border " +
              (kind === "egreso"
                ? "bg-ink text-bone border-ink"
                : "border-op-border text-op-muted")
            }
          >
            {t("kindEgreso")}
          </button>
          <button
            type="button"
            onClick={() => setKind("ingreso")}
            className={
              "flex-1 h-10 rounded-full text-sm font-medium border " +
              (kind === "ingreso"
                ? "bg-ink text-bone border-ink"
                : "border-op-border text-op-muted")
            }
          >
            {t("kindIngreso")}
          </button>
        </div>
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5">
            {t("formAmount")}
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-op-border bg-op-bg px-3 h-11">
            <span className="text-op-muted">$</span>
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              value={pesos ? Number(pesos).toLocaleString("es-CO") : ""}
              onChange={(e) => setPesos(e.target.value.replace(/\D/g, ""))}
              placeholder="0"
              className="flex-1 bg-transparent outline-none font-display text-xl tabular min-w-0"
            />
          </div>
        </div>
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1.5">
            {t("formConcept")}
          </div>
          <input
            type="text"
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            maxLength={200}
            placeholder={t("formConceptPlaceholder")}
            className="w-full h-11 px-3 rounded-xl border border-op-border bg-op-bg text-sm"
          />
        </div>
        {err && <div className="text-xs text-danger">{err}</div>}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="h-10 px-4 rounded-full border border-op-border text-sm font-medium disabled:opacity-50"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSave}
            className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
