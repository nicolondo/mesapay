"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { dianIssueDateTime } from "@/lib/dian/dianDateTime";
import { formatDate, formatMoney } from "@/lib/format";
import { AdjustmentForm } from "./AdjustmentForm";
import { SupplierDataForm } from "./SupplierDataForm";
import {
  ERROR_CODES,
  stateTone,
  type ApiError,
  type SupportDocPanel,
  type SupportDocSourceType,
  type SupportDocSupplierView,
  type SupportDocView,
} from "./shared";

/**
 * Documento soporte DIAN de un gasto o de una compra (Res. 000167 de 2021):
 * datos del vendedor no obligado, generar y transmitir, estado, rechazos con
 * sus reglas, reenvío con el mismo número, consulta de estado, representación
 * gráfica, XML y nota de ajuste. No aparece si el comercio no tiene
 * facturación electrónica.
 */
export function SupportDocumentPanel({
  sourceType,
  sourceId,
  currency = "COP",
}: {
  sourceType: SupportDocSourceType;
  sourceId: string;
  currency?: string;
}) {
  const t = useTranslations("opSupportDoc");
  const locale = useLocale() as Locale;
  const [panel, setPanel] = useState<SupportDocPanel | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [editingSupplier, setEditingSupplier] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/operator/support-documents?sourceType=${sourceType}&sourceId=${encodeURIComponent(sourceId)}`,
      { cache: "no-store" },
    ).catch(() => null);
    if (!res) return;
    if (res.status === 403 || res.status === 404) {
      // Sin facturación electrónica (o sin el módulo del origen): no aplica.
      setHidden(true);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { panel?: SupportDocPanel };
    if (data.panel) setPanel(data.panel);
  }, [sourceType, sourceId]);

  useEffect(() => {
    // Carga inicial del panel (datos del servidor; no es estado derivado).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const errorText = (body: ApiError) => {
    const code = body.error ?? "";
    if (code === "supplier_incomplete" && body.detail?.length) {
      return t("errors.supplier_incomplete_fields", {
        fields: body.detail.map((d) => (t.has(`missing.${d}`) ? t(`missing.${d}`) : d)).join(", "),
      });
    }
    if (code === "missing_resolution" && body.detail?.length) {
      return t("errors.missing_resolution_fields", {
        fields: body.detail.map((d) => (t.has(`configMissing.${d}`) ? t(`configMissing.${d}`) : d)).join(", "),
      });
    }
    return ERROR_CODES.has(code) ? t(`errors.${code}`) : t("errors.generic");
  };

  async function act(key: string, url: string, init?: RequestInit) {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", ...init });
      const body = (await res.json().catch(() => ({}))) as ApiError & {
        document?: { documentNumber: string; state: string; errors: string[] };
      };
      if (!res.ok || !body.document) {
        setMessage({ tone: "error", text: errorText(body) });
      } else {
        setMessage({
          tone: body.document.state === "rejected" || body.document.state === "error" ? "error" : "ok",
          text: t("sentResult", { number: body.document.documentNumber, state: t(`state.${body.document.state}`) }),
        });
      }
    } catch {
      setMessage({ tone: "error", text: t("errors.network") });
    } finally {
      setBusy(null);
      await load();
    }
  }

  // Sin documento soporte activado (y sin documentos viejos que mostrar) el
  // panel no aparece: la inmensa mayoría de los gastos y compras son de
  // proveedores que sí facturan.
  if (hidden || (panel && !panel.config.enabled && panel.documents.length === 0)) return null;
  // Mientras carga no se pinta nada: en la mayoría de los comercios el panel
  // no aplica y un "Cargando…" que desaparece sería ruido.
  if (!panel) return null;

  const { config, supplier } = panel;
  const money = (c: number) => formatMoney(c, { currency, locale });
  const day = (iso: string) => formatDate(`${iso}T12:00:00-05:00`, { locale, dateStyle: "medium", timeStyle: undefined });
  const testing = config.environment === "habilitacion";
  const configBlocking = config.missing.filter((m) => m !== "einvoicing_module");
  const supportDocs = panel.documents.filter((d) => d.kind === "support_document");
  const notesOf = (id: string) => panel.documents.filter((d) => d.adjustsId === id);
  const today = dianIssueDateTime(new Date()).date;
  const late = panel.deadline != null && today > panel.deadline;
  const supplierReady = !!supplier && supplier.missing.length === 0;
  const canGenerate =
    config.missing.length === 0 && supplierReady && panel.sourceReady && !panel.hasActive && !late;

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3" aria-label={t("title")}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{t("title")}</div>
          <p className="text-xs text-op-muted mt-0.5">{t("subtitle")}</p>
        </div>
        {config.enabled && testing && (
          <span className="px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium bg-[#C98A2E]/15 text-[#7F5A1F]">
            {t("testBadge")}
          </span>
        )}
      </div>

      {!config.enabled ? (
        <p className="text-sm text-op-muted">
          {t("notEnabled")}{" "}
          <Link href="/operator/settings/facturacion-dian" className="text-terracotta underline">
            {t("openSettings")}
          </Link>
        </p>
      ) : (
        <>
          {configBlocking.length > 0 && (
            <p className="text-xs text-danger">
              {t("configIncomplete", {
                fields: configBlocking.map((m) => t(`configMissing.${m}`)).join(", "),
              })}{" "}
              <Link href="/operator/settings/facturacion-dian" className="underline">
                {t("openSettings")}
              </Link>
            </p>
          )}

          {!supplier ? (
            <p className="text-sm text-op-muted">{t("noSupplier")}</p>
          ) : !supplier.notObligatedToInvoice && !editingSupplier ? (
            <div className="rounded-xl border border-op-border bg-op-bg p-3">
              <p className="text-sm">{t("supplierQuestion", { name: supplier.name })}</p>
              <p className="text-[11px] text-op-muted mt-1">{t("supplierQuestionHint")}</p>
              <button
                type="button"
                className="mp-btn mp-btn--ghost mp-btn--sm mt-2"
                onClick={() => setEditingSupplier(true)}
              >
                {t("markNotObligated")}
              </button>
            </div>
          ) : editingSupplier || supplier.missing.length > 0 ? (
            <div>
              {supplier.missing.length > 0 && !editingSupplier && (
                <p className="text-xs text-op-muted mb-2">
                  {t("supplierMissing", {
                    fields: supplier.missing.map((m) => t(`missing.${m}`)).join(", "),
                  })}
                </p>
              )}
              <SupplierDataForm
                key={supplier.id}
                supplier={supplier}
                onSaved={(s: SupportDocSupplierView) => {
                  setPanel({ ...panel, supplier: s });
                  setEditingSupplier(false);
                  setMessage(
                    s.missing.length
                      ? { tone: "error", text: t("supplierMissing", { fields: s.missing.map((m) => t(`missing.${m}`)).join(", ") }) }
                      : { tone: "ok", text: t("supplierSaved") },
                  );
                }}
                onCancel={editingSupplier ? () => setEditingSupplier(false) : undefined}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
              <span className="min-w-0 break-words">
                {t("supplierReady", {
                  name: supplier.name,
                  place: supplier.cityLabel ?? [supplier.foreignCityName, supplier.countryName].filter(Boolean).join(", "),
                })}
              </span>
              <button
                type="button"
                className="text-[11px] text-terracotta underline"
                onClick={() => setEditingSupplier(true)}
              >
                {t("editSupplier")}
              </button>
            </div>
          )}

          {!panel.sourceReady && (
            <p className="text-xs text-op-muted">{t(sourceType === "expense" ? "notReadyExpense" : "notReadyPurchase")}</p>
          )}

          {!panel.hasActive && panel.sourceReady && supplier?.notObligatedToInvoice && (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              {panel.deadline && (
                <p className={"text-xs " + (late ? "text-danger" : "text-op-muted")}>
                  {late ? t("deadlinePassed", { date: day(panel.deadline) }) : t("deadline", { date: day(panel.deadline) })}
                </p>
              )}
              <button
                type="button"
                className="mp-btn mp-btn--primary mp-btn--sm ml-auto"
                disabled={!canGenerate || busy !== null}
                onClick={() =>
                  act("generate", "/api/operator/support-documents", {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sourceType, sourceId }),
                  })
                }
              >
                {busy === "generate" ? t("generating") : t("generate")}
              </button>
            </div>
          )}
        </>
      )}

      {message && (
        <p role="status" className={"text-xs " + (message.tone === "ok" ? "text-ok" : "text-danger")}>
          {message.text}
        </p>
      )}

      {supportDocs.length > 0 && (
        <ul className="space-y-3">
          {supportDocs
            .slice()
            .reverse()
            .map((doc) => (
              <li key={doc.id} className="rounded-xl border border-op-border bg-op-bg p-3">
                <DocumentRow
                  doc={doc}
                  money={money}
                  locale={locale}
                  busy={busy}
                  onAct={act}
                  onAdjust={() => setAdjusting(adjusting === doc.id ? null : doc.id)}
                />
                {adjusting === doc.id && (
                  <AdjustmentForm
                    doc={doc}
                    currency={currency}
                    onCancel={() => setAdjusting(null)}
                    onDone={async (text) => {
                      setAdjusting(null);
                      setMessage({ tone: "ok", text });
                      await load();
                    }}
                  />
                )}
                {notesOf(doc.id).map((note) => (
                  <div key={note.id} className="mt-3 border-t border-op-border pt-3">
                    <DocumentRow doc={note} money={money} locale={locale} busy={busy} onAct={act} />
                  </div>
                ))}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function DocumentRow({
  doc,
  money,
  locale,
  busy,
  onAct,
  onAdjust,
}: {
  doc: SupportDocView;
  money: (cents: number) => string;
  locale: Locale;
  busy: string | null;
  onAct: (key: string, url: string, init?: RequestInit) => Promise<void>;
  onAdjust?: () => void;
}) {
  const t = useTranslations("opSupportDoc");
  const base = `/api/operator/support-documents/${doc.id}`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">
          {t(doc.kind === "support_document" ? "kindDs" : "kindNas")} {doc.documentNumber}
        </span>
        <span className={"px-2.5 h-6 inline-flex items-center rounded-full text-[11px] font-medium " + stateTone(doc.state, doc.voided)}>
          {doc.voided ? t("voided") : t(`state.${doc.state}`)}
        </span>
        {doc.environment === "2" && <span className="text-[11px] text-op-muted">{t("testShort")}</span>}
      </div>
      <div className="text-xs text-op-muted">
        {doc.issuedAt && t("issued", { date: formatDate(doc.issuedAt, { locale }) }) + " · "}
        {t("totals", { subtotal: money(doc.subtotalCents), iva: money(doc.taxCents), total: money(doc.totalCents) })}
        {doc.withholdingCents > 0 && " · " + t("withholdingsInformed", { amount: money(doc.withholdingCents) })}
      </div>
      {doc.reasonText && <div className="text-xs text-op-muted">{t(`reason.${doc.reasonCode}`)} — {doc.reasonText}</div>}
      {doc.cuds && (
        <div className="text-[11px] text-op-muted break-all">
          {t("cuds")}: {doc.cuds}
        </div>
      )}
      {doc.untransmitted.length > 0 && (
        <div className="text-[11px] text-op-muted">
          {t("untransmitted", {
            list: doc.untransmitted
              .map((u) => t(`untransmittedReason.${u.reason}`, { kind: t(`retention.${u.kind}`), amount: money(u.amountCents) }))
              .join("; "),
          })}
        </div>
      )}
      {(doc.state === "rejected" || doc.state === "error") && (doc.errors.length > 0 || doc.lastError) && (
        <div className="rounded-lg bg-danger/10 p-2 text-xs text-danger space-y-1">
          <div className="font-medium">{t("dianSaid")}</div>
          <ul className="list-disc pl-4">
            {(doc.errors.length ? doc.errors : [doc.lastError!]).map((e, i) => (
              <li key={i} className="break-words">
                {e === "transport_error" ? t("transportError") : t.has(`errors.${e}`) ? t(`errors.${e}`) : e}
              </li>
            ))}
          </ul>
          {doc.state === "rejected" && <div>{t("resendHint")}</div>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Link href={`/operator/documento-soporte/${doc.id}`} className="mp-btn mp-btn--ghost mp-btn--sm">
          {t("view")}
        </Link>
        {doc.hasXml && (
          <a href={`${base}/xml`} className="mp-btn mp-btn--ghost mp-btn--sm">
            {t("downloadXml")}
          </a>
        )}
        {doc.canCheckStatus && (
          <button
            type="button"
            className="mp-btn mp-btn--ghost mp-btn--sm"
            disabled={busy !== null}
            onClick={() => onAct(`status-${doc.id}`, `${base}/status`)}
          >
            {busy === `status-${doc.id}` ? t("checking") : t("checkStatus")}
          </button>
        )}
        {doc.canResend && (
          <button
            type="button"
            className="mp-btn mp-btn--ghost mp-btn--sm"
            disabled={busy !== null}
            onClick={() => onAct(`resend-${doc.id}`, `${base}/resend`)}
          >
            {busy === `resend-${doc.id}` ? t("sending") : t("resend")}
          </button>
        )}
        {doc.canAdjust && onAdjust && (
          <button type="button" className="mp-btn mp-btn--ghost mp-btn--sm" onClick={onAdjust}>
            {t("adjust")}
          </button>
        )}
      </div>
    </div>
  );
}
