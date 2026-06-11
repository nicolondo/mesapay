"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export function PerfilClient({
  initialName,
  email,
}: {
  initialName: string;
  email: string;
}) {
  const t = useTranslations("crm");
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/crm/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        setError(t("profileError"));
        return;
      }
      setSaved(true);
    } catch {
      setError(t("profileError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 p-4 max-w-2xl mx-auto w-full space-y-4">
      <div className="font-display text-2xl tracking-[-0.015em]">
        {t("profileTitle")}
      </div>

      <form onSubmit={handleSave} className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-4">
        <div>
          <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("profileFieldName")}
          </label>
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => { setName(e.target.value); setSaved(false); }}
            className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
          />
          <p className="text-xs text-op-muted mt-1">{t("profileNameHint")}</p>
        </div>

        <div>
          <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("profileFieldEmail")}
          </label>
          <p className="text-sm text-op-muted px-3 py-2.5 rounded-xl border border-op-border bg-op-bg break-all">
            {email}
          </p>
        </div>

        {error && <p className="text-sm text-terracotta">{error}</p>}
        {saved && <p className="text-sm text-green-600">{t("profileSaved")}</p>}

        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
        >
          {saving ? t("profileSaving") : t("profileSaveBtn")}
        </button>
      </form>
    </div>
  );
}
