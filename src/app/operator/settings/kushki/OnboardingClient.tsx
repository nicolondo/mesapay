"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type DocKind =
  | "cedula_rep_legal"
  | "rut"
  | "camara_comercio"
  | "bank_cert"
  | "estatutos"
  | "other";

type UploadedDoc = {
  id: string;
  kind: DocKind;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  fileSize: number;
  extractedFields: Record<string, unknown> | null;
};

type BankInfo = {
  bankName: string;
  accountType: "ahorros" | "corriente" | "";
  accountNumber: string;
  holderName: string;
  holderDocType: "CC" | "CE" | "NIT" | "PA" | "";
  holderDocNumber: string;
  source: "manual" | "ai_extracted";
  aiConfidence?: number;
};

type Status =
  | "not_started"
  | "docs_uploaded"
  | "submitted"
  | "in_review"
  | "active"
  | "rejected"
  | "suspended";

const KIND_LABELS: Record<DocKind, string> = {
  cedula_rep_legal: "Cédula representante legal",
  rut: "RUT",
  camara_comercio: "Cámara de comercio",
  bank_cert: "Certificación bancaria",
  estatutos: "Estatutos / acta constitutiva",
  other: "Otro documento",
};

const REQUIRED_KINDS: DocKind[] = [
  "cedula_rep_legal",
  "rut",
  "camara_comercio",
  "bank_cert",
];

export function OnboardingClient({
  tenant,
  initialBankInfo,
  initialDocuments,
}: {
  tenant: {
    name: string;
    status: Status;
    notes: string | null;
    merchantId: string | null;
    submittedAt: string | null;
    activatedAt: string | null;
  };
  initialBankInfo: Record<string, unknown> | null;
  initialDocuments: UploadedDoc[];
}) {
  const router = useRouter();
  const [docs, setDocs] = useState<UploadedDoc[]>(initialDocuments);
  const [bankInfo, setBankInfo] = useState<BankInfo>(() =>
    normaliseBankInfo(initialBankInfo),
  );
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [, startTx] = useTransition();

  const isLocked =
    tenant.status === "submitted" ||
    tenant.status === "in_review" ||
    tenant.status === "active";

  async function uploadDocument(file: File, kind: DocKind) {
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", kind);
    const res = await fetch("/api/operator/onboarding/documents", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "No pudimos subir el archivo.");
      return null;
    }
    const j = await res.json();
    const newDoc = j.document as UploadedDoc;
    setDocs((prev) => [newDoc, ...prev]);
    startTx(() => router.refresh());
    return newDoc;
  }

  async function deleteDocument(id: string) {
    if (!confirm("¿Eliminar este documento?")) return;
    const res = await fetch(
      `/api/operator/onboarding/documents?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      setError("No pudimos eliminar el documento.");
      return;
    }
    setDocs((prev) => prev.filter((d) => d.id !== id));
    startTx(() => router.refresh());
  }

  async function runOcr(docId: string) {
    setOcrRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/operator/onboarding/ocr-bank-cert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: docId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "OCR falló.");
        return;
      }
      const j = await res.json();
      const ex = j.extracted as Record<string, unknown>;
      setBankInfo((prev) => ({
        ...prev,
        bankName: (ex.bankName as string) ?? prev.bankName,
        accountType:
          (ex.accountType as "ahorros" | "corriente" | "unknown") === "unknown"
            ? prev.accountType
            : (ex.accountType as "ahorros" | "corriente"),
        accountNumber: (ex.accountNumber as string) ?? prev.accountNumber,
        holderName: (ex.holderName as string) ?? prev.holderName,
        holderDocType:
          (ex.holderDocType as "CC" | "CE" | "NIT" | "PA" | "unknown") ===
          "unknown"
            ? prev.holderDocType
            : (ex.holderDocType as "CC" | "CE" | "NIT" | "PA"),
        holderDocNumber:
          (ex.holderDocNumber as string) ?? prev.holderDocNumber,
        source: "ai_extracted",
        aiConfidence: (ex.confidence as number) ?? undefined,
      }));
      setDocs((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, extractedFields: ex } : d)),
      );
    } finally {
      setOcrRunning(false);
    }
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/operator/onboarding/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          legalName,
          taxId,
          contactEmail,
          contactPhone,
          bankInfo,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(humanError(j));
        return;
      }
      startTx(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const bankCertDoc = docs.find((d) => d.kind === "bank_cert");
  const missingKinds = REQUIRED_KINDS.filter(
    (k) => !docs.some((d) => d.kind === k),
  );
  const canSubmit =
    !isLocked &&
    missingKinds.length === 0 &&
    legalName.trim() &&
    taxId.trim() &&
    contactEmail.trim() &&
    contactPhone.trim() &&
    bankInfo.bankName.trim() &&
    bankInfo.accountType &&
    bankInfo.accountNumber.trim() &&
    bankInfo.holderName.trim() &&
    bankInfo.holderDocType &&
    bankInfo.holderDocNumber.trim();

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted mb-1">
        {tenant.name}
      </div>
      <div className="font-display text-3xl mb-1">Pagos con Kushki</div>
      <p className="text-sm text-op-muted mb-6">
        Sube tus documentos, valida la cuenta bancaria y envíalos a Kushki para
        empezar a cobrar.
      </p>

      <StatusBanner tenant={tenant} />

      {/* Step 1: documents ---------------------------------------------- */}
      <Section title="1 · Documentos KYC" subtitle="Sube los archivos requeridos.">
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {(["cedula_rep_legal", "rut", "camara_comercio", "estatutos"] as DocKind[]).map(
            (kind) => (
              <DocumentTile
                key={kind}
                kind={kind}
                docs={docs.filter((d) => d.kind === kind)}
                onUpload={(file) => uploadDocument(file, kind)}
                onDelete={deleteDocument}
                disabled={isLocked}
              />
            ),
          )}
        </ul>
        {missingKinds.length > 0 && (
          <p className="mt-2 text-xs text-op-muted">
            Faltan:{" "}
            <strong>
              {missingKinds.map((k) => KIND_LABELS[k]).join(", ")}
            </strong>
            .
          </p>
        )}
      </Section>

      {/* Step 2: bank cert + OCR ---------------------------------------- */}
      <Section
        title="2 · Certificación bancaria"
        subtitle="La leemos con AI para llenar el formulario automáticamente."
      >
        <DocumentTile
          kind="bank_cert"
          docs={docs.filter((d) => d.kind === "bank_cert")}
          onUpload={(file) => uploadDocument(file, "bank_cert")}
          onDelete={deleteDocument}
          disabled={isLocked}
        />
        {bankCertDoc && (
          <button
            type="button"
            onClick={() => runOcr(bankCertDoc.id)}
            disabled={ocrRunning || isLocked}
            className="mt-3 h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
          >
            {ocrRunning ? "Leyendo…" : "Leer con AI"}
          </button>
        )}
        {bankInfo.source === "ai_extracted" && (
          <div className="mt-2 text-xs text-op-muted">
            Datos llenados automáticamente
            {bankInfo.aiConfidence !== undefined
              ? ` · confianza ${(bankInfo.aiConfidence * 100).toFixed(0)}%`
              : ""}{" "}
            — verifica antes de enviar.
          </div>
        )}
      </Section>

      {/* Step 3: bank form --------------------------------------------- */}
      <Section title="3 · Datos bancarios" subtitle="Editable. Por aquí van a dispersar tus cobros.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Banco" value={bankInfo.bankName} onChange={(v) => setBankInfo({ ...bankInfo, bankName: v, source: "manual" })} disabled={isLocked} />
          <Select label="Tipo de cuenta" value={bankInfo.accountType} options={[["ahorros","Ahorros"],["corriente","Corriente"]]} onChange={(v) => setBankInfo({ ...bankInfo, accountType: v as "ahorros" | "corriente", source: "manual" })} disabled={isLocked} />
          <Field label="Número de cuenta" value={bankInfo.accountNumber} onChange={(v) => setBankInfo({ ...bankInfo, accountNumber: v, source: "manual" })} disabled={isLocked} />
          <Field label="Titular" value={bankInfo.holderName} onChange={(v) => setBankInfo({ ...bankInfo, holderName: v, source: "manual" })} disabled={isLocked} />
          <Select label="Tipo doc titular" value={bankInfo.holderDocType} options={[["CC","CC"],["CE","CE"],["NIT","NIT"],["PA","PA"]]} onChange={(v) => setBankInfo({ ...bankInfo, holderDocType: v as "CC" | "CE" | "NIT" | "PA", source: "manual" })} disabled={isLocked} />
          <Field label="Número de documento" value={bankInfo.holderDocNumber} onChange={(v) => setBankInfo({ ...bankInfo, holderDocNumber: v, source: "manual" })} disabled={isLocked} />
        </div>
      </Section>

      {/* Step 4: legal + submit ---------------------------------------- */}
      <Section title="4 · Datos legales del comercio" subtitle="Información del titular del comercio.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Razón social" value={legalName} onChange={setLegalName} disabled={isLocked} />
          <Field label="NIT" value={taxId} onChange={setTaxId} disabled={isLocked} />
          <Field label="Email de contacto" value={contactEmail} onChange={setContactEmail} disabled={isLocked} />
          <Field label="Teléfono de contacto" value={contactPhone} onChange={setContactPhone} disabled={isLocked} />
        </div>
      </Section>

      {error && (
        <div className="my-4 p-3 rounded-xl bg-danger/10 text-danger text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 mt-6">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || busy}
          className="h-12 px-6 rounded-full bg-terracotta text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Enviando a Kushki…" : "Enviar solicitud"}
        </button>
        {isLocked && (
          <span className="text-xs text-op-muted">
            La solicitud ya está enviada. Si necesitas corregir algo, contáctanos.
          </span>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="font-display text-xl">{title}</div>
      <div className="text-xs text-op-muted mb-3">{subtitle}</div>
      {children}
    </section>
  );
}

function StatusBanner({
  tenant,
}: {
  tenant: {
    status: Status;
    notes: string | null;
    merchantId: string | null;
  };
}) {
  if (tenant.status === "active") {
    return (
      <div className="rounded-2xl border border-ok/30 bg-ok/10 text-ok p-4 mb-6">
        <div className="font-display text-lg">¡Listo para cobrar!</div>
        <div className="text-sm mt-1">
          Tu cuenta Kushki está activa. ID: {tenant.merchantId}
        </div>
      </div>
    );
  }
  if (tenant.status === "submitted" || tenant.status === "in_review") {
    return (
      <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 text-[#7F5A1F] p-4 mb-6">
        <div className="font-display text-lg">En revisión</div>
        <div className="text-sm mt-1">
          Kushki está validando tus documentos. Te avisamos por correo cuando
          quede activo.
        </div>
      </div>
    );
  }
  if (tenant.status === "rejected" && tenant.notes) {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger/10 text-danger p-4 mb-6">
        <div className="font-display text-lg">Solicitud rechazada</div>
        <div className="text-sm mt-1">{tenant.notes}</div>
      </div>
    );
  }
  return null;
}

function DocumentTile({
  kind,
  docs,
  onUpload,
  onDelete,
  disabled,
}: {
  kind: DocKind;
  docs: UploadedDoc[];
  onUpload: (file: File) => void;
  onDelete: (id: string) => void;
  disabled: boolean;
}) {
  const inputId = `doc-${kind}`;
  return (
    <li className="rounded-xl border border-op-border bg-op-surface p-3">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {KIND_LABELS[kind]}
      </div>
      <div className="mt-2">
        {docs.length === 0 ? (
          <label
            htmlFor={inputId}
            className={
              "inline-flex items-center gap-2 h-9 px-3 rounded-full border border-op-border text-sm cursor-pointer " +
              (disabled ? "opacity-50 pointer-events-none" : "hover:bg-op-bg")
            }
          >
            Subir archivo
          </label>
        ) : (
          <ul className="space-y-1.5">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2 text-sm bg-op-bg rounded-lg px-2 py-1"
              >
                <a
                  href={d.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate flex-1 text-terracotta hover:underline"
                >
                  {d.fileName}
                </a>
                <button
                  type="button"
                  onClick={() => onDelete(d.id)}
                  disabled={disabled}
                  className="text-xs text-op-muted hover:text-danger disabled:opacity-40"
                >
                  Eliminar
                </button>
              </li>
            ))}
            <label
              htmlFor={inputId}
              className={
                "inline-flex items-center gap-2 h-8 px-2 rounded-full border border-op-border text-xs cursor-pointer " +
                (disabled ? "opacity-50 pointer-events-none" : "hover:bg-op-bg")
              }
            >
              Reemplazar / agregar
            </label>
          </ul>
        )}
        <input
          id={inputId}
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.currentTarget.value = "";
          }}
          disabled={disabled}
        />
      </div>
    </li>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-surface focus:outline-none focus:border-terracotta disabled:opacity-60"
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-surface focus:outline-none focus:border-terracotta disabled:opacity-60"
      >
        <option value="" disabled>
          Selecciona…
        </option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function normaliseBankInfo(raw: Record<string, unknown> | null): BankInfo {
  if (!raw) {
    return {
      bankName: "",
      accountType: "",
      accountNumber: "",
      holderName: "",
      holderDocType: "",
      holderDocNumber: "",
      source: "manual",
    };
  }
  return {
    bankName: typeof raw.bankName === "string" ? raw.bankName : "",
    accountType:
      raw.accountType === "ahorros" || raw.accountType === "corriente"
        ? raw.accountType
        : "",
    accountNumber:
      typeof raw.accountNumber === "string" ? raw.accountNumber : "",
    holderName: typeof raw.holderName === "string" ? raw.holderName : "",
    holderDocType:
      raw.holderDocType === "CC" ||
      raw.holderDocType === "CE" ||
      raw.holderDocType === "NIT" ||
      raw.holderDocType === "PA"
        ? raw.holderDocType
        : "",
    holderDocNumber:
      typeof raw.holderDocNumber === "string" ? raw.holderDocNumber : "",
    source: raw.source === "ai_extracted" ? "ai_extracted" : "manual",
    aiConfidence:
      typeof raw.aiConfidence === "number" ? raw.aiConfidence : undefined,
  };
}

function humanError(j: { error?: string; missing?: string[]; detail?: string }): string {
  if (j.error === "documents_incomplete" && j.missing) {
    return `Faltan documentos: ${j.missing.join(", ")}`;
  }
  if (j.error === "submit_failed") {
    return `Kushki rechazó la solicitud: ${j.detail ?? "sin detalle"}`;
  }
  return j.error ?? "No pudimos enviar la solicitud.";
}
