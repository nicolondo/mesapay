"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

type ImportIssue = {
  line: number;
  code: string;
  reason: string;
};

type Account = {
  code: string;
  name: string;
  type: string;
  nature: string;
  level: number;
  parentCode: string | null;
  postable: boolean;
  active: boolean;
};

type Suggestion = {
  parentCode: string;
  parentName: string;
  code: string;
  name: string;
  type: string;
  nature: string;
  note: string | null;
};

type NewAccountForm = { parentCode: string; code: string; name: string };

const CHART_URL = "/api/operator/accounting/chart";

/** Una cuenta puede recibir hijas hasta los 8 dígitos (la hija llega a 10). */
const MAX_PARENT_LEN = 8;

/** Máximo de coincidencias que muestra el selector de madre. */
const PARENT_LIMIT = 80;

const EMPTY_FORM: NewAccountForm = { parentCode: "", code: "", name: "" };

/**
 * Plan de cuentas (PUC NIIF Grupo 2): catálogo jerárquico del comercio con
 * alta y edición de cuentas una por una (auxiliares con traslado de
 * movimientos), sugerencia con IA, importación del PUC del contador (CSV
 * pegado, aditivo) y export CSV reimportable.
 */
export function PlanCuentasTab() {
  const t = useTranslations("opErp");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // Importación CSV
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);

  // Nueva cuenta
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<NewAccountForm>(EMPTY_FORM);
  const [parentQ, setParentQ] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  // Sugerir con IA
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiFilled, setAiFilled] = useState(false);

  // Edición en línea
  const [editing, setEditing] = useState<{ code: string; name: string } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await fetch(`${CHART_URL}?all=1`);
    if (!r.ok) throw new Error("load");
    const j = await r.json();
    setAccounts(j.accounts as Account[]);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`${CHART_URL}?all=1`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setAccounts(j.accounts as Account[]);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const byCode = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.code, a])),
    [accounts],
  );

  async function runImport() {
    if (csv.trim().length < 3) return;
    setBusy(true);
    setImportMsg(null);
    setIssues([]);
    const res = await fetch(CHART_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setIssues((j.issues as ImportIssue[]) ?? []);
      setImportMsg(
        j.error === "empty" ? t("chartImportEmpty") : t("chartImportFailed"),
      );
      return;
    }
    setIssues((j.issues as ImportIssue[]) ?? []);
    setImportMsg(
      t("chartImportDone", {
        created: j.created ?? 0,
        updated: j.updated ?? 0,
        parents: j.parentsCreated ?? 0,
      }),
    );
    setCsv("");
    await reload().catch(() => setErr(true));
  }

  // ─── Nueva cuenta ───────────────────────────────────────────────
  function resetAi() {
    setAiErr(null);
    setAiNote(null);
    setAiWarnings([]);
    setAiFilled(false);
  }

  function openNewForm(parent?: Account) {
    setForm({
      parentCode: parent?.code ?? "",
      code: parent?.code ?? "",
      name: "",
    });
    setParentQ("");
    setFormErr(null);
    setNotice(null);
    setAiText("");
    resetAi();
    setEditing(null);
    setFormOpen(true);
    setImportOpen(false);
  }

  function closeForm() {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setFormErr(null);
    resetAi();
  }

  function pickParent(code: string) {
    setForm((f) => ({
      ...f,
      parentCode: code,
      // El código nuevo siempre extiende al de la madre: si el que había no
      // la extiende, se arranca de cero con el prefijo.
      code: code && f.code.startsWith(code) ? f.code : code,
    }));
    setFormErr(null);
  }

  // Candidatas a madre: activas y con lugar para una hija; por defecto se
  // muestran las cuentas (4) y subcuentas (6) hasta que el usuario busca.
  const parentOptions = useMemo(() => {
    if (!accounts) return { list: [] as Account[], truncated: false };
    const term = parentQ.trim().toLowerCase();
    const list: Account[] = [];
    let truncated = false;
    for (const a of accounts) {
      if (!a.active || a.code.length > MAX_PARENT_LEN) continue;
      const match = term
        ? a.code.startsWith(term) || a.name.toLowerCase().includes(term)
        : a.code.length >= 4;
      if (!match) continue;
      if (list.length >= PARENT_LIMIT) {
        truncated = true;
        break;
      }
      list.push(a);
    }
    const chosen = form.parentCode ? byCode.get(form.parentCode) : undefined;
    if (chosen && !list.some((a) => a.code === chosen.code)) list.unshift(chosen);
    return { list, truncated };
  }, [accounts, parentQ, form.parentCode, byCode]);

  const parent = form.parentCode ? byCode.get(form.parentCode) : undefined;

  async function submitNew() {
    if (!form.parentCode || !form.code.trim() || !form.name.trim()) return;
    setFormBusy(true);
    setFormErr(null);
    const res = await fetch(`${CHART_URL}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const j = await res.json().catch(() => ({}));
    setFormBusy(false);
    if (!res.ok) {
      setFormErr(t(ERROR_KEY[j.error as string] ?? "chartErr_generic"));
      return;
    }
    const moved = (j.transferredLines as number) ?? 0;
    setNotice(
      moved > 0
        ? t("chartCreatedTransfer", {
            code: j.account.code,
            parent: form.parentCode,
            count: moved,
          })
        : t("chartCreated", { code: j.account.code }),
    );
    closeForm();
    setQ("");
    await reload().catch(() => setErr(true));
  }

  async function runAi() {
    const description = aiText.trim();
    if (description.length < 5) return;
    setAiBusy(true);
    resetAi();
    const res = await fetch(`${CHART_URL}/ai-suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description,
        parentCodeHint: form.parentCode || undefined,
      }),
    });
    const j = await res.json().catch(() => ({}));
    setAiBusy(false);
    if (!res.ok) {
      setAiErr(t(AI_ERROR_KEY[j.error as string] ?? "chartAiErr_generic"));
      return;
    }
    const s = j.suggestion as Suggestion;
    setForm({ parentCode: s.parentCode, code: s.code, name: s.name });
    setParentQ("");
    setFormErr(null);
    setAiNote(s.note);
    setAiWarnings((j.warnings as string[]) ?? []);
    setAiFilled(true);
  }

  // ─── Edición en línea ───────────────────────────────────────────
  function startEdit(a: Account) {
    setEditing({ code: a.code, name: a.name });
    setEditErr(null);
    setNotice(null);
  }

  async function patchAccount(code: string, body: { name?: string; active?: boolean }) {
    setEditBusy(true);
    setEditErr(null);
    const res = await fetch(`${CHART_URL}/accounts/${encodeURIComponent(code)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    setEditBusy(false);
    if (!res.ok) {
      setEditErr(t(ERROR_KEY[j.error as string] ?? "chartErr_generic"));
      return;
    }
    setEditing(null);
    setNotice(t("chartUpdated", { code }));
    await reload().catch(() => setErr(true));
  }

  // Filtro por código/nombre que conserva las agrupadoras padres del match.
  const filtered = useMemo(() => {
    if (!accounts) return [];
    const term = q.trim().toLowerCase();
    if (!term) return accounts;
    const keep = new Set<string>();
    for (const a of accounts) {
      if (a.code.includes(term) || a.name.toLowerCase().includes(term)) {
        keep.add(a.code);
        let p = a.parentCode;
        while (p) {
          keep.add(p);
          p = byCode.get(p)?.parentCode ?? null;
        }
      }
    }
    return accounts.filter((a) => keep.has(a.code));
  }, [accounts, q, byCode]);

  if (err) {
    return <div className="text-sm text-danger">{t("cuentasError")}</div>;
  }
  if (!accounts) {
    return <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>;
  }

  const inputCls =
    "w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm";
  const labelCls =
    "font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted";

  return (
    <div className="space-y-3">
      <p className="text-xs text-op-muted">{t("cuentasIntro")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => (formOpen ? closeForm() : openNewForm())}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {t("chartNewOpen")}
        </button>
        <button
          type="button"
          onClick={() => {
            setImportOpen((v) => !v);
            if (!importOpen) closeForm();
          }}
          className="mp-btn mp-btn--secondary mp-btn--sm"
        >
          {t("chartImportOpen")}
        </button>
        <a
          href={`${CHART_URL}/export`}
          download="plan-de-cuentas.csv"
          className="mp-btn mp-btn--ghost mp-btn--sm"
        >
          {t("chartExportCta")}
        </a>
      </div>

      {notice && <p className="text-xs text-op-text">{notice}</p>}

      {formOpen && (
        <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className={labelCls}>{t("chartNewTitle")}</div>
            <button
              type="button"
              onClick={closeForm}
              className="text-[11px] text-op-muted hover:underline shrink-0"
            >
              {t("chartNewClose")}
            </button>
          </div>

          {/* Sugerir con IA */}
          <div className="rounded-xl border border-dashed border-op-border p-3 space-y-2">
            <div className={labelCls}>{t("chartAiTitle")}</div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runAi();
                  }
                }}
                placeholder={t("chartAiPlaceholder")}
                aria-label={t("chartAiTitle")}
                maxLength={300}
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => void runAi()}
                disabled={aiBusy || aiText.trim().length < 5}
                className="mp-btn mp-btn--accent mp-btn--sm shrink-0"
              >
                {aiBusy ? t("chartAiThinking") : t("chartAiCta")}
              </button>
            </div>
            {aiErr && <p className="text-xs text-danger">{aiErr}</p>}
            {aiFilled && (
              <p className="text-xs text-op-text">{t("chartAiFilled")}</p>
            )}
            {aiNote && (
              <p className="text-xs text-op-muted">{t("chartAiNote", { note: aiNote })}</p>
            )}
            {aiWarnings.length > 0 && (
              <ul className="space-y-0.5">
                {aiWarnings.map((w) => (
                  <li key={w} className="text-[11px] text-op-muted">
                    {t(AI_WARN_KEY[w] ?? "chartAiErr_generic")}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Madre */}
          <div className="space-y-1">
            <label className={labelCls} htmlFor="chart-parent-search">
              {t("chartParentLabel")}
            </label>
            <input
              id="chart-parent-search"
              type="search"
              value={parentQ}
              onChange={(e) => setParentQ(e.target.value)}
              placeholder={t("chartParentSearch")}
              className={inputCls}
            />
            <select
              value={form.parentCode}
              onChange={(e) => pickParent(e.target.value)}
              aria-label={t("chartParentLabel")}
              className={inputCls + " font-mono"}
            >
              <option value="">{t("chartParentPick")}</option>
              {parentOptions.list.map((a) => (
                <option key={a.code} value={a.code}>
                  {`${a.code} · ${a.name}`}
                </option>
              ))}
            </select>
            {parentOptions.truncated && (
              <p className="text-[11px] text-op-muted">{t("chartParentMore")}</p>
            )}
            {parent && (
              <p className="text-[11px] text-op-muted">
                {t("chartInherited", {
                  type: t(TYPE_KEY[parent.type] ?? "ctypeOther"),
                  nature: parent.nature === "debito" ? t("natDebit") : t("natCredit"),
                })}
              </p>
            )}
          </div>

          {/* Código y nombre */}
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
            <div className="space-y-1">
              <label className={labelCls} htmlFor="chart-new-code">
                {t("chartCodeLabel")}
              </label>
              <input
                id="chart-new-code"
                type="text"
                inputMode="numeric"
                value={form.code}
                onChange={(e) =>
                  setForm((f) => ({ ...f, code: e.target.value.replace(/\D/g, "") }))
                }
                maxLength={10}
                className={inputCls + " font-mono"}
              />
              {parent && (
                <p className="text-[11px] text-op-muted">
                  {t("chartCodeHint", { parent: parent.code })}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label className={labelCls} htmlFor="chart-new-name">
                {t("chartNameLabel")}
              </label>
              <input
                id="chart-new-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t("chartNamePlaceholder")}
                maxLength={120}
                className={inputCls}
              />
            </div>
          </div>

          {formErr && <p className="text-xs text-danger">{formErr}</p>}
          <button
            type="button"
            onClick={() => void submitNew()}
            disabled={
              formBusy || !form.parentCode || form.code.trim().length < 4 || form.name.trim().length < 2
            }
            className="mp-btn mp-btn--primary mp-btn--block"
          >
            {formBusy ? t("chartSaving") : t("chartSaveCta")}
          </button>
        </div>
      )}

      {importOpen && (
        <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className={labelCls}>{t("chartImportTitle")}</div>
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="text-[11px] text-op-muted hover:underline shrink-0"
            >
              {t("chartImportClose")}
            </button>
          </div>
          <p className="text-xs text-op-muted">{t("chartImportIntro")}</p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={t("chartImportPlaceholder")}
            rows={5}
            aria-label={t("chartImportTitle")}
            className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-xs font-mono"
          />
          <button
            type="button"
            onClick={runImport}
            disabled={busy || csv.trim().length < 3}
            className="mp-btn mp-btn--primary mp-btn--block"
          >
            {busy ? t("chartImporting") : t("chartImportCta")}
          </button>
          {importMsg && <p className="text-xs text-op-muted">{importMsg}</p>}
          {issues.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-danger">
                {t("chartImportIssues", { count: issues.length })}
              </p>
              <ul className="space-y-0.5">
                {issues.map((i) => (
                  <li
                    key={`${i.line}-${i.code}`}
                    className="text-[11px] text-op-muted"
                  >
                    <span className="font-mono">
                      {t("chartIssueLine", { line: i.line })}
                    </span>
                    {` · ${i.code} · ${t(ISSUE_KEY[i.reason] ?? "chartIssue_not_numeric")}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("cuentasSearch")}
        aria-label={t("cuentasSearch")}
        className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm focus:outline-none focus:border-op-text/40"
      />
      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <ul className="divide-y divide-op-border/50">
          {filtered.map((a) => {
            const typeLabel = t(TYPE_KEY[a.type] ?? "ctypeOther");
            const natLabel = a.nature === "debito" ? t("natDebit") : t("natCredit");
            const tag = `${typeLabel} · ${natLabel}`;
            const isEditing = editing?.code === a.code;
            const canHaveChild = a.active && a.code.length <= MAX_PARENT_LEN;
            return (
              <li
                key={a.code}
                className={
                  "px-3 py-2 " + (a.active ? "" : "bg-op-bg/60")
                }
                style={{ paddingLeft: 12 + (a.level - 1) * 14 }}
              >
                <div className="flex items-center gap-2.5">
                  {/* Sin ancho fijo: los códigos de un mismo nivel miden igual,
                      así que el nombre queda pegado al código y alineado. */}
                  <span
                    className={
                      "font-mono text-xs tabular shrink-0 " +
                      (a.postable ? "text-op-muted" : "text-op-text") +
                      (a.active ? "" : " line-through opacity-60")
                    }
                  >
                    {a.code}
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={editing.name}
                      onChange={(e) =>
                        setEditing({ code: a.code, name: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void patchAccount(a.code, { name: editing.name });
                        }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      aria-label={t("chartNameLabel")}
                      maxLength={120}
                      autoFocus
                      className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-op-border bg-op-bg text-sm"
                    />
                  ) : (
                    <span
                      className={
                        "flex-1 min-w-0 truncate text-sm " +
                        (a.postable ? "" : "font-medium") +
                        (a.active ? "" : " line-through opacity-60")
                      }
                    >
                      {a.name}
                    </span>
                  )}
                  {!a.active && (
                    <span className="shrink-0 rounded-full border border-op-border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-op-muted">
                      {t("chartInactiveBadge")}
                    </span>
                  )}
                  {a.postable && a.active && !isEditing && (
                    <span className="hidden sm:inline shrink-0 font-mono text-[9px] uppercase tracking-wider text-op-muted">
                      {tag}
                    </span>
                  )}
                  {!isEditing && (
                    <span className="shrink-0 flex items-center gap-2">
                      {canHaveChild && (
                        <button
                          type="button"
                          onClick={() => openNewForm(a)}
                          className="text-[11px] text-terracotta hover:underline"
                        >
                          {t("chartAddChild")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => startEdit(a)}
                        className="text-[11px] text-op-muted hover:underline"
                      >
                        {t("chartEdit")}
                      </button>
                    </span>
                  )}
                </div>
                {isEditing && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void patchAccount(a.code, { name: editing.name })}
                      disabled={editBusy || editing.name.trim().length < 2}
                      className="mp-btn mp-btn--primary mp-btn--sm"
                    >
                      {t("chartEditSave")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void patchAccount(a.code, { active: !a.active })}
                      disabled={editBusy}
                      className={
                        "mp-btn mp-btn--sm " +
                        (a.active ? "mp-btn--danger" : "mp-btn--secondary")
                      }
                    >
                      {a.active ? t("chartDeactivate") : t("chartActivate")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      disabled={editBusy}
                      className="mp-btn mp-btn--ghost mp-btn--sm"
                    >
                      {t("chartEditCancel")}
                    </button>
                    {editErr && <p className="w-full text-xs text-danger">{editErr}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const ISSUE_KEY: Record<string, string> = {
  not_numeric: "chartIssue_not_numeric",
  bad_length: "chartIssue_bad_length",
  bad_class: "chartIssue_bad_class",
  duplicate: "chartIssue_duplicate",
  no_name: "chartIssue_no_name",
};

/** Errores de alta/edición (createAccount / updateAccount) → clave i18n. */
const ERROR_KEY: Record<string, string> = {
  invalid: "chartErr_invalid",
  bad_code: "chartErr_bad_code",
  bad_name: "chartErr_bad_name",
  code_taken: "chartErr_code_taken",
  bad_parent: "chartErr_bad_parent",
  bad_prefix: "chartErr_bad_prefix",
  has_movements: "chartErr_has_movements",
  engine_account: "chartErr_engine_account",
  has_active_children: "chartErr_has_active_children",
  parent_inactive: "chartErr_parent_inactive",
  not_found: "chartErr_not_found",
};

const AI_ERROR_KEY: Record<string, string> = {
  ai_unavailable: "chartAiErr_ai_unavailable",
  ai_invalid: "chartAiErr_ai_invalid",
};

const AI_WARN_KEY: Record<string, string> = {
  type_mismatch: "chartAiWarn_type_mismatch",
  parent_replaced: "chartAiWarn_parent_replaced",
  parent_postable: "chartAiWarn_parent_postable",
};

const TYPE_KEY: Record<string, string> = {
  activo: "ctypeActivo",
  pasivo: "ctypePasivo",
  patrimonio: "ctypePatrimonio",
  ingreso: "ctypeIngreso",
  gasto: "ctypeGasto",
  costo: "ctypeCosto",
};
