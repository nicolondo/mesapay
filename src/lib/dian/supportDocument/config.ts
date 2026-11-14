// Configuración del documento soporte por emisor (columnas supportDoc* de
// DianConfig). Cuelga del mismo emisor que la facturación electrónica
// (LegalEntity del grupo o el propio Restaurant) y firma con el MISMO
// certificado; el software (ID/PIN), la autorización de numeración y el
// ambiente son propios del documento soporte.
import { db } from "@/lib/db";
import { decryptSecret, loadP12, type LoadedCert } from "@/lib/dian/crypto";
import { resolveEmisor, type EmisorData } from "@/lib/dian/config";
import type { DianResolution } from "@/lib/dian/ubl";
import { computeNitDv } from "@/lib/erp/exogena";
import { isModuleEnabled } from "@/lib/modules";
import { TAX_LEVEL_NOT_APPLICABLE } from "./constants";
import { SupportDocError } from "./errors";
import type { SupportDocBuyer } from "./types";

export type SupportDocEnvironment = "habilitacion" | "produccion";

/** "1" producción · "2" pruebas (ProfileExecutionID, tabla 16.1.1). */
export function environmentCode(env: SupportDocEnvironment): "1" | "2" {
  return env === "produccion" ? "1" : "2";
}

function isoDay(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** NIT del emisor: sólo dígitos, sin DV (con guión, lo de la derecha es el DV). */
export function emisorNit(emisor: Pick<EmisorData, "taxId">): string {
  const raw = (emisor.taxId ?? "").trim();
  return (raw.includes("-") ? raw.split("-")[0] : raw).replace(/\D/g, "");
}

type ConfigRow = NonNullable<Awaited<ReturnType<typeof findConfig>>>;

async function findConfig(emisor: EmisorData) {
  return db.dianConfig.findUnique({
    where:
      emisor.ref.kind === "legalEntity"
        ? { legalEntityId: emisor.ref.id }
        : { restaurantId: emisor.ref.id },
  });
}

/** Campos de la autorización de numeración del DS que faltan. */
export const DS_RESOLUTION_FIELDS = [
  "resolutionNumber",
  "prefix",
  "from",
  "to",
  "validFrom",
  "validTo",
] as const;
export type DsResolutionField = (typeof DS_RESOLUTION_FIELDS)[number];

export function missingDsResolution(c: Partial<ConfigRow> | null): DsResolutionField[] {
  const out: DsResolutionField[] = [];
  if (!c?.supportDocResolutionNumber) out.push("resolutionNumber");
  if (!c?.supportDocPrefix) out.push("prefix");
  if (c?.supportDocFrom == null) out.push("from");
  if (c?.supportDocTo == null) out.push("to");
  if (!c?.supportDocValidFrom) out.push("validFrom");
  if (!c?.supportDocValidTo) out.push("validTo");
  return out;
}

export function dsResolution(c: Partial<ConfigRow> | null): DianResolution | null {
  if (!c || missingDsResolution(c).length > 0) return null;
  return {
    number: c.supportDocResolutionNumber!,
    prefix: c.supportDocPrefix!,
    from: c.supportDocFrom!,
    to: c.supportDocTo!,
    startDate: isoDay(c.supportDocValidFrom)!,
    endDate: isoDay(c.supportDocValidTo)!,
  };
}

/**
 * Adquiriente del DS (el comercio). Responsabilidad "R-99-PN" (No aplica):
 * el sistema no conoce las responsabilidades fiscales del RUT del comercio y
 * DSAK26 sólo exige que el valor esté en la tabla 16.2.5.1; declarar "gran
 * contribuyente" o "autorretenedor" sin saberlo sería afirmar algo falso.
 * Tributo: IVA si el comercio vende con IVA; si no, "ZZ No aplica".
 */
export function buyerFromEmisor(
  emisor: EmisorData,
  salesTaxKind: string | null | undefined,
): SupportDocBuyer {
  const nit = emisorNit(emisor);
  return {
    personType: "1",
    name: (emisor.legalName ?? "").trim(),
    nit,
    dv: computeNitDv(nit) ?? "",
    taxLevelCode: TAX_LEVEL_NOT_APPLICABLE,
    taxSchemeId: salesTaxKind === "iva" ? "01" : "ZZ",
  };
}

/** Lo que falta en la configuración para poder generar (nunca incluye secretos). */
export type SupportDocMissing =
  | "einvoicing_module"
  | "enabled"
  | "certificate"
  | "software_id"
  | "software_pin"
  | "test_set_id"
  | "legal_name"
  | "tax_id"
  | DsResolutionField;

export type SupportDocConfigView = {
  exists: boolean;
  enabled: boolean;
  environment: SupportDocEnvironment;
  status: "pending" | "testing" | "enabled";
  softwareId: string | null;
  hasSoftwarePin: boolean;
  testSetId: string | null;
  resolutionNumber: string | null;
  prefix: string | null;
  from: number | null;
  to: number | null;
  validFrom: string | null;
  validTo: string | null;
  adjustmentPrefix: string;
  /** El certificado es el de facturación electrónica. */
  hasCertificate: boolean;
  certNotAfter: string | null;
  einvoicingEnabled: boolean;
  /** Próximo número del DS en el ambiente actual (null si no hay resolución). */
  nextNumber: number | null;
  missing: SupportDocMissing[];
};

/** Vista SEGURA (sin secretos) para la pantalla de configuración y los paneles. */
export async function supportDocConfigView(restaurantId: string): Promise<SupportDocConfigView> {
  const [emisor, tenant] = await Promise.all([
    resolveEmisor(restaurantId),
    db.restaurant.findUnique({ where: { id: restaurantId }, select: { enabledModules: true } }),
  ]);
  const c = emisor ? await findConfig(emisor) : null;
  const environment = (c?.supportDocEnvironment as SupportDocEnvironment) ?? "habilitacion";
  const einvoicingEnabled = isModuleEnabled(tenant?.enabledModules, "einvoicing");
  const missing: SupportDocMissing[] = [];
  if (!einvoicingEnabled) missing.push("einvoicing_module");
  if (!c?.supportDocEnabled) missing.push("enabled");
  if (!c?.certP12Enc || !c?.certPasswordEnc) missing.push("certificate");
  if (!c?.supportDocSoftwareId) missing.push("software_id");
  if (!c?.supportDocSoftwarePinEnc) missing.push("software_pin");
  if (environment === "habilitacion" && !c?.supportDocTestSetId) missing.push("test_set_id");
  if (!emisor?.legalName) missing.push("legal_name");
  if (!emisor || !emisorNit(emisor)) missing.push("tax_id");
  missing.push(...missingDsResolution(c));

  let nextNumber: number | null = null;
  const resolution = dsResolution(c);
  if (resolution && emisor) {
    const series = await db.supportDocumentSeries.findUnique({
      where: {
        issuerNit_environment_kind_prefix: {
          issuerNit: emisorNit(emisor),
          environment: environmentCode(environment),
          kind: "support_document",
          prefix: resolution.prefix,
        },
      },
      select: { nextNumber: true },
    });
    nextNumber = Math.max(series?.nextNumber ?? resolution.from, resolution.from);
  }

  return {
    exists: !!c,
    enabled: !!c?.supportDocEnabled,
    environment,
    status: (c?.supportDocStatus as SupportDocConfigView["status"]) ?? "pending",
    softwareId: c?.supportDocSoftwareId ?? null,
    hasSoftwarePin: !!c?.supportDocSoftwarePinEnc,
    testSetId: c?.supportDocTestSetId ?? null,
    resolutionNumber: c?.supportDocResolutionNumber ?? null,
    prefix: c?.supportDocPrefix ?? null,
    from: c?.supportDocFrom ?? null,
    to: c?.supportDocTo ?? null,
    validFrom: isoDay(c?.supportDocValidFrom),
    validTo: isoDay(c?.supportDocValidTo),
    adjustmentPrefix: c?.supportDocAdjustmentPrefix ?? "NAS",
    hasCertificate: !!c?.certP12Enc,
    certNotAfter: c?.certNotAfter?.toISOString() ?? null,
    einvoicingEnabled,
    nextNumber,
    missing,
  };
}

export type LoadedSupportDocConfig = {
  configId: string;
  environment: SupportDocEnvironment;
  envCode: "1" | "2";
  cert: LoadedCert;
  softwareId: string;
  softwarePin: string;
  testSetId: string | null;
  resolution: DianResolution;
  adjustmentPrefix: string;
  status: string;
  emisor: EmisorData;
  buyer: SupportDocBuyer;
};

/**
 * Configuración DESCIFRADA para firmar y enviar (sólo server-side). Lanza
 * SupportDocError si falta algo: nunca devuelve secretos a medias. Valida
 * TODO antes de numerar: un número del rango autorizado no se gasta en un
 * documento que de entrada no podía salir.
 */
export async function loadSupportDocConfig(
  restaurantId: string,
  opts: { now?: Date } = {},
): Promise<LoadedSupportDocConfig> {
  const now = opts.now ?? new Date();
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, salesTaxKind: true },
  });
  if (!isModuleEnabled(tenant?.enabledModules, "einvoicing")) throw new SupportDocError("module_disabled");
  const emisor = await resolveEmisor(restaurantId);
  if (!emisor) throw new SupportDocError("no_config");
  const c = await findConfig(emisor);
  if (!c) throw new SupportDocError("no_config");
  if (!c.supportDocEnabled) throw new SupportDocError("not_enabled");
  const missingEmisor = [
    ...(emisor.legalName?.trim() ? [] : ["legal_name"]),
    ...(emisorNit(emisor) ? [] : ["tax_id"]),
  ];
  if (missingEmisor.length) throw new SupportDocError("emisor_incomplete", missingEmisor);
  if (!c.certP12Enc || !c.certPasswordEnc) throw new SupportDocError("no_certificate");
  if (!c.supportDocSoftwareId || !c.supportDocSoftwarePinEnc) throw new SupportDocError("missing_software");
  const environment = (c.supportDocEnvironment === "produccion" ? "produccion" : "habilitacion") as SupportDocEnvironment;
  if (environment === "habilitacion" && !c.supportDocTestSetId) throw new SupportDocError("test_set_missing");
  const resolution = dsResolution(c);
  if (!resolution) throw new SupportDocError("missing_resolution", missingDsResolution(c));
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.DIAN_MASTER_KEY ?? "")) throw new SupportDocError("master_key_missing");
  let cert: LoadedCert;
  let softwarePin: string;
  try {
    const p12 = decryptSecret(Buffer.from(c.certP12Enc).toString("base64"));
    const password = decryptSecret(c.certPasswordEnc).toString("utf8");
    cert = loadP12(p12, password);
    softwarePin = decryptSecret(c.supportDocSoftwarePinEnc).toString("utf8");
  } catch {
    throw new SupportDocError("decrypt_failed");
  }
  if (cert.notBefore > now || cert.notAfter <= now) throw new SupportDocError("certificate_expired");
  return {
    configId: c.id,
    environment,
    envCode: environmentCode(environment),
    cert,
    softwareId: c.supportDocSoftwareId,
    softwarePin,
    testSetId: c.supportDocTestSetId,
    resolution,
    adjustmentPrefix: c.supportDocAdjustmentPrefix || "NAS",
    status: c.supportDocStatus,
    emisor,
    buyer: buyerFromEmisor(emisor, tenant?.salesTaxKind),
  };
}
