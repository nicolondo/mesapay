// Resolución y vista segura de la configuración DIAN (ERP B1.5).
//
// El emisor de un restaurante es su LegalEntity (si pertenece a un grupo
// con razón social) o el propio Restaurant (independiente) — mismo
// criterio que la numeración DIAN. DianConfig cuelga del emisor. Este
// módulo resuelve cuál aplica, arma la vista segura (SIN secretos, para
// el cliente) y carga el certificado descifrado (SOLO server-side, para
// firmar).
import { db } from "@/lib/db";
import { findMunicipioByCode, municipioLabel } from "@/lib/dane/municipios";
import { decryptSecret, loadP12, type LoadedCert } from "@/lib/dian/crypto";
import { computeNitDv } from "@/lib/erp/exogena";
import { isModuleEnabled } from "@/lib/modules";
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
  /**
   * Municipio DANE (DIVIPOLA, 5 dígitos) del ESTABLECIMIENTO. Sale
   * siempre del Restaurant, aun cuando el emisor es un LegalEntity: la
   * razón social de un grupo puede cubrir locales en varios municipios,
   * y lo que la DIAN resuelve con este código es el punto de facturación
   * —o sea, el local que emite—, no la sede de la sociedad. Además es el
   * único que la UI captura (Configuración → Identidad, por restaurante).
   */
  legalCityCode: string | null;
  /**
   * LEGACY — texto libre de la resolución que se pedía en Identidad. Ya
   * no se edita: sobrevive como fallback del comprobante impreso y para
   * avisarle al operador cuando NO coincide con `resolutionNumber`.
   */
  resolution: string | null;
  resolutionFrom: number | null;
  resolutionTo: number | null;
  /** Número pelado del acto administrativo — lo que va al XML. */
  resolutionNumber: string | null;
  /** Vigencia del rango, "YYYY-MM-DD" (lo que va a AuthorizationPeriod). */
  resolutionValidFrom: string | null;
  resolutionValidTo: string | null;
  /** Fecha del acto administrativo, "YYYY-MM-DD" — sólo para el comprobante. */
  resolutionDate: string | null;
  invoicePrefix: string | null;
  /**
   * Próximo consecutivo a emitir. OJO: sale SIEMPRE del Restaurant, aun
   * cuando el emisor es un LegalEntity, porque el que lo incrementa
   * atómicamente al emitir es `simpleInvoice.ts` sobre el Restaurant.
   * Leerlo del LegalEntity mostraría un número que nadie consume.
   */
  invoiceNextNumber: number;
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
      legalCityCode: true,
      dianResolution: true,
      dianResolutionFrom: true,
      dianResolutionTo: true,
      dianResolutionNumber: true,
      dianResolutionValidFrom: true,
      dianResolutionValidTo: true,
      dianResolutionDate: true,
      invoicePrefix: true,
      invoiceNextNumber: true,
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
          dianResolutionDate: true,
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
      // Del restaurante a propósito — ver el comentario del campo.
      legalCityCode: r.legalCityCode,
      resolution: le.dianResolution,
      resolutionFrom: le.dianResolutionFrom,
      resolutionTo: le.dianResolutionTo,
      resolutionNumber: le.dianResolutionNumber,
      resolutionValidFrom: isoDay(le.dianResolutionValidFrom),
      resolutionValidTo: isoDay(le.dianResolutionValidTo),
      resolutionDate: isoDay(le.dianResolutionDate),
      invoicePrefix: le.invoicePrefix,
      // Ídem: el contador que se incrementa al emitir es el del Restaurant.
      invoiceNextNumber: r.invoiceNextNumber,
    };
  }
  return {
    ref: { kind: "restaurant", id: r.id },
    legalName: r.legalName,
    taxId: r.taxId,
    addressLine: r.legalAddress,
    cityName: r.legalCity,
    legalCityCode: r.legalCityCode,
    resolution: r.dianResolution,
    resolutionFrom: r.dianResolutionFrom,
    resolutionTo: r.dianResolutionTo,
    resolutionNumber: r.dianResolutionNumber,
    resolutionValidFrom: isoDay(r.dianResolutionValidFrom),
    resolutionValidTo: isoDay(r.dianResolutionValidTo),
    resolutionDate: isoDay(r.dianResolutionDate),
    invoicePrefix: r.invoicePrefix,
    invoiceNextNumber: r.invoiceNextNumber,
  };
}

/** Vista del emisor para el cliente (sin el `ref` interno). */
export type EmisorView = {
  kind: "legalEntity" | "restaurant";
  legalName: string | null;
  taxId: string | null;
  addressLine: string | null;
  /**
   * Municipio legible del establecimiento. Sale del catálogo DANE cuando
   * hay código ("Envigado, Antioquia"); si no, es el texto libre viejo.
   * Se arma en el server para no mandarle los 1.122 municipios al
   * navegador sólo para pintar una línea.
   */
  cityLabel: string | null;
  resolution: string | null;
  resolutionNumber: string | null;
  resolutionFrom: number | null;
  resolutionTo: number | null;
  resolutionValidFrom: string | null;
  resolutionValidTo: string | null;
  resolutionDate: string | null;
  invoicePrefix: string | null;
  invoiceNextNumber: number;
  /**
   * El texto legacy dice un número DISTINTO al que se manda a la DIAN.
   * Es exactamente el caso que motivó unificar las pantallas: el operador
   * cargó 18764094877213 en Identidad y el XML llevaba 18760000001, y
   * desde la UI no había forma de notarlo. Se expone para que la pantalla
   * muestre AMBOS y el operador elija — nunca se decide por él.
   */
  legacyResolutionConflict: string | null;
};

/**
 * Texto legacy que contradice al número real. Devuelve null cuando no hay
 * texto, cuando no hay número todavía (ahí el texto es candidato, no
 * conflicto) o cuando el texto contiene al número (p.ej. "Resolución
 * 18760000001 del 1 de enero"), que es el caso sano.
 */
export function legacyResolutionConflict(
  emisor: Pick<EmisorData, "resolution" | "resolutionNumber">,
): string | null {
  const legacy = emisor.resolution?.trim();
  const real = emisor.resolutionNumber?.trim();
  if (!legacy || !real) return null;
  return legacy.includes(real) ? null : legacy;
}

export function emisorView(emisor: EmisorData): EmisorView {
  const municipio = findMunicipioByCode(emisor.legalCityCode);
  return {
    kind: emisor.ref.kind,
    legalName: emisor.legalName,
    taxId: emisor.taxId,
    addressLine: emisor.addressLine,
    cityLabel: municipio ? municipioLabel(municipio) : emisor.cityName,
    resolution: emisor.resolution,
    resolutionNumber: emisor.resolutionNumber,
    resolutionFrom: emisor.resolutionFrom,
    resolutionTo: emisor.resolutionTo,
    resolutionValidFrom: emisor.resolutionValidFrom,
    resolutionValidTo: emisor.resolutionValidTo,
    resolutionDate: emisor.resolutionDate,
    invoicePrefix: emisor.invoicePrefix,
    invoiceNextNumber: emisor.invoiceNextNumber,
    legacyResolutionConflict: legacyResolutionConflict(emisor),
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

/**
 * Datos de UBICACIÓN que faltan para poder enviar. Mismo criterio que la
 * resolución: preferimos bloquear a mandar un dato inventado.
 *
 * El emisor mandaba Bogotá (11001/11) fijo para TODOS los comercios. La
 * DIAN resuelve el punto de facturación por la ubicación declarada del
 * establecimiento, así que un código que no es el del comercio alimenta
 * los rechazos FAB10a y FAJ50 — y encima quema el consecutivo. No hay
 * default honesto posible: sin municipio DANE cargado, no se envía.
 *
 * El operador lo carga en Configuración → Identidad, eligiéndolo del
 * catálogo DIVIPOLA (no se escribe a mano, ni se adivina del texto).
 */
export const LOCATION_FIELDS = ["legalCityCode"] as const;

export type LocationField = (typeof LOCATION_FIELDS)[number];

export function missingLocationFields(emisor: EmisorData): LocationField[] {
  // Ausente, o con un código que no existe en DIVIPOLA: las dos cosas
  // significan que no sabemos dónde está el establecimiento.
  return findMunicipioByCode(emisor.legalCityCode) ? [] : ["legalCityCode"];
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
  /** Ubicación DANE del establecimiento que falta (bloquea el envío). */
  missingLocation: LocationField[];
  /** ¿El módulo de facturación electrónica está activo para el comercio? */
  einvoicingEnabled: boolean;
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
  // `missingEmisor` es lo que se carga en IDENTIDAD (razón social, NIT,
  // dirección). La resolución y el prefijo ya NO viven ahí: se avisan
  // aparte con missingResolution, que es lo que de verdad bloquea.
  const missingEmisor: string[] = [];
  if (emisor) {
    if (!emisor.legalName) missingEmisor.push("legalName");
    if (!emisor.taxId) missingEmisor.push("taxId");
    if (!emisor.addressLine) missingEmisor.push("addressLine");
  }
  const config = emisor ? await findConfig(emisor.ref) : null;
  // El módulo vive en el RESTAURANTE (no en el emisor): la resolución de
  // numeración se configura con o sin facturación electrónica, pero el
  // certificado y la habilitación sólo aplican con el módulo activo.
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true },
  });
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
    missingLocation: emisor ? missingLocationFields(emisor) : [],
    einvoicingEnabled: isModuleEnabled(tenant?.enabledModules, "einvoicing"),
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
 *
 * La ubicación sale del catálogo DIVIPOLA, resuelta desde el código que
 * el comercio eligió en Identidad. Antes iba Bogotá (11001/11) fija y el
 * departamento repetía el nombre de la ciudad, así que TODA factura
 * declaraba un establecimiento en Bogotá aunque estuviera en Envigado —
 * candidato directo a FAB10a/FAJ50. El nombre también sale del catálogo
 * (no del texto libre `legalCity`) para que nombre y código no puedan
 * contradecirse, y el departamento de `municipio.deptCode`, que es el
 * prefijo del propio código: no hay tabla aparte que mantener.
 *
 * Sin código cargado se devuelve `address: null`; los callers ya
 * bloquean antes con `missingLocationFields`.
 */
export function emisorToSupplierParty(emisor: EmisorData): DianParty {
  const raw = (emisor.taxId ?? "").trim();
  // Con guión, lo de la derecha es el DV escrito por el comercio; se
  // ignora y se recalcula, que es lo que la DIAN valida.
  const nit = (raw.includes("-") ? raw.split("-")[0] : raw).replace(/\D/g, "");
  const municipio = findMunicipioByCode(emisor.legalCityCode);
  return {
    name: emisor.legalName ?? "",
    companyId: nit,
    dv: computeNitDv(nit),
    idSchemeName: "31",
    taxLevelCode: "O-13",
    taxRegimeCode: "49",
    personType: "1",
    address: municipio
      ? {
          cityCode: municipio.code,
          cityName: municipio.name,
          deptCode: municipio.deptCode,
          deptName: municipio.deptName,
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
