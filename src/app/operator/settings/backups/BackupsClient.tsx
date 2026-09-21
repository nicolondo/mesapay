"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, localeTag } from "@/lib/format";

export type BackupDto = {
  id: string;
  kind: "manual" | "auto" | "pre_restore";
  sizeBytes: number;
  tableCounts: Record<string, number>;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  createdBy: { name: string | null; email: string } | null;
};

// Debe coincidir con RESTORE_CONFIRM_WORD del servidor (src/lib/backups).
// No se traduce: es la palabra que el servidor exige, en cualquier idioma.
const CONFIRM_WORD = "RESTAURAR";

type Pending = { kind: "restore" | "delete"; id: string } | null;
type Notice = { tone: "ok" | "error"; text: string } | null;

export function BackupsClient({ initial }: { initial: BackupDto[] }) {
  const t = useTranslations("opBackups");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [backups, setBackups] = useState<BackupDto[]>(initial);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"create" | "restore" | "delete" | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmText, setConfirmText] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const numberFmt = new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 });
  const when = (iso: string) => formatDate(iso, { locale });
  const size = (bytes: number) =>
    bytes < 1024
      ? t("sizeBytes", { n: numberFmt.format(bytes) })
      : bytes < 1024 * 1024
        ? t("sizeKb", { n: numberFmt.format(bytes / 1024) })
        : t("sizeMb", { n: numberFmt.format(bytes / (1024 * 1024)) });
  const records = (counts: Record<string, number>) =>
    Object.values(counts).reduce((a, b) => a + b, 0);
  const kindLabel = (kind: BackupDto["kind"]) =>
    kind === "auto" ? t("kindAuto") : kind === "pre_restore" ? t("kindPreRestore") : t("kindManual");
  const kindTint = (kind: BackupDto["kind"]) =>
    kind === "auto"
      ? "bg-paper text-op-muted"
      : kind === "pre_restore"
        ? "bg-[#C98A2E]/20 text-[#8F6828]"
        : "bg-ok/15 text-ok";

  function errorText(code: string | undefined, extra?: { missing?: string[]; max?: number }): string {
    switch (code) {
      case "too_many":
        return t("errorTooMany", { max: extra?.max ?? 5 });
      case "confirm_required":
        return t("errorConfirm");
      case "backup_missing_tables":
        return t("errorMissingTables", { tables: (extra?.missing ?? []).join(", ") });
      case "not_found":
      case "backup_not_found":
        return t("errorNotFound");
      default:
        return t("errorGeneric");
    }
  }

  async function reload() {
    const res = await fetch("/api/operator/backups", { cache: "no-store" });
    if (!res.ok) throw new Error("list_failed");
    const j = (await res.json()) as { backups: BackupDto[] };
    setBackups(j.backups);
  }

  async function create() {
    setBusy("create");
    setNotice(null);
    try {
      const res = await fetch("/api/operator/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: note.trim() || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "error", text: errorText(j?.error, j) });
        return;
      }
      setNote("");
      await reload();
      setNotice({ tone: "ok", text: t("createdOk") });
    } catch {
      setNotice({ tone: "error", text: t("errorGeneric") });
    } finally {
      setBusy(null);
    }
  }

  async function restore(id: string) {
    setBusy("restore");
    setNotice(null);
    try {
      const res = await fetch(`/api/operator/backups/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restore", confirm: confirmText.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "error", text: errorText(j?.error, j) });
        return;
      }
      setPending(null);
      setConfirmText("");
      await reload();
      setNotice({ tone: "ok", text: t("restoredOk") });
      // Todo el comercio cambió: que cada pantalla del panel se vuelva a leer.
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: t("errorGeneric") });
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy("delete");
    setNotice(null);
    try {
      const res = await fetch(`/api/operator/backups/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "error", text: errorText(j?.error) });
        return;
      }
      setPending(null);
      await reload();
      setNotice({ tone: "ok", text: t("deletedOk") });
    } catch {
      setNotice({ tone: "error", text: t("errorGeneric") });
    } finally {
      setBusy(null);
    }
  }

  function openPending(next: Pending) {
    setPending(next);
    setConfirmText("");
    setNotice(null);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
          {t("createKicker")}
        </div>
        <p className="text-sm text-op-muted mb-3">{t("createHelp")}</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder={t("notePlaceholder")}
            aria-label={t("noteLabel")}
            className="flex-1 h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
          />
          <button
            type="button"
            onClick={create}
            disabled={busy !== null}
            className="mp-btn mp-btn--primary mp-btn--sm"
          >
            {busy === "create" ? t("creating") : t("createButton")}
          </button>
        </div>
      </section>

      {notice && (
        <div
          role="status"
          className={
            "rounded-xl border p-3 text-sm " +
            (notice.tone === "ok"
              ? "border-ok/40 bg-ok/10 text-ok"
              : "border-danger/40 bg-danger/10 text-danger")
          }
        >
          {notice.text}
        </div>
      )}

      <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-op-border bg-op-bg/40">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("listKicker")}
          </div>
          <span className="text-xs text-op-muted">{t("listCount", { count: backups.length })}</span>
        </div>
        {backups.length === 0 && (
          <div className="px-5 py-8 text-sm text-op-muted text-center">{t("empty")}</div>
        )}
        <ul>
          {backups.map((b) => (
            <li key={b.id} className="border-b border-op-border last:border-b-0">
              <div className="px-5 py-4 flex flex-col md:flex-row md:items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{when(b.createdAt)}</span>
                    <span
                      className={
                        "font-mono text-[10px] tracking-[0.12em] uppercase rounded-full px-2 py-0.5 " +
                        kindTint(b.kind)
                      }
                    >
                      {kindLabel(b.kind)}
                    </span>
                  </div>
                  <div className="text-xs text-op-muted mt-1">
                    {t("rowMeta", {
                      size: size(b.sizeBytes),
                      records: records(b.tableCounts),
                      expires: when(b.expiresAt),
                    })}
                  </div>
                  {(b.note || b.createdBy) && (
                    <div className="text-xs text-op-muted mt-0.5 truncate">
                      {b.createdBy && (
                        <span>{t("byUser", { name: b.createdBy.name || b.createdBy.email })}</span>
                      )}
                      {b.note && b.createdBy && <span>{" · "}</span>}
                      {b.note && <span className="italic">{b.note}</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => openPending({ kind: "restore", id: b.id })}
                    disabled={busy !== null}
                    className="mp-btn mp-btn--secondary mp-btn--sm"
                  >
                    {t("restore")}
                  </button>
                  <button
                    type="button"
                    onClick={() => openPending({ kind: "delete", id: b.id })}
                    disabled={busy !== null}
                    className="mp-btn mp-btn--danger mp-btn--sm"
                  >
                    {t("delete")}
                  </button>
                </div>
              </div>

              {pending?.id === b.id && pending.kind === "restore" && (
                <div className="mx-5 mb-4 rounded-xl border border-danger/40 bg-op-bg p-4 space-y-3">
                  <div className="text-sm font-medium">{t("restoreTitle", { date: when(b.createdAt) })}</div>
                  <p className="text-xs text-op-muted">{t("restoreBody")}</p>
                  <p className="text-xs text-op-muted">{t("restoreSafety")}</p>
                  <label className="block text-xs text-op-muted">
                    {t("restoreTypeLabel", { word: CONFIRM_WORD })}
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={CONFIRM_WORD}
                      autoComplete="off"
                      className="mt-1 w-full px-3 h-10 rounded-lg border border-op-border bg-op-surface text-sm font-mono"
                    />
                  </label>
                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => openPending(null)}
                      disabled={busy !== null}
                      className="mp-btn mp-btn--secondary mp-btn--sm"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => restore(b.id)}
                      disabled={busy !== null || confirmText.trim() !== CONFIRM_WORD}
                      className="mp-btn mp-btn--danger-solid mp-btn--sm"
                    >
                      {busy === "restore" ? t("restoring") : t("restoreCta")}
                    </button>
                  </div>
                </div>
              )}

              {pending?.id === b.id && pending.kind === "delete" && (
                <div className="mx-5 mb-4 rounded-xl border border-op-border bg-op-bg p-4 space-y-3">
                  <div className="text-sm font-medium">{t("deleteTitle", { date: when(b.createdAt) })}</div>
                  <p className="text-xs text-op-muted">{t("deleteBody")}</p>
                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => openPending(null)}
                      disabled={busy !== null}
                      className="mp-btn mp-btn--secondary mp-btn--sm"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(b.id)}
                      disabled={busy !== null}
                      className="mp-btn mp-btn--danger-solid mp-btn--sm"
                    >
                      {busy === "delete" ? t("deleting") : t("deleteCta")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-op-muted">{t("footNote")}</p>
    </div>
  );
}
