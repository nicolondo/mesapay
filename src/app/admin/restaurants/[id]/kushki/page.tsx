import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fmtBogotaDateTime } from "@/lib/bogota";

function fmtFull(d: Date): string {
  const f = fmtBogotaDateTime(d);
  return `${f.date} ${f.time}`;
}

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { label: string; tint: string }> = {
  not_started: { label: "No iniciado", tint: "bg-op-bg text-op-muted" },
  docs_uploaded: {
    label: "Documentos cargados",
    tint: "bg-paper text-op-muted",
  },
  submitted: { label: "Enviado", tint: "bg-[#C98A2E]/20 text-[#8F6828]" },
  in_review: { label: "En revisión", tint: "bg-[#C98A2E]/20 text-[#8F6828]" },
  active: { label: "Activo", tint: "bg-ok/15 text-ok" },
  rejected: { label: "Rechazado", tint: "bg-danger/15 text-danger" },
  suspended: { label: "Suspendido", tint: "bg-danger/15 text-danger" },
};

const KIND_LABEL: Record<string, string> = {
  cedula_rep_legal: "Cédula representante legal",
  rut: "RUT",
  camara_comercio: "Cámara de comercio",
  bank_cert: "Certificación bancaria",
  estatutos: "Estatutos",
  other: "Otro",
};

export default async function AdminKushkiPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  const status = STATUS_LABEL[rest.kushkiOnboardingStatus] ?? {
    label: rest.kushkiOnboardingStatus,
    tint: "bg-op-bg text-op-muted",
  };

  const bank = rest.bankInfo as Record<string, unknown> | null;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-2 text-sm text-op-muted mb-2">
        <Link href={`/admin/restaurants/${id}`} className="hover:underline">
          ← {rest.name}
        </Link>
        <span>/</span>
        <span>Kushki</span>
      </div>
      <div className="font-display text-3xl mb-1">Kushki · {rest.name}</div>
      <p className="text-sm text-op-muted mb-6">
        Estado de onboarding, documentos KYC, transacciones y eventos.
      </p>

      <section className="rounded-2xl border border-op-border bg-op-surface p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Estado actual
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
              <div>Enviado: {fmtFull(rest.kushkiSubmittedAt)}</div>
            )}
            {rest.kushkiActivatedAt && (
              <div>Activado: {fmtFull(rest.kushkiActivatedAt)}</div>
            )}
          </div>
        </div>
        {rest.kushkiOnboardingNotes && (
          <div className="mt-3 text-sm text-op-muted whitespace-pre-wrap">
            <strong>Notas:</strong> {rest.kushkiOnboardingNotes}
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <Field
            label="Merchant ID"
            value={rest.kushkiMerchantId ?? "—"}
            mono
          />
          <Field
            label="Public Key"
            value={rest.kushkiPublicKey ?? "—"}
            mono
          />
          <Field
            label="Private Key"
            value={rest.kushkiPrivateKeyEnc ? "(cifrado en DB)" : "—"}
            mono
          />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">Datos bancarios</h2>
        {bank ? (
          <div className="rounded-2xl border border-op-border bg-op-surface p-5 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <Field label="Banco" value={String(bank.bankName ?? "—")} />
            <Field
              label="Tipo de cuenta"
              value={String(bank.accountType ?? "—")}
            />
            <Field
              label="Número"
              value={String(bank.accountNumber ?? "—")}
              mono
            />
            <Field label="Titular" value={String(bank.holderName ?? "—")} />
            <Field
              label="Tipo doc"
              value={String(bank.holderDocType ?? "—")}
            />
            <Field
              label="Número doc"
              value={String(bank.holderDocNumber ?? "—")}
              mono
            />
            <Field
              label="Fuente"
              value={
                String(bank.source) === "ai_extracted"
                  ? `AI (${
                      typeof bank.aiConfidence === "number"
                        ? (bank.aiConfidence * 100).toFixed(0) + "%"
                        : "—"
                    } confianza)`
                  : "Manual"
              }
            />
          </div>
        ) : (
          <div className="text-sm text-op-muted">Sin datos bancarios.</div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">Documentos KYC</h2>
        {documents.length === 0 ? (
          <div className="text-sm text-op-muted">Sin documentos.</div>
        ) : (
          <ul className="divide-y divide-op-border border-y border-op-border">
            {documents.map((d) => (
              <li
                key={d.id}
                className="py-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm">
                    {KIND_LABEL[d.kind] ?? d.kind}{" "}
                    <span className="text-op-muted">· {d.fileName}</span>
                  </div>
                  <div className="text-[11px] text-op-muted">
                    Subido {fmtFull(d.createdAt)} · {d.mimeType} ·{" "}
                    {(d.fileSize / 1024).toFixed(0)} KB
                  </div>
                </div>
                <a
                  href={d.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-terracotta hover:underline shrink-0"
                >
                  Abrir
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">Transacciones recientes</h2>
        {transactions.length === 0 ? (
          <div className="text-sm text-op-muted">Sin transacciones.</div>
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
        <h2 className="font-display text-xl mb-3">Movimientos wallet</h2>
        {movements.length === 0 ? (
          <div className="text-sm text-op-muted">Sin movimientos.</div>
        ) : (
          <ul className="text-sm divide-y divide-op-border border-y border-op-border">
            {movements.map((m) => (
              <li
                key={m.id}
                className="py-2 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="truncate">{m.description}</div>
                  <div className="text-[11px] text-op-muted">
                    {m.kind} · {fmtFull(m.occurredAt)}
                  </div>
                </div>
                <div className="font-mono tabular text-right">
                  {m.kind === "credit" ? "+" : "−"}
                  {(m.amountCents / 100).toLocaleString("es-CO")}
                  <div className="text-[10px] text-op-muted">
                    saldo {(m.balanceAfterCents / 100).toLocaleString("es-CO")}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-12">
        <h2 className="font-display text-xl mb-3">Eventos de webhook</h2>
        {webhookEvents.length === 0 ? (
          <div className="text-sm text-op-muted">Sin eventos.</div>
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
