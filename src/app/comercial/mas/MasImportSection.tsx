"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

/**
 * Simple CSV import section for /comercial/mas.
 * Accepts file upload or textarea paste, POSTs to /api/crm/import.
 */
export function MasImportSection() {
  const t = useTranslations("crm");
  const [text, setText] = useState("");
  const [hasFile, setHasFile] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    startTransition(async () => {
      try {
        let csv = text;
        const file = fileRef.current?.files?.[0];
        if (file) {
          csv = await file.text();
        }
        if (!csv.trim()) return;

        const res = await fetch("/api/crm/import", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: csv,
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? "error");
        } else {
          setResult({ created: json.created ?? 0, skipped: json.skipped ?? 0 });
          setText("");
          setHasFile(false);
          if (fileRef.current) fileRef.current.value = "";
        }
      } catch {
        setError("network_error");
      }
    });
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="font-display text-base mb-1">{t("importTitle")}</div>
      <p className="text-xs text-op-muted mb-3">{t("importDesc")}</p>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* File input */}
        <label className="block">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("importFile")}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setHasFile(!!(e.target.files?.length))}
            className="mt-1 block w-full text-sm text-op-muted file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-op-border file:text-xs file:font-mono file:bg-op-bg file:text-op-text file:cursor-pointer"
          />
        </label>

        {/* Paste area */}
        <label className="block">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("importPaste")}
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="mt-1 block w-full text-sm bg-op-bg border border-op-border rounded-lg px-3 py-2 font-mono resize-none focus:outline-none focus:ring-1 focus:ring-terracotta"
            placeholder={"nombre,ciudad,telefono\n"}
          />
        </label>

        <button
          type="submit"
          disabled={pending || (!text.trim() && !hasFile)}
          className="w-full py-2.5 px-4 rounded-xl bg-terracotta text-white text-sm font-medium disabled:opacity-50 min-h-[44px]"
        >
          {pending ? t("importImporting") : t("importSubmit")}
        </button>
      </form>

      {result && (
        <p className="mt-3 text-sm text-ok font-medium">
          {t("importResult", { created: result.created, skipped: result.skipped })}
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-terracotta">{error}</p>
      )}
    </div>
  );
}
