"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";

type Device = {
  id: string;
  label: string;
  kushkiDeviceId: string;
  serialNumber: string | null;
  active: boolean;
  lastSeenAt: string | null;
};

/**
 * Lo que la pantalla sabe del Business-Code: NUNCA el valor entero (es la
 * clave con la que se firma cada cobro), sólo enmascarado.
 */
export type BusinessCodeView = {
  /** El del comercio, enmascarado ("••••1a2b"), o null si no cargó uno. */
  masked: string | null;
  /** Sin código propio, el de la plataforma que se usa en su lugar, enmascarado. */
  platformMasked: string | null;
  /** El guardado es en realidad otra credencial de Kushki. */
  problem: "business_code_is_merchant_id" | "business_code_is_public_key" | null;
};

/**
 * Configuración → Datáfonos. Los datáfonos Kushki son del COMERCIO, no de
 * un mesero: cualquiera del equipo cobra con cualquiera, y al cobrar elige a
 * cuál mandar el cobro (ver lib/payments/terminalChoice.ts). Acá sólo se
 * cargan el Business-Code y cada equipo (nombre, serial, activo).
 */
export function DatafonosClient({
  initial,
  businessCode,
}: {
  initial: Device[];
  businessCode: BusinessCodeView;
}) {
  const [devices, setDevices] = useState<Device[]>(initial);

  function patch(deviceId: string, next: Partial<Device>) {
    setDevices((prev) =>
      prev.map((d) => (d.id === deviceId ? { ...d, ...next } : d)),
    );
  }

  return (
    <div className="space-y-3">
      <BusinessCodeCard initial={businessCode} />
      <ul className="space-y-3">
        {devices.map((d) => (
          <DeviceCard key={d.id} device={d} onPatch={(next) => patch(d.id, next)} />
        ))}
      </ul>
      <AddDeviceForm onCreated={(d) => setDevices((prev) => [...prev, d])} />
    </div>
  );
}

const CODE_ERROR_KEY: Record<string, string> = {
  business_code_is_merchant_id: "datafonosBusinessCodeIsMerchantId",
  business_code_is_public_key: "datafonosBusinessCodeIsPublicKey",
};

// Business-Code del Cloud Terminal del comercio. Lo entrega Kushki para el
// datáfono y firma cada cobro. Se muestra enmascarado; para cambiarlo se
// escribe uno nuevo encima. "Borrar" lo quita.
function BusinessCodeCard({ initial }: { initial: BusinessCodeView }) {
  const t = useTranslations("opSettings");
  const router = useRouter();
  const [view, setView] = useState<BusinessCodeView>(initial);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function save(value: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/operator/terminal-business-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessCode: value }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const key = typeof j.error === "string" ? CODE_ERROR_KEY[j.error] : undefined;
        setMsg({ kind: "error", text: t(key ?? "datafonosSaveFailed") });
        return;
      }
      setView({
        masked: typeof j.masked === "string" ? j.masked : null,
        platformMasked: value ? null : initial.platformMasked,
        problem: null,
      });
      setCode("");
      setMsg({ kind: "ok", text: t("datafonosSaved") });
      router.refresh();
    } catch {
      setMsg({ kind: "error", text: t("datafonosSaveFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
        {t("datafonosBusinessCodeLabel")}
      </div>
      <p className="text-sm mb-3" role="status">
        {view.masked ? (
          <>
            {t("datafonosBusinessCodeSaved")}{" "}
            <span className="font-mono tabular">{view.masked}</span>
          </>
        ) : view.platformMasked ? (
          <>
            {t("datafonosBusinessCodePlatform")}{" "}
            <span className="font-mono tabular">{view.platformMasked}</span>
          </>
        ) : (
          t("datafonosBusinessCodeNone")
        )}
      </p>
      {view.problem && (
        <p className="text-xs text-danger mb-3">{t(CODE_ERROR_KEY[view.problem])}</p>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setMsg(null);
          }}
          placeholder={
            view.masked ? t("datafonosBusinessCodeReplacePlaceholder") : t("datafonosBusinessCodePlaceholder")
          }
          autoComplete="off"
          spellCheck={false}
          className="flex-1 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:border-terracotta"
        />
        <button
          type="button"
          onClick={() => save(code.trim())}
          disabled={busy || !code.trim()}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("datafonosBusinessCodeSaving") : t("datafonosBusinessCodeBtn")}
        </button>
        {view.masked && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t("datafonosBusinessCodeClearConfirm"))) void save("");
            }}
            disabled={busy}
            className="mp-btn mp-btn--ghost mp-btn--sm"
          >
            {t("datafonosBusinessCodeClear")}
          </button>
        )}
      </div>
      <p className="text-[11px] text-op-muted mt-2">
        {t("datafonosBusinessCodeHint")}
      </p>
      {msg && (
        <div
          className={
            "mt-2 text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function AddDeviceForm({ onCreated }: { onCreated: (d: Device) => void }) {
  const t = useTranslations("opSettings");
  const [label, setLabel] = useState("");
  const [serial, setSerial] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!label.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/operator/terminal-devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.trim(), serialNumber: serial.trim() }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.device) {
      setErr(t("datafonosAddFailed"));
      return;
    }
    onCreated(j.device as Device);
    setLabel("");
    setSerial("");
  }

  return (
    <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
        {t("datafonosAddTitle")}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("datafonosAddNamePlaceholder")}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
        />
        <input
          type="text"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          placeholder={t("datafonosSerialPlaceholder")}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:border-terracotta"
        />
      </div>
      <p className="text-[11px] text-op-muted mt-2">{t("datafonosSerialHint")}</p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={create}
          disabled={busy || !label.trim()}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("datafonosAdding") : t("datafonosAddBtn")}
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  onPatch,
}: {
  device: Device;
  onPatch: (next: Partial<Device>) => void;
}) {
  const t = useTranslations("opSettings");
  const locale = useLocale() as Locale;
  const [busy, setBusy] = useState(false);
  const [serial, setSerial] = useState(device.serialNumber ?? "");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function save(next: Partial<Device>) {
    setBusy(true);
    setMsg(null);
    // Optimistically reflect so the UI feels instant; revert on failure.
    const prev = { ...device };
    onPatch(next);
    const res = await fetch(`/api/operator/terminal-devices/${device.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    setBusy(false);
    if (!res.ok) {
      onPatch(prev);
      setMsg({ kind: "error", text: t("datafonosSaveFailed") });
      return;
    }
    setMsg({ kind: "ok", text: t("datafonosSaved") });
  }

  return (
    <li className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <div className="font-display text-xl truncate">{device.label}</div>
          {device.lastSeenAt && (
            <div className="text-[11px] text-op-muted mt-0.5">
              {t("datafonosLastSeen", {
                date: formatDate(device.lastSeenAt, { locale }),
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => save({ active: !device.active })}
          disabled={busy}
          className={
            "h-8 px-3 rounded-full text-[11px] font-medium border " +
            (device.active
              ? "bg-ok/15 text-[#1E5339] border-ok/30"
              : "bg-paper text-op-muted border-op-border")
          }
        >
          {device.active ? t("datafonosActive") : t("datafonosInactive")}
        </button>
      </div>

      {/* Serial físico del datáfono (Cloud Terminal API). */}
      <div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
          {t("datafonosSerialLabel")}
        </div>
        <input
          type="text"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          onBlur={() => {
            const trimmed = serial.trim();
            if (trimmed !== (device.serialNumber ?? "")) {
              save({ serialNumber: trimmed || null });
            }
          }}
          placeholder={t("datafonosSerialPlaceholder")}
          disabled={busy}
          className="w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:border-terracotta"
        />
        <p className="text-[11px] text-op-muted mt-2">
          {t("datafonosSerialHint")}
        </p>
      </div>

      {msg && (
        <div
          className={
            "mt-3 text-xs " +
            (msg.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {msg.text}
        </div>
      )}
    </li>
  );
}
