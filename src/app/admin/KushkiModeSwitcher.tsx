"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Selector del modo Kushki global. platform_admin puede cambiar entre
 * mock / sandbox / production sin redeploy. Cambio toma ~60s en
 * propagarse a otros procesos del blue/green deploy por el cache TTL.
 *
 * Guardrail UX: confirmación nativa antes de pasar a "production" para
 * evitar accidentes que disparen cobros reales.
 */
export function KushkiModeSwitcher({
  initialMode,
}: {
  initialMode: "mock" | "sandbox" | "production";
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"mock" | "sandbox" | "production">(
    initialMode,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const dirty = mode !== initialMode;

  async function save() {
    if (mode === "production") {
      const ok = confirm(
        "ATENCIÓN: vas a cambiar a MODO PRODUCCIÓN.\n\n" +
          "Todos los cobros pasarán a Kushki real y movimientos de dinero serán reales.\n\n" +
          "¿Confirmás?",
      );
      if (!ok) return;
    }
    setErr(null);
    setBusy(true);
    const res = await fetch("/api/admin/platform-config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kushkiMode: mode }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos guardar el cambio.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
          Kushki · modo global
        </div>
        <ModeBadge mode={initialMode} />
      </div>
      <p className="text-xs text-op-muted mb-4">
        Controla a qué API de Kushki apunta toda la plataforma. Los cambios
        se aplican sin redeploy y propagan a otros procesos del cluster en
        ~60s.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <ModeOption
          value="mock"
          label="Mock"
          description="In-memory, sin red"
          active={mode === "mock"}
          onClick={() => setMode("mock")}
        />
        <ModeOption
          value="sandbox"
          label="Sandbox"
          description="api-uat (testing)"
          active={mode === "sandbox"}
          onClick={() => setMode("sandbox")}
        />
        <ModeOption
          value="production"
          label="Producción"
          description="$ real ⚠"
          active={mode === "production"}
          onClick={() => setMode("production")}
        />
      </div>

      {err && <div className="text-xs text-danger mb-2">{err}</div>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setMode(initialMode);
              setErr(null);
            }}
            disabled={busy}
            className="h-10 px-3 rounded-full text-sm text-op-muted hover:text-op-text"
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

function ModeOption({
  label,
  description,
  active,
  onClick,
}: {
  value: string;
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-xl border p-3 text-left transition-colors " +
        (active
          ? "border-ink bg-ink text-bone"
          : "border-op-border bg-paper text-ink hover:border-ink/40")
      }
    >
      <div className="text-sm font-medium">{label}</div>
      <div
        className={
          "text-[10px] mt-0.5 " + (active ? "opacity-80" : "text-op-muted")
        }
      >
        {description}
      </div>
    </button>
  );
}

function ModeBadge({
  mode,
}: {
  mode: "mock" | "sandbox" | "production";
}) {
  const map = {
    mock: { label: "MOCK", cls: "bg-op-bg text-op-muted border-op-border" },
    sandbox: { label: "SANDBOX", cls: "bg-[#C98A2E]/15 text-[#7F5A1F] border-[#C98A2E]/40" },
    production: { label: "PRODUCCIÓN", cls: "bg-danger/15 text-danger border-danger/30" },
  } as const;
  const m = map[mode];
  return (
    <span
      className={
        "font-mono text-[9px] tracking-wider uppercase px-2 py-1 rounded border " +
        m.cls
      }
    >
      {m.label}
    </span>
  );
}
