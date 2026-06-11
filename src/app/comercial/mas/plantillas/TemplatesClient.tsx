"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

type DocOption = { id: string; name: string; scope: string };

type Template = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
  scope: string;
  ownerUserId: string | null;
};

function TemplateSheet({
  template,
  docs,
  userId,
  isAdmin,
  onSaved,
  onDeleted,
  onClose,
}: {
  template: Template | null; // null = create
  docs: DocOption[];
  userId: string;
  isAdmin: boolean;
  onSaved: (t: Template) => void;
  onDeleted?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("crm");
  const isEdit = !!template;

  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(template?.bodyHtml ?? "");
  const [attachmentIds, setAttachmentIds] = useState<string[]>(
    template?.attachmentIds ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function toggleAttachment(id: string) {
    setAttachmentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const url = isEdit
        ? `/api/crm/templates/${template!.id}`
        : "/api/crm/templates";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          subject: subject.trim(),
          bodyHtml: bodyHtml.trim(),
          attachmentIds,
          scope: "user",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(t("templateSaveError"));
        return;
      }
      onSaved(json.template);
    } catch {
      setError(t("templateSaveError"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!template) return;
    if (!confirm(t("templateDeleteConfirm"))) return;
    setDeleting(true);
    const res = await fetch(`/api/crm/templates/${template.id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      onDeleted?.();
    } else {
      setError(t("templateDeleteError"));
      setDeleting(false);
    }
  }

  const canDelete =
    isEdit &&
    (isAdmin ||
      (template?.scope === "user" && template?.ownerUserId === userId));

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 bg-op-surface rounded-t-2xl max-h-[90dvh] flex flex-col shadow-xl" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-op-border" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-op-border shrink-0">
          <div className="font-display text-xl">{isEdit ? t("templateEditTitle") : t("templateNewTitle")}</div>
          <button onClick={onClose} className="p-2 rounded-lg text-op-muted hover:text-op-text min-h-[44px] min-w-[44px] flex items-center justify-center">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSave} className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              {t("templateFieldName")}
            </label>
            <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              {t("templateFieldSubject")}
            </label>
            <input type="text" required value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta min-h-[44px]" />
          </div>
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              {t("templateFieldBody")}
            </label>
            <p className="text-xs text-op-muted mb-1">{t("templateBodyHint")}</p>
            <textarea
              required value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)}
              rows={6}
              className="w-full px-3 py-2.5 rounded-xl border border-op-border bg-op-bg text-sm focus:outline-none focus:ring-1 focus:ring-terracotta resize-y font-mono"
            />
          </div>
          {docs.length > 0 && (
            <div>
              <label className="block font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
                {t("templateFieldAttachments")}
              </label>
              <div className="space-y-2">
                {docs.map((doc) => (
                  <label key={doc.id} className="flex items-center gap-3 cursor-pointer min-h-[44px] px-3 py-2 rounded-xl border border-op-border hover:bg-op-bg">
                    <input
                      type="checkbox"
                      checked={attachmentIds.includes(doc.id)}
                      onChange={() => toggleAttachment(doc.id)}
                      className="w-4 h-4 rounded accent-terracotta"
                    />
                    <span className="text-sm flex-1">{doc.name}</span>
                    <span className={"font-mono text-[9px] uppercase " + (doc.scope === "global" ? "text-violet-600" : "text-slate-500")}>
                      {doc.scope}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-sm text-terracotta">{error}</p>}
          <div className="flex gap-3">
            {canDelete && (
              <button type="button" onClick={handleDelete} disabled={deleting}
                className="px-4 py-3 rounded-xl border border-rose-300 text-rose-500 text-sm font-medium min-h-[44px] hover:bg-rose-50 transition-colors disabled:opacity-50">
                {t("templateDeleteBtn")}
              </button>
            )}
            <button type="submit" disabled={saving}
              className="flex-1 py-3.5 rounded-xl bg-terracotta text-white font-medium disabled:opacity-50 min-h-[44px]">
              {saving ? t("templateSaving") : t("templateSaveBtn")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TemplatesClient({
  initial,
  docs,
  userId,
  isAdmin,
}: {
  initial: Template[];
  docs: DocOption[];
  userId: string;
  isAdmin: boolean;
}) {
  const t = useTranslations("crm");
  const [templates, setTemplates] = useState<Template[]>(initial);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [showNew, setShowNew] = useState(false);

  function handleSaved(tpl: Template) {
    setTemplates((prev) => {
      const existing = prev.findIndex((x) => x.id === tpl.id);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = tpl;
        return updated;
      }
      return [tpl, ...prev];
    });
    setEditingTemplate(null);
    setShowNew(false);
  }

  return (
    <div className="flex-1 p-4 max-w-lg mx-auto w-full space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-display text-2xl tracking-[-0.015em]">
          {t("templatesPageTitle")}
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="px-3 py-2 rounded-xl bg-terracotta text-white text-sm font-medium min-h-[44px]"
        >
          {"+ " + t("templateNewBtn")}
        </button>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-op-muted py-8 text-center">{t("templatesEmpty")}</p>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface divide-y divide-op-border">
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => setEditingTemplate(tpl)}
              className="w-full flex items-center justify-between px-4 py-4 min-h-[44px] hover:bg-op-bg transition-colors text-left"
            >
              <div className="flex-1 min-w-0 mr-3">
                <div className="text-sm font-medium">{tpl.name}</div>
                <div className="text-xs text-op-muted truncate">{tpl.subject}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {tpl.scope === "global" && (
                  <span className="font-mono text-[9px] uppercase text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">
                    {t("templateGlobalBadge")}
                  </span>
                )}
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-op-muted">
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
              </div>
            </button>
          ))}
        </div>
      )}

      {showNew && (
        <TemplateSheet
          template={null}
          docs={docs}
          userId={userId}
          isAdmin={isAdmin}
          onSaved={handleSaved}
          onClose={() => setShowNew(false)}
        />
      )}

      {editingTemplate && (
        <TemplateSheet
          template={editingTemplate}
          docs={docs}
          userId={userId}
          isAdmin={isAdmin}
          onSaved={handleSaved}
          onDeleted={() => {
            setTemplates((prev) => prev.filter((x) => x.id !== editingTemplate.id));
            setEditingTemplate(null);
          }}
          onClose={() => setEditingTemplate(null)}
        />
      )}
    </div>
  );
}
