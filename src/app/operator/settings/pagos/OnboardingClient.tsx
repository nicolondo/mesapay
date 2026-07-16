"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type DocKind =
  | "cedula_rep_legal"
  | "rut"
  | "camara_comercio"
  | "bank_cert"
  | "origen_fondos"
  | "estados_financieros"
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

type Translator = ReturnType<typeof useTranslations<"opPagos">>;

// Maps each document kind to its translation key. The label itself is
// resolved at render time via t(KIND_LABEL_KEYS[kind]) so it stays
// trilingual; the enum values above remain the logic/data keys.
const KIND_LABEL_KEYS: Record<DocKind, string> = {
  cedula_rep_legal: "kindCedulaRepLegal",
  rut: "kindRut",
  camara_comercio: "kindCamaraComercio",
  bank_cert: "kindBankCert",
  origen_fondos: "kindOrigenFondos",
  estados_financieros: "kindEstadosFinancieros",
  estatutos: "kindEstatutos",
  other: "kindOther",
};

function kindLabel(t: Translator, kind: DocKind): string {
  return t(KIND_LABEL_KEYS[kind]);
}

// Order matters — this is the order the tiles appear in the wizard.
// estatutos is kept in DocKind for back-compat but excluded from the new
// flow; if a tenant has a legacy estatutos doc it still renders via the
// admin view.
const REQUIRED_KINDS: DocKind[] = [
  "cedula_rep_legal",
  "rut",
  "camara_comercio",
  "bank_cert",
  "origen_fondos",
  "estados_financieros",
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
  const t = useTranslations("opPagos");
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
      setError(j.error ?? t("uploadError"));
      return null;
    }
    const j = await res.json();
    const newDoc = j.document as UploadedDoc;
    setDocs((prev) => [newDoc, ...prev]);
    startTx(() => router.refresh());

    // Auto-OCR the documents we know how to read so the operator doesn't
    // have to click a separate "Leer con AI" button. RUT prefills the legal
    // fields; bank cert prefills the bank info. Both are fire-and-forget;
    // failures surface in the inline error banner.
    if (kind === "rut") {
      void runRutOcr(newDoc.id);
    } else if (kind === "bank_cert") {
      void runBankCertOcr(newDoc.id);
    }
    return newDoc;
  }

  async function deleteDocument(id: string) {
    if (!confirm(t("deleteConfirm"))) return;
    const res = await fetch(
      `/api/operator/onboarding/documents?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    setDocs((prev) => prev.filter((d) => d.id !== id));
    startTx(() => router.refresh());
  }

  async function runBankCertOcr(docId: string) {
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
        setError(j.error ?? t("ocrFailed"));
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

  async function runRutOcr(docId: string) {
    setOcrRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/operator/onboarding/ocr-rut", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: docId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? t("ocrRutFailed"));
        return;
      }
      const j = await res.json();
      const ex = j.extracted as Record<string, unknown>;
      // Only overwrite empty fields — if the operator already typed
      // something, respect it. Confidence is included separately so the UI
      // can show "AI · 92%" next to the fields.
      if (typeof ex.legalName === "string" && !legalName.trim()) {
        setLegalName(ex.legalName);
      }
      if (typeof ex.taxId === "string" && !taxId.trim()) {
        setTaxId(ex.taxId);
      }
      if (typeof ex.contactEmail === "string" && !contactEmail.trim()) {
        setContactEmail(ex.contactEmail);
      }
      if (typeof ex.contactPhone === "string" && !contactPhone.trim()) {
        setContactPhone(ex.contactPhone);
      }
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
        setError(humanError(t, j));
        return;
      }
      startTx(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const bankCertDoc = docs.find((d) => d.kind === "bank_cert");
  const rutDoc = docs.find((d) => d.kind === "rut");
  const missingKinds = REQUIRED_KINDS.filter(
    (k) => !docs.some((d) => d.kind === k),
  );

  // Beneficiary check: the holder doc on the bank cert MUST match the NIT
  // on the RUT. Otherwise someone could ship money to an unrelated account.
  // We only flag a mismatch when both numbers are present — empty fields
  // mean the operator hasn't filled them yet, which is its own gate.
  const beneficiaryCheck = (() => {
    const rutId = taxId.replace(/\D/g, "");
    const bankId = bankInfo.holderDocNumber.replace(/\D/g, "");
    if (!rutId || !bankId) return { ok: true as const, kind: "pending" as const };
    if (rutId === bankId) return { ok: true as const, kind: "match" as const };
    // Fuzzy name match as a secondary signal — names alone aren't enough
    // to approve, but help explain WHY the mismatch matters in the warning.
    return {
      ok: false as const,
      kind: "mismatch" as const,
      rutId,
      bankId,
      rutName: legalName,
      bankName: bankInfo.holderName,
    };
  })();

  const canSubmit =
    !isLocked &&
    missingKinds.length === 0 &&
    beneficiaryCheck.ok &&
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
      <div className="font-display text-3xl mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      <StatusBanner tenant={tenant} t={t} />

      {/* Step 1: documents ---------------------------------------------- */}
      <Section title={t("step1Title")} subtitle={t("step1Subtitle")}>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {(["cedula_rep_legal", "rut", "camara_comercio", "origen_fondos", "estados_financieros"] as DocKind[]).map(
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
        {rutDoc && ocrRunning && (
          <p className="mt-2 text-xs text-op-muted">{t("readingRut")}</p>
        )}
        {missingKinds.length > 0 && (
          <p className="mt-2 text-xs text-op-muted">
            {t("missingPre")}{" "}
            <strong>
              {missingKinds.map((k) => kindLabel(t, k)).join(", ")}
            </strong>
            .
          </p>
        )}
      </Section>

      {/* Step 2: bank cert + OCR ---------------------------------------- */}
      <Section title={t("step2Title")} subtitle={t("step2Subtitle")}>
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
            onClick={() => runBankCertOcr(bankCertDoc.id)}
            disabled={ocrRunning || isLocked}
            className="mp-btn mp-btn--primary mp-btn--sm mt-3"
          >
            {ocrRunning ? t("reading") : t("rereadAi")}
          </button>
        )}
        {bankInfo.source === "ai_extracted" && (
          <div className="mt-2 text-xs text-op-muted">
            {t("aiReadPre")}
            {bankInfo.aiConfidence !== undefined
              ? t("aiReadConfidence", {
                  pct: (bankInfo.aiConfidence * 100).toFixed(0),
                })
              : ""}
            {t("aiReadPost")}
          </div>
        )}
      </Section>

      {/* Step 3: bank form (read-only, filled by AI from the bank cert) */}
      <Section title={t("step3Title")} subtitle={t("step3Subtitle")}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <DisplayField label={t("bankNameLabel")} value={bankInfo.bankName} t={t} />
          <DisplayField
            label={t("accountTypeLabel")}
            value={
              bankInfo.accountType === "ahorros"
                ? t("accountTypeAhorros")
                : bankInfo.accountType === "corriente"
                  ? t("accountTypeCorriente")
                  : ""
            }
            t={t}
          />
          <DisplayField
            label={t("accountNumberLabel")}
            value={bankInfo.accountNumber}
            mono
            t={t}
          />
          <DisplayField label={t("holderNameLabel")} value={bankInfo.holderName} t={t} />
          <DisplayField
            label={t("holderDocTypeLabel")}
            value={bankInfo.holderDocType}
            t={t}
          />
          <DisplayField
            label={t("holderDocNumberLabel")}
            value={bankInfo.holderDocNumber}
            mono
            t={t}
          />
        </div>
      </Section>

      {/* Step 4: legal data (read-only, filled by AI from the RUT) ----- */}
      <Section title={t("step4Title")} subtitle={t("step4Subtitle")}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <DisplayField label={t("legalNameLabel")} value={legalName} t={t} />
          <DisplayField label={t("taxIdLabel")} value={taxId} mono t={t} />
          <DisplayField label={t("contactEmailLabel")} value={contactEmail} t={t} />
          <DisplayField label={t("contactPhoneLabel")} value={contactPhone} t={t} />
        </div>
      </Section>

      {beneficiaryCheck.kind === "match" && (
        <div className="my-4 p-3 rounded-xl bg-ok/10 text-ok text-sm flex items-start gap-2">
          <span aria-hidden>{"✓"}</span>
          <span>{t("beneficiaryMatch")}</span>
        </div>
      )}
      {beneficiaryCheck.kind === "mismatch" && (
        <div className="my-4 p-3 rounded-xl bg-danger/10 text-danger text-sm">
          <div className="font-medium">{t("beneficiaryMismatchTitle")}</div>
          <div className="mt-1">
            {t("beneficiaryRutLabel")}{" "}
            <span className="font-mono">{beneficiaryCheck.rutId}</span>
            {beneficiaryCheck.rutName && (
              <>
                {" "}— <span>{beneficiaryCheck.rutName}</span>
              </>
            )}
          </div>
          <div>
            {t("beneficiaryBankLabel")}{" "}
            <span className="font-mono">{beneficiaryCheck.bankId}</span>
            {beneficiaryCheck.bankName && (
              <>
                {" "}— <span>{beneficiaryCheck.bankName}</span>
              </>
            )}
          </div>
          <div className="mt-2 text-[12px]">{t("beneficiaryMismatchHelp")}</div>
        </div>
      )}

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
          className="mp-btn mp-btn--accent"
        >
          {busy ? t("submitting") : t("submit")}
        </button>
        {isLocked && (
          <span className="text-xs text-op-muted">{t("lockedNotice")}</span>
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
  t,
}: {
  tenant: {
    status: Status;
    notes: string | null;
    merchantId: string | null;
  };
  t: Translator;
}) {
  if (tenant.status === "active") {
    return (
      <div className="rounded-2xl border border-ok/30 bg-ok/10 text-ok p-4 mb-6">
        <div className="font-display text-lg">{t("statusActiveTitle")}</div>
        <div className="text-sm mt-1">
          {t("statusActiveBody", { merchantId: tenant.merchantId ?? "" })}
        </div>
      </div>
    );
  }
  if (tenant.status === "submitted" || tenant.status === "in_review") {
    return (
      <div className="rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 text-[#7F5A1F] p-4 mb-6">
        <div className="font-display text-lg">{t("statusReviewTitle")}</div>
        <div className="text-sm mt-1">{t("statusReviewBody")}</div>
      </div>
    );
  }
  if (tenant.status === "rejected" && tenant.notes) {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger/10 text-danger p-4 mb-6">
        <div className="font-display text-lg">{t("statusRejectedTitle")}</div>
        <div className="text-sm mt-1">{tenant.notes}</div>
      </div>
    );
  }
  return null;
}

const ACCEPTED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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
  const t = useTranslations("opPagos");
  const inputId = `doc-${kind}`;
  const [dragOver, setDragOver] = useState(false);

  function handleDrop(e: React.DragEvent<HTMLLIElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!ACCEPTED_MIMES.has(file.type)) {
      // Surface the validation softly: the upload route would also reject
      // it, but giving feedback here saves a round trip.
      alert(t("unsupportedFormat"));
      return;
    }
    onUpload(file);
  }

  function handleDragOver(e: React.DragEvent<HTMLLIElement>) {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLLIElement>) {
    // Only clear when we leave the tile itself, not when crossing into a
    // child element (relatedTarget would still be inside).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOver(false);
    }
  }

  return (
    <li
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      className={
        "rounded-xl border-2 border-dashed transition-colors p-3 " +
        (dragOver
          ? "border-terracotta bg-terracotta/10"
          : "border-op-border bg-op-surface")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          {kindLabel(t, kind)}
        </div>
        {docs.length > 0 && (
          <span
            className="font-mono text-[9px] tracking-wider uppercase text-ok"
            aria-label={t("tileLoaded")}
          >
            {t("tileLoadedBadge")}
          </span>
        )}
      </div>
      <div className="mt-2">
        {docs.length === 0 ? (
          <label
            htmlFor={inputId}
            className={
              "block text-sm text-center py-3 rounded-lg cursor-pointer " +
              (disabled
                ? "opacity-50 pointer-events-none"
                : "text-op-muted hover:text-op-text")
            }
          >
            {dragOver ? t("tileDropHere") : t("tileDragOrClick")}
            <div className="text-[10px] text-op-muted mt-0.5">
              {t("tileHint")}
            </div>
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
                  {t("tileDelete")}
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
              {t("tileReplace")}
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

/**
 * Read-only display of a field that's filled by AI extraction. The legal
 * and bank-info sections are intentionally non-editable — the AI is the
 * single source of truth. If something looks wrong, the operator re-uploads
 * a clearer document instead of typing over it (which would defeat the
 * "beneficiary matches RUT" check).
 */
function DisplayField({
  label,
  value,
  mono,
  t,
}: {
  label: string;
  value: string;
  mono?: boolean;
  t: Translator;
}) {
  const empty = !value.trim();
  return (
    <div>
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </div>
      <div
        className={
          "mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg flex items-center text-sm " +
          (empty ? "text-op-muted italic" : mono ? "font-mono tabular" : "")
        }
      >
        {empty ? t("displayAutoFill") : value}
      </div>
    </div>
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

function humanError(
  t: Translator,
  j: {
    error?: string;
    missing?: string[];
    detail?: string;
    rutId?: string;
    bankId?: string;
  },
): string {
  if (j.error === "documents_incomplete" && j.missing) {
    return t("errMissingDocs", { missing: j.missing.join(", ") });
  }
  if (j.error === "beneficiary_mismatch") {
    return t("errBeneficiaryMismatch", {
      bankId: j.bankId ?? "",
      rutId: j.rutId ?? "",
    });
  }
  if (j.error === "submit_failed") {
    return j.detail
      ? t("errSubmitFailedDetail", { detail: j.detail })
      : t("errSubmitFailedNoDetail");
  }
  return j.error ?? t("errGeneric");
}
