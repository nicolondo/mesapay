"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { bpsToPct, pctToBps } from "@/lib/waiterCommissions";

/** Espera antes de guardar, para no disparar un PUT por cada mesa tocada. */
const AUTOSAVE_DELAY_MS = 600;

const sorted = (nums: Iterable<number>) =>
  Array.from(nums).sort((a, b) => a - b);

const sameNums = (a: number[], b: number[]) =>
  a.length === b.length && a.every((n, i) => n === b[i]);

type Mesero = {
  id: string;
  email: string;
  name: string | null;
  assignedTableNumbers: number[];
  /** Comisión de ventas en puntos base (250 = 2,5 %); null = sin comisión. */
  commissionBps: number | null;
};

type Table = {
  number: number;
  label: string | null;
};

export function MeserosClient({
  tables,
  meseros: initial,
}: {
  tables: Table[];
  meseros: Mesero[];
}) {
  const [meseros, setMeseros] = useState<Mesero[]>(initial);

  // Estable a propósito: cada tarjeta la usa como dependencia de su
  // efecto de autoguardado. Si cambiara de identidad en cada render,
  // guardar una tarjeta reiniciaría la espera de las demás.
  const applyChange = useCallback((meseroId: string, tableNumbers: number[]) => {
    setMeseros((prev) =>
      prev.map((m) =>
        m.id === meseroId ? { ...m, assignedTableNumbers: tableNumbers } : m,
      ),
    );
  }, []);

  return (
    <div className="space-y-4">
      {meseros.map((m) => (
        <MeseroCard
          key={m.id}
          mesero={m}
          tables={tables}
          onChange={applyChange}
        />
      ))}
    </div>
  );
}

function MeseroCard({
  mesero,
  tables,
  onChange,
}: {
  mesero: Mesero;
  tables: Table[];
  // Recibe el id para que la referencia sea estable entre renders (ver
  // el useCallback del padre): es la dependencia del autoguardado.
  onChange: (meseroId: string, tns: number[]) => void;
}) {
  const tr = useTranslations("opSettings");
  const [selected, setSelected] = useState<Set<number>>(
    new Set(mesero.assignedTableNumbers),
  );
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [rangeError, setRangeError] = useState(false);
  const [state, setState] = useState<"clean" | "saving" | "saved" | "error">(
    "clean",
  );

  // Lo que el servidor tiene confirmado. Comparar contra esto (y no
  // contra el prop) evita re-guardar lo mismo y hace idempotente el
  // reintento: el endpoint es un reemplazo completo del arreglo.
  const savedRef = useRef<number[]>(sorted(mesero.assignedTableNumbers));
  // Última intención del usuario, para reanudar con lo más nuevo si algo
  // cambió mientras un guardado estaba en vuelo.
  const latestRef = useRef<number[]>(savedRef.current);
  const runningRef = useRef(false);

  function toggle(num: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(tables.map((t) => t.number)));
  }
  function clearAll() {
    setSelected(new Set());
  }
  function applyRange() {
    const from = parseInt(rangeFrom, 10);
    const to = parseInt(rangeTo, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      setRangeError(true);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      for (const t of tables) {
        if (t.number >= from && t.number <= to) next.add(t.number);
      }
      return next;
    });
    setRangeFrom("");
    setRangeTo("");
    setRangeError(false);
  }

  /**
   * Guarda serializado: nunca hay dos PUT en vuelo. Si el usuario sigue
   * tocando mesas mientras uno viaja, al terminar se manda lo último
   * (`latestRef`) — así el servidor no puede recibir dos reemplazos en
   * orden invertido y quedarse con el estado viejo.
   */
  const save = useCallback(
    async function save(target: number[]) {
      // Ya hay uno en vuelo: no encolamos nada acá, el que está
      // corriendo se encarga de reanudar con `latestRef` al terminar.
      if (runningRef.current) return;
      if (sameNums(target, savedRef.current)) return;
      runningRef.current = true;
      setState("saving");
      try {
        const r = await fetch(`/api/operator/users/${mesero.id}/tables`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tableNumbers: target }),
        });
        if (!r.ok) throw new Error("save_failed");
        // El servidor descarta números de mesas que no existen: nos
        // quedamos con SU versión, no con la que mandamos.
        const j = (await r.json()) as { tableNumbers?: number[] };
        savedRef.current = j.tableNumbers ?? target;
        onChange(mesero.id, savedRef.current);
        setState("saved");
      } catch {
        // No reintentamos solos: un error persistente se convertiría en
        // un bucle contra el servidor. El usuario reintenta, y cualquier
        // cambio nuevo vuelve a agendar el guardado.
        setState("error");
        return;
      } finally {
        runningRef.current = false;
      }
      if (!sameNums(latestRef.current, savedRef.current)) {
        void save(latestRef.current);
      }
    },
    [mesero.id, onChange],
  );

  // Autoguardado: cada cambio reinicia la espera. El cleanup cancela el
  // timer anterior, así diez mesas seguidas son UN solo PUT.
  useEffect(() => {
    const target = sorted(selected);
    latestRef.current = target;
    if (sameNums(target, savedRef.current)) {
      // Nada que guardar: o no cambió nada, o el usuario deshizo lo que
      // había tocado. NO pisamos "saved" — es la única confirmación que
      // ve, y este efecto vuelve a correr apenas termina un guardado.
      // Un error sí se limpia: ya no hay nada pendiente que reportar.
      setState((s) => (s === "error" ? "clean" : s));
      return;
    }
    const id = setTimeout(() => void save(target), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(id);
  }, [selected, save]);

  // Cerrar la pestaña con un cambio sin confirmar lo perdería en
  // silencio. La ventana es corta (la espera de arriba) pero existe.
  const pending = state === "saving" || state === "error";
  useEffect(() => {
    if (!pending) return;
    function warn(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const displayName = mesero.name?.trim() || mesero.email;

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <div className="font-display text-xl truncate">{displayName}</div>
          {mesero.name && (
            <div className="font-mono text-[11px] text-op-muted truncate">
              {mesero.email}
            </div>
          )}
        </div>
        <div className="font-mono text-[11px] tracking-wider uppercase text-op-muted shrink-0">
          {selected.size === 0
            ? tr("meserosServesAll")
            : tr("meserosTableCount", { count: selected.size })}
        </div>
      </div>

      <CommissionField meseroId={mesero.id} initialBps={mesero.commissionBps} />

      {/* Quick actions */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button
          type="button"
          onClick={selectAll}
          className="h-7 px-3 rounded-full bg-op-bg border border-op-border text-[11px] font-medium hover:bg-op-surface"
        >
          {tr("meserosSelectAll")}
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="h-7 px-3 rounded-full bg-op-bg border border-op-border text-[11px] font-medium hover:bg-op-surface"
        >
          {tr("meserosSelectNone")}
        </button>
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-[10px] text-op-muted font-mono uppercase tracking-wider">
            {tr("meserosRange")}
          </span>
          <input
            type="number"
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value)}
            placeholder={tr("meserosRangeFromPlaceholder")}
            className="h-7 w-14 px-2 rounded-md border border-op-border bg-op-bg text-xs font-mono tabular text-center"
          />
          <span className="text-op-muted" aria-hidden="true">
            {"→"}
          </span>
          <input
            type="number"
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value)}
            placeholder={tr("meserosRangeToPlaceholder")}
            className="h-7 w-14 px-2 rounded-md border border-op-border bg-op-bg text-xs font-mono tabular text-center"
          />
          <button
            type="button"
            onClick={applyRange}
            className="h-7 px-3 rounded-full bg-ink text-bone text-[11px] font-medium hover:bg-ink/90"
          >
            {tr("meserosRangeAdd")}
          </button>
        </div>
      </div>

      {/* El error del rango vive junto al rango, no en el pie: allá abajo
          ahora sólo se habla del guardado. */}
      {rangeError && (
        <div className="-mt-1 mb-3 text-xs text-danger text-right">
          {tr("meserosRangeInvalid")}
        </div>
      )}

      {/* Pill grid — one per mesa */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-2">
        {tables.map((t) => {
          const on = selected.has(t.number);
          return (
            <button
              key={t.number}
              type="button"
              onClick={() => toggle(t.number)}
              aria-pressed={on}
              className={
                "h-10 rounded-lg text-sm font-medium border transition-colors " +
                (on
                  ? "bg-ink text-bone border-ink"
                  : "bg-op-bg text-op-text border-op-border hover:border-op-text/40")
              }
              title={t.label ?? undefined}
            >
              {t.number}
            </button>
          );
        })}
      </div>

      {/* Se guarda solo. Sin botón: el estado del guardado ES el feedback,
          y ocupa el lugar donde antes estaba el botón para que la tarjeta
          no salte de alto al aparecer y desaparecer. */}
      <div
        className="mt-4 h-6 flex items-center justify-end gap-3"
        aria-live="polite"
      >
        {state === "saving" && (
          <span className="text-xs text-op-muted">{tr("meserosSaving")}</span>
        )}
        {state === "saved" && (
          <span className="text-xs text-ok">{tr("meserosSaved")}</span>
        )}
        {state === "error" && (
          <>
            <span className="text-xs text-danger">
              {tr("meserosSaveFailed")}
            </span>
            <button
              type="button"
              onClick={() => void save(latestRef.current)}
              className="mp-btn mp-btn--ghost mp-btn--sm"
            >
              {tr("meserosSaveRetry")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Texto del campo → bps. `null` = vacío (sin comisión); `undefined` =
 * inválido (fuera de 0..100 o no numérico): no se guarda.
 */
function parsePct(raw: string): number | null | undefined {
  const v = raw.trim().replace(",", ".");
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return pctToBps(n);
}

/**
 * Comisión de ventas (%) del mesero. Se guarda sola, con la misma espera
 * que las mesas, pero con su propio guardado serializado: es otro endpoint
 * y otro dato, y así un error en uno no bloquea al otro. Entra como
 * porcentaje con dos decimales; viaja y se guarda en puntos base.
 */
function CommissionField({
  meseroId,
  initialBps,
}: {
  meseroId: string;
  initialBps: number | null;
}) {
  const tr = useTranslations("opSettings");
  const [text, setText] = useState(initialBps == null ? "" : String(bpsToPct(initialBps)));
  const [state, setState] = useState<"clean" | "saving" | "saved" | "error" | "invalid">(
    "clean",
  );
  // Lo confirmado por el servidor (bps) y la última intención válida.
  const savedRef = useRef<number | null>(initialBps);
  const latestRef = useRef<number | null | undefined>(initialBps);
  const runningRef = useRef(false);

  const save = useCallback(
    async function save(target: number | null) {
      if (runningRef.current) return;
      if (target === savedRef.current) return;
      runningRef.current = true;
      setState("saving");
      try {
        const r = await fetch(`/api/operator/users/${meseroId}/commission`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commissionPct: target == null ? null : bpsToPct(target) }),
        });
        if (!r.ok) throw new Error("save_failed");
        const j = (await r.json()) as { commissionBps?: number | null };
        savedRef.current = j.commissionBps === undefined ? target : j.commissionBps;
        setState("saved");
      } catch {
        setState("error");
        return;
      } finally {
        runningRef.current = false;
      }
      const latest = latestRef.current;
      if (latest !== undefined && latest !== savedRef.current) void save(latest);
    },
    [meseroId],
  );

  useEffect(() => {
    const target = parsePct(text);
    latestRef.current = target;
    if (target === undefined) {
      setState("invalid");
      return;
    }
    if (target === savedRef.current) {
      setState((s) => (s === "error" || s === "invalid" ? "clean" : s));
      return;
    }
    const id = setTimeout(() => void save(target), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(id);
  }, [text, save]);

  return (
    <div className="mb-4 rounded-xl border border-op-border bg-op-bg p-3">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2">
          <span className="text-[10px] text-op-muted font-mono uppercase tracking-wider">
            {tr("meserosCommissionLabel")}
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.01}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={tr("meserosCommissionNone")}
            aria-invalid={state === "invalid" || undefined}
            className={
              "h-8 w-28 px-2 rounded-md border bg-op-surface text-sm font-mono tabular text-right " +
              (state === "invalid" ? "border-danger" : "border-op-border")
            }
          />
        </label>
        <span className="ml-auto text-xs" aria-live="polite">
          {state === "invalid" && (
            <span className="text-danger">{tr("meserosCommissionInvalid")}</span>
          )}
          {state === "saving" && <span className="text-op-muted">{tr("meserosSaving")}</span>}
          {state === "saved" && <span className="text-ok">{tr("meserosSaved")}</span>}
          {state === "error" && (
            <>
              <span className="text-danger">{tr("meserosSaveFailed")}</span>{" "}
              <button
                type="button"
                onClick={() => {
                  const latest = latestRef.current;
                  if (latest !== undefined) void save(latest);
                }}
                className="mp-btn mp-btn--ghost mp-btn--sm"
              >
                {tr("meserosSaveRetry")}
              </button>
            </>
          )}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-op-muted">{tr("meserosCommissionHint")}</p>
    </div>
  );
}
