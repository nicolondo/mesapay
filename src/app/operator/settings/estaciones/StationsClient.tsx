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
  categories: initialCategories,
}: {
  hasBar: boolean;
  categories: Category[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [hasBar, setHasBar] = useState(initialHasBar);
  const [categories, setCategories] = useState(initialCategories);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingBar, setSavingBar] = useState(false);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  async function toggleBar(next: boolean) {
    setHasBar(next);
    setSavingBar(true);
    try {
      const res = await fetch("/api/operator/settings/stations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hasBar: next }),
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
            body: JSON.stringify({ categoryId: c.id, prepStation: "bar" }),
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
        body: JSON.stringify({ categoryId, prepStation: station }),
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
            className="bg-op-surface border border-op-border rounded-xl p-4 flex items-center gap-4"
          >
            <div className="flex-1 min-w-0">
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
            {savedFlash === c.id && (
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
