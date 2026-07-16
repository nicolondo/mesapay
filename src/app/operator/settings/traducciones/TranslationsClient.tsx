"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Item = {
  id: string;
  name: string;
  description: string | null;
  nameEn: string;
  namePt: string;
  descEn: string;
  descPt: string;
};
type Group = {
  categoryId: string;
  categoryLabel: string;
  categoryEn: string;
  categoryPt: string;
  items: Item[];
};

export function TranslationsClient({
  groups,
  itemCount,
}: {
  groups: Group[];
  itemCount: number;
}) {
  const t = useTranslations("opTranslations");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [, startTransition] = useTransition();

  async function generate(force = false) {
    if (force && !confirm(t("retranslateConfirm"))) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/operator/menu-translations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "error", text: j.message || t("generateFailed") });
        return;
      }
      setMsg({ kind: "ok", text: t("generatedOk", { count: j.strings ?? 0 }) });
      startTransition(() => router.refresh());
    } catch {
      setMsg({ kind: "error", text: t("generateFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Acción IA */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <div className="font-display text-lg">{t("aiTitle")}</div>
          <p className="text-sm text-op-muted mt-0.5">
            {t("aiSubtitle", { count: itemCount })}
          </p>
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <button
            type="button"
            onClick={() => generate(false)}
            disabled={busy}
            className="mp-btn mp-btn--primary mp-btn--sm"
          >
            {busy ? t("generating") : t("generateBtn")}
          </button>
          <button
            type="button"
            onClick={() => generate(true)}
            disabled={busy}
            className="text-[12px] text-op-muted underline hover:text-ink disabled:opacity-60"
          >
            {t("retranslateBtn")}
          </button>
        </div>
      </div>
      {busy && <p className="text-[11px] text-op-muted">{t("generatingHint")}</p>}
      {msg && (
        <div
          className={
            "text-sm " + (msg.kind === "ok" ? "text-ok" : "text-danger")
          }
        >
          {msg.text}
        </div>
      )}

      {/* Encabezado de columnas */}
      <div className="hidden md:grid grid-cols-3 gap-3 px-1 font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        <span>{t("colEs")}</span>
        <span>{t("colEn")}</span>
        <span>{t("colPt")}</span>
      </div>

      {groups.map((g) => (
        <div
          key={g.categoryId}
          className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3"
        >
          {/* Categoría */}
          {g.categoryId !== "__orphan__" && (
            <Row
              label={t("categoryField")}
              source={g.categoryLabel}
              en={g.categoryEn}
              pt={g.categoryPt}
              entityType="Category"
              entityId={g.categoryId}
              field="label"
            />
          )}
          {g.categoryId === "__orphan__" && (
            <div className="font-display text-lg">{g.categoryLabel}</div>
          )}

          {/* Platos */}
          <ul className="space-y-3">
            {g.items.map((it) => (
              <li
                key={it.id}
                className="border-t border-op-border/60 pt-3 space-y-2"
              >
                <Row
                  label={t("dishField")}
                  source={it.name}
                  en={it.nameEn}
                  pt={it.namePt}
                  entityType="MenuItem"
                  entityId={it.id}
                  field="name"
                />
                {it.description && it.description.trim() ? (
                  <Row
                    label={t("descField")}
                    source={it.description}
                    en={it.descEn}
                    pt={it.descPt}
                    entityType="MenuItem"
                    entityId={it.id}
                    field="description"
                    multiline
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Fila ES (origen, solo lectura) + EN + PT editables (save-on-blur). */
function Row({
  label,
  source,
  en,
  pt,
  entityType,
  entityId,
  field,
  multiline,
}: {
  label: string;
  source: string;
  en: string;
  pt: string;
  entityType: string;
  entityId: string;
  field: string;
  multiline?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-start">
      <div className="min-w-0">
        <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
          {label}
        </div>
        <div className="text-sm text-ink break-words">{source}</div>
      </div>
      <Cell
        value={en}
        locale="en"
        entityType={entityType}
        entityId={entityId}
        field={field}
        multiline={multiline}
      />
      <Cell
        value={pt}
        locale="pt"
        entityType={entityType}
        entityId={entityId}
        field={field}
        multiline={multiline}
      />
    </div>
  );
}

function Cell({
  value,
  locale,
  entityType,
  entityId,
  field,
  multiline,
}: {
  value: string;
  locale: string;
  entityType: string;
  entityId: string;
  field: string;
  multiline?: boolean;
}) {
  const t = useTranslations("opTranslations");
  const [val, setVal] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "ok" | "error">("idle");

  async function save() {
    if (val === value) return;
    setState("saving");
    const res = await fetch("/api/operator/menu-translations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityType, entityId, field, locale, value: val }),
    });
    setState(res.ok ? "ok" : "error");
  }

  const cls =
    "w-full px-2.5 py-1.5 rounded-lg border bg-op-bg text-sm focus:outline-none focus:border-terracotta " +
    (state === "error"
      ? "border-danger"
      : state === "ok"
        ? "border-ok/50"
        : "border-op-border");

  return (
    <div>
      {multiline ? (
        <textarea
          value={val}
          rows={2}
          onChange={(e) => {
            setVal(e.target.value);
            setState("idle");
          }}
          onBlur={save}
          placeholder={t("placeholder")}
          className={cls + " resize-y"}
        />
      ) : (
        <input
          type="text"
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            setState("idle");
          }}
          onBlur={save}
          placeholder={t("placeholder")}
          className={cls}
        />
      )}
    </div>
  );
}
