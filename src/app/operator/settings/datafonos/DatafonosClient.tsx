"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

type Device = {
  id: string;
  label: string;
  kushkiDeviceId: string;
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
}: {
  initial: Device[];
  users: UserOption[];
}) {
  const [devices, setDevices] = useState<Device[]>(initial);

  function patch(deviceId: string, next: Partial<Device>) {
    setDevices((prev) =>
      prev.map((d) => (d.id === deviceId ? { ...d, ...next } : d)),
    );
  }

  return (
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
          <div className="font-mono text-[11px] text-op-muted truncate">
            {t("datafonosDeviceId", { id: device.kushkiDeviceId })}
          </div>
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
