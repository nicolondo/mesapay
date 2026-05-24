"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Station = "kitchen" | "bar" | "counter";
type CategoryKind =
  | "starter"
  | "main"
  | "side"
  | "drink"
  | "dessert"
  | "other";

type Category = {
  id: string;
  slug: string;
  label: string;
  kind: CategoryKind;
  prepStation: Station;
  barSubStation: string | null;
};

const STATION_OPTIONS: { value: Station; label: string; help: string }[] = [
  {
    value: "kitchen",
    label: "Cocina",
    help: "El cocinero la prepara y la marca lista",
  },
  {
    value: "bar",
    label: "Bar / barista",
    help: "Cuando hay bartender, va a su propio board",
  },
  {
    value: "counter",
    label: "Refri / mostrador",
    help: "Sin preparación — el mesero la agarra del refri",
  },
];

export function StationsClient({
  hasBar: initialHasBar,
  barSubStations: initialBarSubStations,
  kitchenPrintEnabled: initialKitchenPrint,
  barPrintEnabled: initialBarPrint,
  printPaperWidthMm: initialPaperWidth,
  categories: initialCategories,
}: {
  hasBar: boolean;
  barSubStations: string[];
  kitchenPrintEnabled: boolean;
  barPrintEnabled: boolean;
  printPaperWidthMm: 58 | 80;
  categories: Category[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [hasBar, setHasBar] = useState(initialHasBar);
  const [barSubStations, setBarSubStations] = useState(initialBarSubStations);
  const [subStationsInput, setSubStationsInput] = useState(
    initialBarSubStations.join(", "),
  );
  const [kitchenPrint, setKitchenPrint] = useState(initialKitchenPrint);
  const [barPrint, setBarPrint] = useState(initialBarPrint);
  const [paperWidth, setPaperWidth] = useState<58 | 80>(initialPaperWidth);
  const [categories, setCategories] = useState(initialCategories);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingBar, setSavingBar] = useState(false);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  async function saveSubStations() {
    const list = subStationsInput
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setSavingId("__sub__");
    try {
      const res = await fetch("/api/operator/settings/stations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "subStations", barSubStations: list }),
      });
      if (!res.ok) return;
      setBarSubStations(list);
      // Clear references to sub-stations that no longer exist (server
      // already did the same; we mirror for the optimistic UI).
      setCategories((prev) =>
        prev.map((c) =>
          c.barSubStation && !list.includes(c.barSubStation)
            ? { ...c, barSubStation: null }
            : c,
        ),
      );
      setSavedFlash("__sub__");
      setTimeout(() => setSavedFlash(null), 1400);
      startTx(() => router.refresh());
    } finally {
      setSavingId(null);
    }
  }

  async function updateCategorySubStation(
    categoryId: string,
    barSubStation: string | null,
  ) {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === categoryId ? { ...c, barSubStation } : c,
      ),
    );
    setSavingId(categoryId + "-sub");
    try {
      const res = await fetch("/api/operator/settings/stations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "categorySub",
          categoryId,
          barSubStation,
        }),
      });
      if (!res.ok) {
        setCategories(initialCategories);
      } else {
        setSavedFlash(categoryId + "-sub");
        setTimeout(() => setSavedFlash(null), 1400);
      }
    } finally {
      setSavingId(null);
    }
  }

  async function savePrintConfig(
    next: Partial<{
      kitchenPrintEnabled: boolean;
      barPrintEnabled: boolean;
      printPaperWidthMm: 58 | 80;
    }>,
  ) {
    setSavingId("__print__");
    try {
      const res = await fetch("/api/operator/settings/stations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "print", ...next }),
      });
      if (res.ok) {
        setSavedFlash("__print__");
        setTimeout(() => setSavedFlash(null), 1400);
      }
    } finally {
      setSavingId(null);
    }
  }

  async function toggleBar(next: boolean) {
    setHasBar(next);
    setSavingBar(true);
    try {
      const res = await fetch("/api/operator/settings/stations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "hasBar", hasBar: next }),
      });
      if (!res.ok) {
        // Rollback if the server rejected.
        setHasBar(!next);
      } else {
        setSavedFlash("bar");
        setTimeout(() => setSavedFlash(null), 1400);
        startTx(() => router.refresh());
      }
    } catch {
      setHasBar(!next);
    } finally {
      setSavingBar(false);
    }
  }

  async function applyDrinksToBar() {
    if (drinksOnKitchen.length === 0) return;
    setSavingId("__bulk__");
    // Optimistic — flip them all locally first so the UI feels instant.
    setCategories((prev) =>
      prev.map((c) =>
        c.kind === "drink" && c.prepStation === "kitchen"
          ? { ...c, prepStation: "bar" as Station }
          : c,
      ),
    );
    try {
      // We don't have a batch endpoint — but this list is small and the
      // optimistic update already happened, so a few parallel PATCHes
      // are fine.
      await Promise.all(
        drinksOnKitchen.map((c) =>
          fetch("/api/operator/settings/stations", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "categoryStation",
              categoryId: c.id,
              prepStation: "bar",
            }),
          }),
        ),
      );
      setSavedFlash("__bulk__");
      setTimeout(() => setSavedFlash(null), 1400);
    } catch {
      // On any failure roll back. Cheaper than tracking per-row error.
      setCategories(initialCategories);
    } finally {
      setSavingId(null);
    }
  }

  async function updateCategory(categoryId: string, station: Station) {
    setCategories((prev) =>
      prev.map((c) => (c.id === categoryId ? { ...c, prepStation: station } : c)),
    );
    setSavingId(categoryId);
    try {
      const res = await fetch("/api/operator/settings/stations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "categoryStation",
          categoryId,
          prepStation: station,
        }),
      });
      if (!res.ok) {
        // Revert on failure.
        setCategories(initialCategories);
      } else {
        setSavedFlash(categoryId);
        setTimeout(() => setSavedFlash(null), 1400);
      }
    } catch {
      setCategories(initialCategories);
    } finally {
      setSavingId(null);
    }
  }

  // Quick suggestions: if there's a drink category still pointing to
  // kitchen, suggest moving it. Same for "Postres" maybe later.
  const drinksOnKitchen = categories.filter(
    (c) => c.kind === "drink" && c.prepStation === "kitchen",
  );

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="flex items-center gap-3 text-sm text-op-muted mb-2">
        <Link href="/operator/settings" className="hover:text-ink">
          Configuración
        </Link>
        <span>›</span>
        <span className="text-ink">Estaciones de preparación</span>
      </div>
      <div className="font-display text-3xl mb-1">Estaciones</div>
      <p className="text-sm text-op-muted mb-8">
        Define a dónde se va cada categoría cuando el cliente envía un pedido.
        Si un plato no entra en su categoría, podés sobreescribirlo desde el
        editor del menú.
      </p>

      {/* hasBar toggle */}
      <div className="bg-op-surface border border-op-border rounded-2xl p-5 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="font-display text-lg">¿Tenés bartender?</div>
            <p className="text-sm text-op-muted mt-1">
              Si hay alguien dedicado al bar, los cocteles y bebidas que se
              preparan tienen su propio board en{" "}
              <code className="font-mono text-xs bg-paper px-1.5 py-0.5 rounded">
                /operator/bar
              </code>
              . Si no, todo lo de bar se trata como refri (el mesero lo
              agarra).
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={hasBar}
              disabled={savingBar}
              onChange={(e) => toggleBar(e.target.checked)}
            />
            <div className="w-11 h-6 bg-op-bg border border-op-border peer-checked:bg-ok rounded-full transition-colors peer-checked:border-ok"></div>
            <div className="absolute left-0.5 top-0.5 bg-white w-5 h-5 rounded-full transition-transform peer-checked:translate-x-5"></div>
          </label>
        </div>
        {savedFlash === "bar" && (
          <div className="mt-3 text-[11px] font-mono tracking-wider uppercase text-ok">
            ✓ Guardado
          </div>
        )}
      </div>

      {/* Bar sub-stations — only relevant when there's an actual
          bartender. Lets the operator split the bar into independent
          queues like "Cocteles" + "Cafetería" so each station can run
          on its own screen. */}
      {hasBar && (
        <div className="bg-op-surface border border-op-border rounded-2xl p-5 mb-6">
          <div className="font-display text-lg">Sub-estaciones del bar</div>
          <p className="text-sm text-op-muted mt-1 mb-4">
            Opcional. Si el bar tiene varios puestos (cocteles, café,
            cervezas), listálos separados por comas. Cada uno tendrá su
            propio tab en{" "}
            <code className="font-mono text-xs bg-paper px-1.5 py-0.5 rounded">
              /operator/bar
            </code>{" "}
            y su propia impresora si tenés impresión activa.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={subStationsInput}
              onChange={(e) => setSubStationsInput(e.target.value)}
              placeholder="Ej: Cocteles, Cafetería, Cervezas"
              className="flex-1 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            />
            <button
              type="button"
              onClick={saveSubStations}
              disabled={
                savingId === "__sub__" ||
                subStationsInput.trim() === barSubStations.join(", ")
              }
              className="h-10 px-4 rounded-lg bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {savingId === "__sub__" ? "Guardando…" : "Guardar"}
            </button>
          </div>
          {savedFlash === "__sub__" && (
            <div className="mt-2 text-[11px] font-mono tracking-wider uppercase text-ok">
              ✓ Guardado
            </div>
          )}
          {barSubStations.length > 0 && (
            <div className="mt-3 flex gap-1.5 flex-wrap">
              {barSubStations.map((s) => (
                <span
                  key={s}
                  className="font-mono text-[10px] tracking-wider uppercase bg-paper text-ink-3 px-2 py-1 rounded"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Printing config */}
      <div className="bg-op-surface border border-op-border rounded-2xl p-5 mb-6">
        <div className="font-display text-lg">Impresión de tickets</div>
        <p className="text-sm text-op-muted mt-1 mb-4">
          Imprime un ticket físico cuando llega un pedido. Abrí{" "}
          <code className="font-mono text-xs bg-paper px-1.5 py-0.5 rounded">
            /operator/print/cocina
          </code>{" "}
          (o{" "}
          <code className="font-mono text-xs bg-paper px-1.5 py-0.5 rounded">
            /operator/print/bar
          </code>
          ) en el computador con la impresora térmica conectada. La página
          imprime sola cuando llega un pedido.
        </p>
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Cocina</div>
              <div className="text-xs text-op-muted">
                Imprime al pasar de “Por preparar” a “En cocina”.
              </div>
            </div>
            <Toggle
              checked={kitchenPrint}
              onChange={(v) => {
                setKitchenPrint(v);
                savePrintConfig({ kitchenPrintEnabled: v });
              }}
              disabled={savingId === "__print__"}
            />
          </label>
          <label className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Bar</div>
              <div className="text-xs text-op-muted">
                Imprime al pasar de “Por preparar” a “En preparación”. La
                cuenta regresiva del plato arranca al mismo tiempo.
              </div>
            </div>
            <Toggle
              checked={barPrint}
              onChange={(v) => {
                setBarPrint(v);
                savePrintConfig({ barPrintEnabled: v });
              }}
              disabled={savingId === "__print__"}
            />
          </label>
          {(kitchenPrint || barPrint) && (
            <label className="flex items-center justify-between gap-4 pt-2 border-t border-op-border">
              <div>
                <div className="text-sm font-medium">Ancho del papel</div>
                <div className="text-xs text-op-muted">
                  Lo más común en Colombia: 80mm.
                </div>
              </div>
              <select
                value={paperWidth}
                onChange={(e) => {
                  const v = Number(e.target.value) as 58 | 80;
                  setPaperWidth(v);
                  savePrintConfig({ printPaperWidthMm: v });
                }}
                className="h-9 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              >
                <option value={80}>80 mm</option>
                <option value={58}>58 mm</option>
              </select>
            </label>
          )}
        </div>
        {savedFlash === "__print__" && (
          <div className="mt-3 text-[11px] font-mono tracking-wider uppercase text-ok">
            ✓ Guardado
          </div>
        )}
        {(kitchenPrint || barPrint) && (
          <div className="mt-4 pt-4 border-t border-op-border flex flex-wrap gap-2">
            {kitchenPrint && (
              <Link
                href="/operator/print/cocina"
                target="_blank"
                className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg border border-op-border bg-op-bg text-sm hover:bg-paper"
              >
                🖨️ Abrir impresora de cocina
              </Link>
            )}
            {barPrint && barSubStations.length === 0 && (
              <Link
                href="/operator/print/bar"
                target="_blank"
                className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg border border-op-border bg-op-bg text-sm hover:bg-paper"
              >
                🖨️ Abrir impresora del bar
              </Link>
            )}
            {barPrint &&
              barSubStations.map((s) => (
                <Link
                  key={s}
                  href={`/operator/print/bar?sub=${encodeURIComponent(s)}`}
                  target="_blank"
                  className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg border border-op-border bg-op-bg text-sm hover:bg-paper"
                >
                  🖨️ Bar · {s}
                </Link>
              ))}
          </div>
        )}
      </div>

      {/* Smart suggestion */}
      {drinksOnKitchen.length > 0 && (
        <div className="bg-[#C98A2E]/10 border border-[#C98A2E]/30 rounded-2xl p-4 mb-6 flex items-start gap-3 text-sm">
          <span className="text-base">💡</span>
          <div className="flex-1 text-[#7F5A1F]">
            Detectamos {drinksOnKitchen.length}{" "}
            {drinksOnKitchen.length === 1 ? "categoría" : "categorías"} de
            bebidas que aún van a cocina (
            <strong>
              {drinksOnKitchen.map((c) => c.label).join(", ")}
            </strong>
            ). ¿Las pasamos al bar?
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={applyDrinksToBar}
                disabled={savingId === "__bulk__"}
                className="h-8 px-3 rounded-lg bg-[#C98A2E] text-bone text-xs font-medium disabled:opacity-50"
              >
                {savingId === "__bulk__"
                  ? "Aplicando…"
                  : `Pasar ${drinksOnKitchen.length} al bar`}
              </button>
              {savedFlash === "__bulk__" && (
                <span className="font-mono text-[10px] tracking-wider uppercase text-ok">
                  ✓ Listo
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Category list */}
      <div className="space-y-2">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted mb-2">
          Por categoría
        </div>
        {categories.length === 0 && (
          <div className="text-sm text-op-muted py-6 text-center bg-op-surface border border-op-border rounded-xl">
            No hay categorías. Crealas desde el menú.
          </div>
        )}
        {categories.map((c) => (
          <div
            key={c.id}
            className="bg-op-surface border border-op-border rounded-xl p-4 flex items-center gap-3 flex-wrap"
          >
            <div className="flex-1 min-w-[140px]">
              <div className="font-medium truncate">{c.label}</div>
              <div className="text-xs text-op-muted mt-0.5 truncate">
                {kindLabel(c.kind)}
              </div>
            </div>
            <select
              value={c.prepStation}
              disabled={savingId === c.id}
              onChange={(e) =>
                updateCategory(c.id, e.target.value as Station)
              }
              className="h-9 rounded-lg border border-op-border bg-op-bg text-sm px-3"
            >
              {STATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {/* Sub-station picker — only relevant for categories routed
                to the bar AND when sub-stations are configured. */}
            {c.prepStation === "bar" && barSubStations.length > 0 && (
              <select
                value={c.barSubStation ?? ""}
                disabled={savingId === c.id + "-sub"}
                onChange={(e) =>
                  updateCategorySubStation(
                    c.id,
                    e.target.value === "" ? null : e.target.value,
                  )
                }
                className="h-9 rounded-lg border border-op-border bg-op-bg text-sm px-3"
              >
                <option value="">— Sin sub-estación —</option>
                {barSubStations.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
            {(savedFlash === c.id || savedFlash === c.id + "-sub") && (
              <span className="font-mono text-[10px] tracking-wider uppercase text-ok shrink-0">
                ✓
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 text-xs text-op-muted">
        <strong>Refri / mostrador:</strong> el ítem entra ya como listo, sin
        pasar por cocina ni bar. Aparece directo en Salón con la etiqueta de
        dónde sacarlo. Ideal para botellitas de agua y cervezas embotelladas.
      </div>
    </div>
  );
}

function kindLabel(k: CategoryKind): string {
  switch (k) {
    case "starter":
      return "Entrada";
    case "main":
      return "Plato fuerte";
    case "side":
      return "Acompañamiento";
    case "drink":
      return "Bebida";
    case "dessert":
      return "Postre";
    default:
      return "Otro";
  }
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-flex items-center shrink-0">
      <input
        type="checkbox"
        className="sr-only peer"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="w-11 h-6 bg-op-bg border border-op-border peer-checked:bg-ok rounded-full transition-colors peer-checked:border-ok"></div>
      <div className="absolute left-0.5 top-0.5 bg-white w-5 h-5 rounded-full transition-transform peer-checked:translate-x-5"></div>
    </span>
  );
}
