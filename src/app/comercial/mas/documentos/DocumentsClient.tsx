"use client";

import { useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";

type Doc = {
  id: string;
  name: string;
  size: number;
  mime: string;
  scope: string;
  ownerUserId: string | null;
  fileUrl: string;
  createdAt: string;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
]);
const MAX_BYTES = 15 * 1024 * 1024;

// ── Per-file upload state ──────────────────────────────────────────────────

type FileStatus = "uploading" | "done" | "error";

type FileEntry = {
  /** Stable key for React rendering */
  key: string;
  name: string;
  status: FileStatus;
  /** Validation error message (set before uploading starts) */
  error?: string;
};

// ── Dropzone component ─────────────────────────────────────────────────────

function DropZone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("crm");
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles],
  );

  const handleClick = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) onFiles(files);
      // Reset so re-selecting the same file fires onChange again
      e.target.value = "";
    },
    [onFiles],
  );

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={t("docsDropzone")}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleClick();
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDragEnter={handleDragOver}
      onDrop={handleDrop}
      className={[
        "relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer select-none",
        isDragOver
          ? "border-terracotta bg-terracotta/5 text-terracotta"
          : "border-op-border bg-op-bg text-op-muted hover:border-terracotta/60",
        disabled ? "opacity-50 cursor-not-allowed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Upload icon */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="w-10 h-10 shrink-0"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
        />
      </svg>
      <p className="text-sm font-medium">
        {isDragOver ? t("docsDropzoneActive") : t("docsDropzone")}
      </p>
      <p className="text-xs opacity-70">{"PDF, PNG, JPG · máx. 15 MB"}</p>

      {/* Hidden native file picker — multiple, same MIME whitelist */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg"
        multiple
        className="sr-only"
        onChange={handleInputChange}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}

// ── FileProgressList ───────────────────────────────────────────────────────

function FileProgressList({ entries }: { entries: FileEntry[] }) {
  const t = useTranslations("crm");

  if (entries.length === 0) return null;

  return (
    <ul className="space-y-1.5">
      {entries.map((entry) => (
        <li
          key={entry.key}
          className="flex items-center gap-2 rounded-xl border border-op-border bg-op-surface px-3 py-2.5 text-sm"
        >
          {/* Status indicator */}
          <span className="shrink-0">
            {entry.status === "uploading" && (
              <svg
                className="w-4 h-4 animate-spin text-op-muted"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
            )}
            {entry.status === "done" && (
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-4 h-4 text-green-500"
              >
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            {entry.status === "error" && (
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-4 h-4 text-terracotta"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </span>

          {/* File name */}
          <span className="flex-1 min-w-0 truncate">{entry.name}</span>

          {/* Status label */}
          <span
            className={
              "shrink-0 text-xs font-medium " +
              (entry.status === "done"
                ? "text-green-600"
                : entry.status === "error"
                  ? "text-terracotta"
                  : "text-op-muted")
            }
          >
            {entry.error
              ? entry.error
              : entry.status === "uploading"
                ? t("docsUploadStatusUploading")
                : entry.status === "done"
                  ? t("docsUploadStatusDone")
                  : t("docsUploadStatusError")}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function DocumentsClient({
  initial,
  userId,
  isAdmin,
}: {
  initial: Doc[];
  userId: string;
  isAdmin: boolean;
}) {
  const t = useTranslations("crm");
  const [docs, setDocs] = useState<Doc[]>(initial);

  // ── Drop zone upload state
  const [uploadEntries, setUploadEntries] = useState<FileEntry[]>([]);
  const uploadingRef = useRef(false);

  // ── Legacy single-file sheet state (kept for backwards compat / name field)
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [docName, setDocName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Drop zone: handle files ────────────────────────────────────────────

  const handleDropFiles = useCallback(
    async (files: File[]) => {
      // Build entries, validating each file up-front
      const entries: FileEntry[] = files.map((f) => {
        const key = `${f.name}-${f.size}-${Date.now()}-${Math.random()}`;
        if (f.size > MAX_BYTES) {
          return { key, name: f.name, status: "error" as FileStatus, error: t("docsFileTooLarge") };
        }
        if (!ALLOWED_MIME.has(f.type)) {
          return { key, name: f.name, status: "error" as FileStatus, error: t("docsUnsupportedFormat") };
        }
        return { key, name: f.name, status: "uploading" as FileStatus };
      });

      setUploadEntries(entries);

      // Upload sequentially, only the valid ones
      for (let i = 0; i < files.length; i++) {
        const entry = entries[i];
        if (entry.status === "error") continue; // validation failed — skip

        const file = files[i];
        try {
          const form = new FormData();
          form.append("file", file);
          form.append("name", file.name);
          form.append("scope", "user");

          const res = await fetch("/api/crm/documents", {
            method: "POST",
            body: form,
          });

          if (res.ok) {
            const json = await res.json();
            setDocs((prev) => [json.document, ...prev]);
            setUploadEntries((prev) =>
              prev.map((e) =>
                e.key === entry.key ? { ...e, status: "done" } : e,
              ),
            );
          } else {
            setUploadEntries((prev) =>
              prev.map((e) =>
                e.key === entry.key
                  ? { ...e, status: "error", error: t("docsUploadError") }
                  : e,
              ),
            );
          }
        } catch {
          setUploadEntries((prev) =>
            prev.map((e) =>
              e.key === entry.key
                ? { ...e, status: "error", error: t("docsUploadError") }
                : e,
            ),
          );
        }
      }

      uploadingRef.current = false;
    },
    [t],
  );

  const isUploading = uploadEntries.some((e) => e.status === "uploading");

  // ── Legacy single-file upload (sheet) ────────────────────────────────────

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    if (file.size > MAX_BYTES) {
      setUploadError(t("docsFileTooLarge"));
      return;
    }

    if (!ALLOWED_MIME.has(file.type)) {
      setUploadError(t("docsUnsupportedFormat"));
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", docName.trim() || file.name);
      form.append("scope", "user");

      const res = await fetch("/api/crm/documents", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!res.ok) {
        setUploadError(t("docsUploadError"));
        return;
      }
      setDocs((prev) => [json.document, ...prev]);
      setShowUpload(false);
      setDocName("");
      if (fileRef.current) fileRef.current.value = "";
    } catch {
      setUploadError(t("docsUploadError"));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc: Doc) {
    const res = await fetch(`/api/crm/documents/${doc.id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    }
  }

  const canDelete = (doc: Doc) =>
    isAdmin || (doc.scope === "user" && doc.ownerUserId === userId);

  return (
    <div className="flex-1 p-4 max-w-lg mx-auto w-full space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-display text-2xl tracking-[-0.015em]">
          {t("docsPageTitle")}
        </div>
        <button
          onClick={() => { setShowUpload(true); setUploadError(null); }}
          className="px-3 py-2 rounded-xl bg-terracotta text-white text-sm font-medium min-h-[44px]"
        >
          {"+ " + t("docsUploadBtn")}
        </button>
      </div>

      {/* ── Drop zone ── */}
      <DropZone onFiles={handleDropFiles} disabled={isUploading} />

      {/* ── Per-file progress list ── */}
      <FileProgressList entries={uploadEntries} />

      {docs.length === 0 ? (
        <p className="text-sm text-op-muted py-8 text-center">{t("docsEmptyList")}</p>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface divide-y divide-op-border">
          {docs.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 px-4 py-3">
              <div className="w-8 h-8 rounded-lg bg-op-bg flex items-center justify-center shrink-0">
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-op-muted">
                  <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{doc.name}</div>
                <div className="text-xs text-op-muted">
                  {formatBytes(doc.size)}
                  {" · "}
                  <span className={"font-mono text-[9px] uppercase tracking-wider px-1 py-0.5 rounded " + (doc.scope === "global" ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600")}>
                    {doc.scope === "global" ? t("docsGlobalBadge") : t("docsOwnBadge")}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={doc.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-terracotta hover:underline min-h-[44px] flex items-center px-2"
                >
                  {"↓"}
                </a>
                {canDelete(doc) && (
                  <button
                    onClick={() => handleDelete(doc)}
                    className="text-xs text-rose-500 hover:underline min-h-[44px] flex items-center px-2"
                  >
                    {t("docsDeleteBtn")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload sheet (name-based, single file) */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowUpload(false)} aria-hidden="true" />
          <div className="relative z-10 bg-op-surface rounded-t-2xl max-h-[80dvh] flex flex-col shadow-xl" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
            <div className="flex justify-center pt-3 pb-1 shrink-0">
              <div className="w-10 h-1 rounded-full bg-op-border" />
            </div>
            <div className="flex items-center justify-between px-4 py-3 border-b border-op-border shrink-0">
              <div className="font-display text-xl">{t("docsUploadTitle")}</div>
              <button onClick={() => setShowUpload(false)} className="p-2 rounded-lg text-op-muted hover:text-op-text min-h-[44px] min-w-[44px] flex items-center justify-center">
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleUpload} className="px-4 py-4 space-y-4 overflow-y-auto">
              <div>
                <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
                  {t("docsFieldName")}
                </label>
                <input
                  type="text"
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
                  {t("docsFieldFile")}
                </label>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  required
                  className="w-full text-sm text-op-text file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-medium file:bg-terracotta/10 file:text-terracotta hover:file:bg-terracotta/20"
                />
              </div>
              {uploadError && <p className="text-sm text-terracotta">{uploadError}</p>}
              <button
                type="submit"
                disabled={uploading}
                className="w-full py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]"
              >
                {uploading ? t("docsUploading") : t("docsUploadSubmit")}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
