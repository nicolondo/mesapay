import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { AdminPagosConfig } from "./AdminPagosConfig";

function fmtFull(d: Date): string {
  const f = fmtBogotaDateTime(d);
  return `${f.date} ${f.time}`;
}

export const dynamic = "force-dynamic";

// Cada estado mapea a su clave de traducción + tint. La etiqueta se
// resuelve dentro del componente vía tr().
const STATUS_META: Record<string, { tKey: string; tint: string }> = {
  not_started: { tKey: "statusNotStarted", tint: "bg-op-bg text-op-muted" },
  docs_uploaded: {
    tKey: "statusDocsUploaded",
    tint: "bg-paper text-op-muted",
  },
  submitted: { tKey: "statusSubmitted", tint: "bg-[#C98A2E]/20 text-[#8F6828]" },
  in_review: { tKey: "statusInReview", tint: "bg-[#C98A2E]/20 text-[#8F6828]" },
  active: { tKey: "statusActive", tint: "bg-ok/15 text-ok" },
  rejected: { tKey: "statusRejected", tint: "bg-danger/15 text-danger" },
  suspended: { tKey: "statusSuspended", tint: "bg-danger/15 text-danger" },
};

const KIND_TKEY: Record<string, string> = {
  cedula_rep_legal: "kindCedulaRepLegal",
  rut: "kindRut",
  camara_comercio: "kindCamaraComercio",
  bank_cert: "kindBankCert",
  origen_fondos: "kindOrigenFondos",
  estados_financieros: "kindEstadosFinancieros",
  estatutos: "kindEstatutos",
  other: "kindOther",
};

export default async function AdminPagosPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tr = await getTranslations("opAdminBilling");
  const rest = await db.restaurant.findUnique({ where: { id } });
  if (!rest) notFound();

  const [documents, webhookEvents, transactions, movements] = await Promise.all([
    db.kushkiDocument.findMany({
      where: { restaurantId: id },
      orderBy: { createdAt: "desc" },
    }),
    db.kushkiWebhookEvent.findMany({
      where: { restaurantId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.kushkiTransaction.findMany({
      where: { restaurantId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.walletMovement.findMany({
      where: { restaurantId: id },
      orderBy: { occurredAt: "desc" },
      take: 20,
    }),
  ]);

  const statusMeta = STATUS_META[rest.kushkiOnboardingStatus];
  const status = {
    label: statusMeta ? tr(statusMeta.tKey) : rest.kushkiOnboardingStatus,
    tint: statusMeta?.tint ?? "bg-op-bg text-op-muted",
  };

  const bank = rest.bankInfo as Record<string, unknown> | null;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-2 text-sm text-op-muted mb-2">
        <Link href={`/admin/restaurants/${id}`} className="hover:underline">
          {"← "}
          {rest.name}
        </Link>
        <span aria-hidden>{"/"}</span>
        <span>{tr("pagosBreadcrumb")}</span>
      </div>
      <div className="font-display text-3xl mb-1">
        {tr("pagosTitle", { name: rest.name })}
      </div>
      <p className="text-sm text-op-muted mb-6">
        {tr("pagosIntro")}
      </p>

      <section className="rounded-2xl border border-op-border bg-op-surface p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {tr("currentStatus")}
            </div>
            <div className="mt-1 inline-flex items-center gap-2">
              <span
                className={
                  "px-3 h-7 inline-flex items-center rounded-full text-[11px] font-medium " +
                  status.tint
                }
              >
                {status.label}
              </span>
            </div>
          </div>
          <div className="text-sm text-op-muted">
            {rest.kushkiSubmittedAt && (
              <div>{tr("submittedAt", { date: fmtFull(rest.kushkiSubmittedAt) })}</div>
            )}
            {rest.kushkiActivatedAt && (
              <div>{tr("activatedAt", { date: fmtFull(rest.kushkiActivatedAt) })}</div>
            )}
          </div>
        </div>
        {rest.kushkiOnboardingNotes && (
          <div className="mt-3 text-sm text-op-muted whitespace-pre-wrap">
            <strong>{tr("notesLabel")}</strong> {rest.kushkiOnboardingNotes}
          </div>
        )}
      </section>

      <section className="mb-6">
        <AdminPagosConfig
          restaurantId={id}
          initial={{
            merchantId: rest.kushkiMerchantId ?? "",
            publicKey: rest.kushkiPublicKey ?? "",
            onboardingStatus: rest.kushkiOnboardingStatus,
            notes: rest.kushkiOnboardingNotes ?? "",
            hasPrivateKey: !!rest.kushkiPrivateKeyEnc,
            hasWebhookSecret: !!rest.kushkiWebhookSecretEnc,
            // "" = heredar el modo global de plataforma.
            kushkiMode: rest.kushkiMode ?? "",
          }}
        />
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">{tr("bankTitle")}</h2>
        {bank ? (
          <div className="rounded-2xl border border-op-border bg-op-surface p-5 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <Field label={tr("bankName")} value={String(bank.bankName ?? "—")} />
            <Field
              label={tr("bankAccountType")}
              value={String(bank.accountType ?? "—")}
            />
            <Field
              label={tr("bankNumber")}
              value={String(bank.accountNumber ?? "—")}
              mono
            />
            <Field label={tr("bankHolder")} value={String(bank.holderName ?? "—")} />
            <Field
              label={tr("bankHolderDocType")}
              value={String(bank.holderDocType ?? "—")}
            />
            <Field
              label={tr("bankHolderDocNumber")}
              value={String(bank.holderDocNumber ?? "—")}
              mono
            />
            <Field
              label={tr("bankSource")}
              value={
                String(bank.source) === "ai_extracted"
                  ? tr("bankSourceAi", {
                      confidence:
                        typeof bank.aiConfidence === "number"
                          ? (bank.aiConfidence * 100).toFixed(0) + "%"
                          : "—",
                    })
                  : tr("bankSourceManual")
              }
            />
          </div>
        ) : (
          <div className="text-sm text-op-muted">{tr("noBankData")}</div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">{tr("docsTitle")}</h2>
        {documents.length === 0 ? (
          <div className="text-sm text-op-muted">{tr("noDocs")}</div>
        ) : (
          <ul className="divide-y divide-op-border border-y border-op-border">
            {documents.map((d) => (
              <li
                key={d.id}
                className="py-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm">
                    {KIND_TKEY[d.kind] ? tr(KIND_TKEY[d.kind]) : d.kind}{" "}
                    <span className="text-op-muted" aria-hidden>
                      {"· "}
                      {d.fileName}
                    </span>
                  </div>
                  <div className="text-[11px] text-op-muted">
                    {tr("docUploaded", {
                      date: fmtFull(d.createdAt),
                      mime: d.mimeType,
                      size: (d.fileSize / 1024).toFixed(0),
                    })}
                  </div>
                </div>
                <a
                  href={d.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-terracotta hover:underline shrink-0"
                >
                  {tr("docOpen")}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">{tr("txTitle")}</h2>
        {transactions.length === 0 ? (
          <div className="text-sm text-op-muted">{tr("noTx")}</div>
        ) : (
          <ul className="text-sm font-mono divide-y divide-op-border border-y border-op-border">
            {transactions.map((t) => (
              <li
                key={t.id}
                className="py-2 grid grid-cols-[140px_1fr_120px_80px] gap-3 items-center"
              >
                <span className="text-op-muted text-[11px]">
                  {fmtFull(t.createdAt)}
                </span>
                <span className="truncate">{t.kushkiTxId}</span>
                <span>{t.kind}</span>
                <span
                  className={
                    t.status === "approved"
                      ? "text-ok"
                      : t.status === "declined"
                        ? "text-danger"
                        : "text-op-muted"
                  }
                >
                  {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">{tr("walletTitle")}</h2>
        {movements.length === 0 ? (
          <div className="text-sm text-op-muted">{tr("noMovements")}</div>
        ) : (
          <ul className="text-sm divide-y divide-op-border border-y border-op-border">
            {movements.map((m) => (
              <li
                key={m.id}
                className="py-2 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="truncate">{m.description}</div>
                  <div className="text-[11px] text-op-muted" aria-hidden>
                    {m.kind} {"· "}
                    {fmtFull(m.occurredAt)}
                  </div>
                </div>
                <div className="font-mono tabular text-right">
                  {m.kind === "credit" ? "+" : "−"}
                  {(m.amountCents / 100).toLocaleString("es-CO")}
                  <div className="text-[10px] text-op-muted">
                    {tr("walletBalance", {
                      balance: (m.balanceAfterCents / 100).toLocaleString("es-CO"),
                    })}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-12">
        <h2 className="font-display text-xl mb-3">{tr("webhookTitle")}</h2>
        {webhookEvents.length === 0 ? (
          <div className="text-sm text-op-muted">{tr("noWebhookEvents")}</div>
        ) : (
          <ul className="text-sm font-mono divide-y divide-op-border border-y border-op-border">
            {webhookEvents.map((e) => (
              <li
                key={e.id}
                className="py-2 grid grid-cols-[140px_1fr_80px] gap-3 items-center"
              >
                <span className="text-op-muted text-[11px]">
                  {fmtFull(e.createdAt)}
                </span>
                <span className="truncate">{e.type}</span>
                <span
                  className={
                    e.processedAt
                      ? "text-ok"
                      : e.error
                        ? "text-danger"
                        : "text-op-muted"
                  }
                >
                  {e.processedAt ? "ok" : e.error ? "error" : "pending"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </div>
      <div className={"mt-0.5 " + (mono ? "font-mono tabular text-sm" : "")}>
        {value}
      </div>
    </div>
  );
}
