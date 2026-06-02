"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function DeleteTableButton({
  tableId,
  number,
}: {
  tableId: string;
  number: number;
}) {
  const t = useTranslations("opTables");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function del() {
    const ok = window.confirm(t("confirmDeleteTable", { number }));
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/operator/tables/${tableId}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error ?? t("deleteTableFailed"));
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <button
      onClick={del}
      disabled={busy}
      className="text-[11px] text-op-muted hover:text-danger disabled:opacity-60"
      title={t("deleteTableTitle")}
    >
      {busy ? "…" : t("deleteTable")}
    </button>
  );
}

export function EditLabelButton({
  tableId,
  currentLabel,
}: {
  tableId: string;
  currentLabel: string | null;
}) {
  const t = useTranslations("opTables");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function save() {
    setBusy(true);
    const res = await fetch(`/api/operator/tables/${tableId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: value.trim() || null }),
    });
    setBusy(false);
    if (!res.ok) {
      alert(t("saveLabelFailed"));
      return;
    }
    setEditing(false);
    startTx(() => router.refresh());
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-xs text-op-muted hover:text-ink text-left truncate"
      >
        {currentLabel || t("addLabel")}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={40}
        placeholder={t("labelPlaceholder")}
        className="h-7 px-2 rounded border border-op-border bg-op-bg text-xs flex-1 min-w-0"
      />
      <button
        onClick={save}
        disabled={busy}
        className="text-xs text-terracotta font-medium"
      >
        {t("labelOk")}
      </button>
      <button
        onClick={() => {
          setEditing(false);
          setValue(currentLabel ?? "");
        }}
        className="text-xs text-op-muted"
      >
        {"×"}
      </button>
    </div>
  );
}
