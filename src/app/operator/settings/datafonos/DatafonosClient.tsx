"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

type Device = {
  id: string;
  label: string;
  kushkiDeviceId: string;
  serialNumber: string | null;
  active: boolean;
  assignedUserId: string | null;
  lastSeenAt: string | null;
};

type UserOption = {
  id: string;
  label: string;
  email: string;
  role: string;
};

// Maps a user role to its i18n key. Resolved via t() at render time so the
// option label stays trilingual.
const ROLE_LABEL_KEY: Record<string, string> = {
  mesero: "datafonosRoleMesero",
  operator: "datafonosRoleOperator",
  terminal: "datafonosRoleTerminal",
};

export function DatafonosClient({
  initial,
  users,
  businessCode,
}: {
  initial: Device[];
  users: UserOption[];
  businessCode: string | null;
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
          <DeviceCard
            key={d.id}
            device={d}
            users={users}
            onPatch={(next) => patch(d.id, next)}
          />
        ))}
      </ul>
      <AddDeviceForm onCreated={(d) => setDevices((prev) => [...prev, d])} />
    </div>
  );
}

// Business code del comercio para el Cloud Terminal. Es por-comercio (lo
// emite el procesador) y se manda en cada cobro al datáfono. Guarda al
// presionar el botón; "" lo borra.
function BusinessCodeCard({ initial }: { initial: string | null }) {
  const t = useTranslations("opSettings");
  const [code, setCode] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const dirty = code.trim() !== (initial ?? "");

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/operator/terminal-business-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessCode: code.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: t("datafonosSaveFailed") });
      return;
    }
    setMsg({ kind: "ok", text: t("datafonosSaved") });
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
        {t("datafonosBusinessCodeLabel")}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setMsg(null);
          }}
          placeholder={t("datafonosBusinessCodePlaceholder")}
          className="flex-1 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm font-mono focus:outline-none focus:border-terracotta"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("datafonosBusinessCodeSaving") : t("datafonosBusinessCodeBtn")}
        </button>
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
  users,
  onPatch,
}: {
  device: Device;
  users: UserOption[];
  onPatch: (next: Partial<Device>) => void;
}) {
  const t = useTranslations("opSettings");
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

  const assignedUser = users.find((u) => u.id === device.assignedUserId);

  return (
    <li className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <div className="font-display text-xl truncate">{device.label}</div>
          {device.lastSeenAt && (
            <div className="text-[11px] text-op-muted mt-0.5">
              {t("datafonosLastSeen", {
                date: new Date(device.lastSeenAt).toLocaleString("es-CO"),
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
      <div className="mb-4">
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

      <div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
          {t("datafonosAssignedMesero")}
        </div>
        <select
          value={device.assignedUserId ?? ""}
          onChange={(e) =>
            save({ assignedUserId: e.target.value === "" ? null : e.target.value })
          }
          disabled={busy}
          className="w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
        >
          <option value="">{t("datafonosUnassignedOption")}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {t("datafonosOptionLabel", {
                label: u.label,
                role: ROLE_LABEL_KEY[u.role] ? t(ROLE_LABEL_KEY[u.role]) : u.role,
              })}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-op-muted mt-2">
          {assignedUser
            ? t("datafonosAssignedHint", { name: assignedUser.label })
            : t("datafonosUnassignedHint")}
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
