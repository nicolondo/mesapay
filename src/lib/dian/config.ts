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
import type { DianParty } from "@/lib/dian/ubl";

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
  invoicePrefix: string | null;
};

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
    invoicePrefix: r.invoicePrefix,
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
};

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

/** Emisor (DianParty) para el UBL, desde los datos legales del comercio. */
export function emisorToSupplierParty(emisor: EmisorData): DianParty {
  return {
    name: emisor.legalName ?? "",
    companyId: (emisor.taxId ?? "").replace(/\D/g, ""),
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
