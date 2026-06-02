"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Inline rename for a restaurant from the admin detail view. Shows
 * the name as a big display-style heading; tapping "Editar" turns it
 * into an input that saves on blur or Enter. We intentionally don't
 * expose slug editing here — slugs are baked into every printed QR
 * and changing one silently is a footgun.
 */
export function RestaurantNameEditor({
  restaurantId,
  initialName,
}: {
  restaurantId: string;
  initialName: string;
}) {
  const t = useTranslations("opAdmin");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initialName);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) {
      setDraft(name);
      setEditing(false);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/admin/restaurants/${restaurantId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    setBusy(false);
    if (!res.ok) {
      alert(t("renameFailed"));
      setDraft(name);
      return;
    }
    setName(trimmed);
    setEditing(false);
    // Refresh the page so other places that show the name (the
    // operator-side header, the impersonate banner) pick up the new
    // value on next nav.
    startTx(() => router.refresh());
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={80}
          disabled={busy}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
          }}
          className="font-display text-3xl px-2 -mx-2 bg-transparent border-b-2 border-ink focus:outline-none min-w-0 w-full"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="font-display text-3xl">{name}</div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-[11px] text-op-muted hover:text-ink font-mono tracking-wider uppercase"
      >
        {t("renameTitle")}
      </button>
    </div>
  );
}
