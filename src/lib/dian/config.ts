// Resolución y vista segura de la configuración DIAN (ERP B1.5).
//
// El emisor de un restaurante es su LegalEntity (si pertenece a un grupo
// con razón social) o el propio Restaurant (independiente) — mismo
// criterio que la numeración DIAN. DianConfig cuelga del emisor. Este
// módulo resuelve cuál aplica, arma la vista segura (SIN secretos, para
// el cliente) y carga el certificado descifrado (SOLO server-side, para
// firmar).
import { db } from "@/lib/db";
import { decryptSecret, loadP12, type LoadedCert } from "@/lib/dian/crypto";
import { computeNitDv } from "@/lib/erp/exogena";
import type { DianParty, DianResolution } from "@/lib/dian/ubl";

export type EmisorRef =
  | { kind: "legalEntity"; id: string }
  | { kind: "restaurant"; id: string };

export type EmisorData = {
  ref: EmisorRef;
  legalName: string | null;
  taxId: string | null;
  addressLine: string | null;
  cityName: string | null;
  /** Resolución de numeración (del emisor). */
  resolution: string | null;
  resolutionFrom: number | null;
  resolutionTo: number | null;
  /** Número pelado del acto administrativo — lo que va al XML. */
  resolutionNumber: string | null;
  /** Vigencia del rango, "YYYY-MM-DD" (lo que va a AuthorizationPeriod). */
  resolutionValidFrom: string | null;
  resolutionValidTo: string | null;
  invoicePrefix: string | null;
};

/** Fecha → "YYYY-MM-DD" (la DIAN no acepta timestamps en la vigencia). */
function isoDay(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Resuelve el emisor de un restaurante (LegalEntity del grupo o él mismo). */
export async function resolveEmisor(restaurantId: string): Promise<EmisorData | null> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      legalName: true,
      taxId: true,
      legalAddress: true,
      legalCity: true,
      dianResolution: true,
      dianResolutionFrom: true,
      dianResolutionTo: true,
      dianResolutionNumber: true,
      dianResolutionValidFrom: true,
      dianResolutionValidTo: true,
      invoicePrefix: true,
      legalEntity: {
        select: {
          id: true,
          name: true,
          taxId: true,
          address: true,
          city: true,
          dianResolution: true,
          dianResolutionFrom: true,
          dianResolutionTo: true,
          dianResolutionNumber: true,
          dianResolutionValidFrom: true,
          dianResolutionValidTo: true,
          invoicePrefix: true,
        },
      },
    },
  });
  if (!r) return null;
  if (r.legalEntity) {
    const le = r.legalEntity;
    return {
      ref: { kind: "legalEntity", id: le.id },
      legalName: le.name,
      taxId: le.taxId,
      addressLine: le.address,
      cityName: le.city,
      resolution: le.dianResolution,
      resolutionFrom: le.dianResolutionFrom,
      resolutionTo: le.dianResolutionTo,
      resolutionNumber: le.dianResolutionNumber,
      resolutionValidFrom: isoDay(le.dianResolutionValidFrom),
      resolutionValidTo: isoDay(le.dianResolutionValidTo),
      invoicePrefix: le.invoicePrefix,
    };
  }
  return {
    ref: { kind: "restaurant", id: r.id },
    legalName: r.legalName,
    taxId: r.taxId,
    addressLine: r.legalAddress,
    cityName: r.legalCity,
    resolution: r.dianResolution,
    resolutionFrom: r.dianResolutionFrom,
    resolutionTo: r.dianResolutionTo,
    resolutionNumber: r.dianResolutionNumber,
    resolutionValidFrom: isoDay(r.dianResolutionValidFrom),
    resolutionValidTo: isoDay(r.dianResolutionValidTo),
    invoicePrefix: r.invoicePrefix,
  };
}

/** Vista del emisor para el cliente (sin el `ref` interno). */
export type EmisorView = {
  kind: "legalEntity" | "restaurant";
  legalName: string | null;
  taxId: string | null;
  resolution: string | null;
  resolutionNumber: string | null;
  resolutionFrom: number | null;
  resolutionTo: number | null;
  resolutionValidFrom: string | null;
  resolutionValidTo: string | null;
  invoicePrefix: string | null;
};

export function emisorView(emisor: EmisorData): EmisorView {
  return {
    kind: emisor.ref.kind,
    legalName: emisor.legalName,
    taxId: emisor.taxId,
    resolution: emisor.resolution,
    resolutionNumber: emisor.resolutionNumber,
    resolutionFrom: emisor.resolutionFrom,
    resolutionTo: emisor.resolutionTo,
    resolutionValidFrom: emisor.resolutionValidFrom,
    resolutionValidTo: emisor.resolutionValidTo,
    invoicePrefix: emisor.invoicePrefix,
  };
}

/**
 * Datos de la resolución de numeración que FALTAN para poder enviar. La
 * DIAN valida los cinco contra el registro del contribuyente: si alguno
 * va vacío o inventado rechaza el documento entero (FAB05b, FAB07b,
 * FAB08b, FAB10b, FAB11b, FAB12b, FAD05c). Preferimos avisar antes de
 * enviar que quemar un consecutivo en un rechazo seguro.
 */
export const RESOLUTION_FIELDS = [
  "resolutionNumber",
  "invoicePrefix",
  "resolutionFrom",
  "resolutionTo",
  "resolutionValidFrom",
  "resolutionValidTo",
] as const;

export type ResolutionField = (typeof RESOLUTION_FIELDS)[number];

export function missingResolutionFields(emisor: EmisorData): ResolutionField[] {
  const missing: ResolutionField[] = [];
  if (!emisor.resolutionNumber) missing.push("resolutionNumber");
  if (!emisor.invoicePrefix) missing.push("invoicePrefix");
  if (emisor.resolutionFrom == null) missing.push("resolutionFrom");
  if (emisor.resolutionTo == null) missing.push("resolutionTo");
  if (!emisor.resolutionValidFrom) missing.push("resolutionValidFrom");
  if (!emisor.resolutionValidTo) missing.push("resolutionValidTo");
  return missing;
}

/**
 * Resolución lista para el XML. Devuelve null si falta algo — el caller
 * NO debe enviar en ese caso (usar missingResolutionFields para el aviso).
 */
export function emisorResolution(emisor: EmisorData): DianResolution | null {
  if (missingResolutionFields(emisor).length > 0) return null;
  return {
    number: emisor.resolutionNumber!,
    startDate: emisor.resolutionValidFrom!,
    endDate: emisor.resolutionValidTo!,
    prefix: emisor.invoicePrefix!,
    from: emisor.resolutionFrom!,
    to: emisor.resolutionTo!,
  };
}

async function findConfig(ref: EmisorRef) {
  return db.dianConfig.findUnique({
    where:
      ref.kind === "legalEntity"
        ? { legalEntityId: ref.id }
        : { restaurantId: ref.id },
  });
}

export type DianConfigStatus = {
  exists: boolean;
  environment: "habilitacion" | "produccion";
  status: "pending" | "testing" | "enabled";
  hasCertificate: boolean;
  certSubject: string | null;
  certNotAfter: string | null;
  /** Días para el vencimiento del certificado (aviso ≤ 30). */
  certDaysToExpiry: number | null;
  hasSoftwareId: boolean;
  hasSoftwarePin: boolean;
  hasTechnicalKey: boolean;
  softwareId: string | null; // el ID no es secreto
  testSetId: string | null;
  /** Datos del emisor que faltan para poder facturar. */
  missingEmisor: string[];
  /** Datos de la resolución de numeración que faltan (bloquean el envío). */
  missingResolution: ResolutionField[];
};

/** Último documento enviado a la DIAN — para mostrar el resultado real. */
export type DianLastDocument = {
  id: string;
  state: string;
  cufe: string | null;
  trackId: string | null;
  errors: string[];
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Errores legibles de un DianDocument. `errors` es Json en el schema:
 * puede venir array de strings, string suelto o null.
 */
export function documentErrors(errors: unknown): string[] {
  if (Array.isArray(errors)) return errors.map((e) => String(e));
  if (typeof errors === "string" && errors.trim()) return [errors];
  return [];
}

/**
 * Último documento enviado a la DIAN desde el set de pruebas (los del
 * set no tienen SimpleInvoice asociada). Es lo que la pantalla de
 * habilitación necesita para no quedarse en "en proceso" para siempre.
 */
export async function lastTestSetDocument(
  restaurantId: string,
): Promise<DianLastDocument | null> {
  const doc = await db.dianDocument.findFirst({
    where: { restaurantId, simpleInvoiceId: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      state: true,
      cufe: true,
      trackId: true,
      errors: true,
      responseXml: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!doc) return null;
  // El mensaje de la DIAN no tiene columna propia: se re-lee de la
  // respuesta cruda que ya guardamos, así no hace falta migrar el schema.
  let statusMessage: string | null = null;
  if (doc.responseXml) {
    const { parseDianResponse } = await import("@/lib/dian/soap");
    statusMessage = parseDianResponse(doc.responseXml).statusMessage ?? null;
  }
  return {
    id: doc.id,
    state: doc.state,
    cufe: doc.cufe,
    trackId: doc.trackId,
    errors: documentErrors(doc.errors),
    statusMessage,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Vista SEGURA de la config — nunca incluye secretos. Para el cliente. */
export async function dianConfigStatus(
  restaurantId: string,
): Promise<{ emisor: EmisorData | null; status: DianConfigStatus }> {
  const emisor = await resolveEmisor(restaurantId);
  const missingEmisor: string[] = [];
  if (emisor) {
    if (!emisor.legalName) missingEmisor.push("legalName");
    if (!emisor.taxId) missingEmisor.push("taxId");
    if (!emisor.resolution) missingEmisor.push("resolution");
    if (!emisor.invoicePrefix) missingEmisor.push("invoicePrefix");
  }
  const config = emisor ? await findConfig(emisor.ref) : null;
  const now = Date.now();
  const status: DianConfigStatus = {
    exists: !!config,
    environment: (config?.environment as "habilitacion" | "produccion") ?? "habilitacion",
    status: (config?.status as "pending" | "testing" | "enabled") ?? "pending",
    hasCertificate: !!config?.certP12Enc,
    certSubject: config?.certSubject ?? null,
    certNotAfter: config?.certNotAfter?.toISOString() ?? null,
    certDaysToExpiry: config?.certNotAfter
      ? Math.floor((config.certNotAfter.getTime() - now) / 86_400_000)
      : null,
    hasSoftwareId: !!config?.softwareId,
    hasSoftwarePin: !!config?.softwarePinEnc,
    hasTechnicalKey: !!config?.technicalKey,
    softwareId: config?.softwareId ?? null,
    testSetId: config?.testSetId ?? null,
    missingEmisor,
    missingResolution: emisor ? missingResolutionFields(emisor) : [],
  };
  return { emisor, status };
}

export type LoadedDianConfig = {
  configId: string;
  environment: "habilitacion" | "produccion";
  cert: LoadedCert;
  softwareId: string;
  softwarePin: string;
  technicalKey: string;
  testSetId: string | null;
};

export class DianConfigError extends Error {
  constructor(
    public code:
      | "no_config"
      | "no_certificate"
      | "missing_credentials"
      | "master_key_missing"
      | "decrypt_failed",
  ) {
    super(code);
  }
}

/**
 * Carga la config DESCIFRADA para firmar/enviar (solo server-side).
 * Lanza DianConfigError si falta algo — nunca devuelve secretos parciales.
 */
export async function loadDianConfig(
  restaurantId: string,
): Promise<LoadedDianConfig> {
  const emisor = await resolveEmisor(restaurantId);
  if (!emisor) throw new DianConfigError("no_config");
  const config = await findConfig(emisor.ref);
  if (!config) throw new DianConfigError("no_config");
  if (!config.certP12Enc || !config.certPasswordEnc) {
    throw new DianConfigError("no_certificate");
  }
  if (!config.softwareId || !config.softwarePinEnc || !config.technicalKey) {
    throw new DianConfigError("missing_credentials");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.DIAN_MASTER_KEY ?? "")) {
    throw new DianConfigError("master_key_missing");
  }
  let cert: LoadedCert;
  let softwarePin: string;
  try {
    const p12 = decryptSecret(Buffer.from(config.certP12Enc).toString("base64"));
    const password = decryptSecret(config.certPasswordEnc).toString("utf8");
    cert = loadP12(p12, password);
    softwarePin = decryptSecret(config.softwarePinEnc).toString("utf8");
  } catch {
    throw new DianConfigError("decrypt_failed");
  }
  return {
    configId: config.id,
    environment: config.environment as "habilitacion" | "produccion",
    cert,
    softwareId: config.softwareId,
    softwarePin,
    technicalKey: config.technicalKey,
    testSetId: config.testSetId,
  };
}

/**
 * Emisor (DianParty) para el UBL, desde los datos legales del comercio.
 *
 * El NIT se guarda con o sin DV; acá se normaliza a "solo dígitos del
 * NIT" + DV calculado aparte. Si el comercio escribió "901234567-8" el
 * guión ya separa el DV; si no, se calcula por módulo 11 (computeNitDv,
 * el mismo del formato 1001 de exógena). Sin DV la DIAN rechaza el
 * documento (FAJ24, FAJ24a, FAJ47 y, en el SoftwareProvider, FAB22a/b).
 */
export function emisorToSupplierParty(emisor: EmisorData): DianParty {
  const raw = (emisor.taxId ?? "").trim();
  // Con guión, lo de la derecha es el DV escrito por el comercio; se
  // ignora y se recalcula, que es lo que la DIAN valida.
  const nit = (raw.includes("-") ? raw.split("-")[0] : raw).replace(/\D/g, "");
  return {
    name: emisor.legalName ?? "",
    companyId: nit,
    dv: computeNitDv(nit),
    idSchemeName: "31",
    taxLevelCode: "O-13",
    taxRegimeCode: "49",
    personType: "1",
    address: emisor.cityName
      ? {
          cityCode: "11001",
          cityName: emisor.cityName,
          deptCode: "11",
          deptName: emisor.cityName,
          line: emisor.addressLine ?? "",
        }
      : null,
  };
}

/** Upsert de la config sobre el emisor correcto (crea el registro 1:1). */
export async function upsertDianConfig(
  emisor: EmisorData,
  data: Record<string, unknown>,
) {
  const where =
    emisor.ref.kind === "legalEntity"
      ? { legalEntityId: emisor.ref.id }
      : { restaurantId: emisor.ref.id };
  const link =
    emisor.ref.kind === "legalEntity"
      ? { legalEntityId: emisor.ref.id }
      : { restaurantId: emisor.ref.id };
  const existing = await db.dianConfig.findUnique({ where });
  if (existing) {
    return db.dianConfig.update({ where: { id: existing.id }, data });
  }
  return db.dianConfig.create({ data: { ...link, ...data } });
}
