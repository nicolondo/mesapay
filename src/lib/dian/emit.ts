// Emisión de documentos DIAN desde una factura simple (ERP B1.6).
//
// Puente entre el flujo de facturación actual (SimpleInvoice, que ya
// existe como representación gráfica) y la DIAN: mapea la orden a líneas
// UBL, construye, firma, envía (SendBillSync en producción) y persiste
// el DianDocument. NUNCA bloquea la venta: si la DIAN rechaza o se cae,
// el documento queda con estado y errores legibles, con botón reintentar
// desde la UI (B1.6b).
import { db } from "@/lib/db";
import { suggestMunicipioFromText, type DaneMunicipio } from "@/lib/dane/municipios";
import { BLOCKED_RETRY_MS, claimWhere } from "@/lib/dian/retry";
import { splitTaxIncludedCents, type DianInvoiceInput, type DianLine, type DianParty } from "@/lib/dian/ubl";
import { computeNitDv } from "@/lib/erp/exogena";
import { isOwnTaxLine, type RestaurantTax, type SalesTaxKind } from "@/lib/salesTax";

/**
 * Adquiriente por defecto — "Consumidor final", NIT 222222222222 (anexo
 * 6.2.1: documento tipo "13", persona natural). Es el adquiriente de toda
 * factura GENÉRICA: la cuenta donde nadie cargó sus datos.
 *
 * Cuando el comensal SÍ pidió factura a su nombre (`InvoiceRequest`), el
 * adquiriente sale de `customerPartyFor`. Los dos lugares que nombran al
 * adquiriente —la factura (emit) y el `cac:ReceiverParty` del
 * AttachedDocument— tienen que pasar por la misma función: un sobre que
 * nombre a alguien distinto del que figura en la factura que lleva adentro
 * no se sostiene.
 */
export const CONSUMIDOR_FINAL: DianParty = {
  name: "Consumidor final",
  companyId: "222222222222",
  idSchemeName: "13",
  taxLevelCode: "R-99-PN",
  taxRegimeCode: "49",
  personType: "2",
};

/**
 * Lo que la solicitud de factura (`InvoiceRequest`) sabe del adquiriente.
 * Es un subconjunto de la fila para que la función sea pura y se pueda
 * llamar con lo que ya trae cualquier query.
 */
export type InvoiceRequestParty = {
  customerName: string;
  /** CC | CE | NIT | PA — el enum `InvoiceDocType` del schema. */
  docType: string;
  docNumber: string;
  /**
   * Dirección, ciudad y departamento: OPCIONALES. La solicitud de factura
   * dejó de pedirlos; sólo las filas viejas (o un cliente de facturación
   * cargado antes) los traen. Sin ellos la factura sale sin el bloque de
   * dirección del adquiriente, igual que la de consumidor final.
   */
  address?: string | null;
  city?: string | null;
  department?: string | null;
  email?: string | null;
};

/**
 * Tipo de documento del formulario → código del Anexo Técnico 1.9 (6.2.1).
 * "13" cédula de ciudadanía · "22" cédula de extranjería · "31" NIT ·
 * "41" pasaporte.
 */
const DOC_TYPE_SCHEME: Record<string, DianParty["idSchemeName"]> = {
  CC: "13",
  CE: "22",
  NIT: "31",
  PA: "41",
};

/**
 * Municipio DANE del adquiriente a partir del texto libre que dejó el
 * comensal (Google Places: ciudad + departamento).
 *
 * Se resuelve con el MISMO criterio conservador que la sugerencia del
 * emisor (`suggestMunicipioFromText`): sólo coincidencia exacta y única.
 * Primero "ciudad, departamento" —que desambigua los repetidos (hay
 * cinco "San Juan")— y después la ciudad sola, que es lo que rescata
 * "Bogotá" cuando el departamento vino como "Bogotá D.C.". Si no resuelve
 * se devuelve null y la factura sale SIN dirección del adquiriente en vez
 * de inventar un código: la dirección del adquiriente es opcional en el
 * anexo (el consumidor final nunca la lleva) y un código DANE equivocado
 * es un dato falso en un documento fiscal.
 */
export function resolveCustomerMunicipio(
  city: string | null | undefined,
  department: string | null | undefined,
): DaneMunicipio | null {
  const c = (city ?? "").trim();
  const d = (department ?? "").trim();
  if (!c) return null;
  return (
    (d ? suggestMunicipioFromText(`${c}, ${d}`) : null) ??
    suggestMunicipioFromText(c)
  );
}

/**
 * Identificación del adquiriente tal como va al XML (y al CUFE: es el
 * `NumAdq`). NIT: sólo los dígitos, sin el DV (que se recalcula aparte,
 * como en el emisor). Cédulas: sólo dígitos — el comensal las escribe con
 * puntos. Pasaporte: alfanumérico, sin espacios ni separadores.
 */
function customerCompanyId(docNumber: string, scheme: DianParty["idSchemeName"]): string {
  const raw = docNumber.trim();
  if (scheme === "31") {
    // Con guión, lo de la derecha es el DV escrito por el comensal; se
    // ignora y se recalcula, que es lo que la DIAN valida.
    return (raw.includes("-") ? raw.split("-")[0] : raw).replace(/\D/g, "");
  }
  if (scheme === "41") return raw.replace(/[^A-Za-z0-9]/g, "");
  return raw.replace(/\D/g, "");
}

/**
 * Adquiriente (DianParty) de una factura. Sin solicitud ⇒ consumidor
 * final, como siempre. Con solicitud ⇒ el cliente, con el mapeo del Anexo
 * Técnico 1.9:
 *
 *   · docType CC→"13", CE→"22", NIT→"31" (con DV calculado), PA→"41".
 *   · Persona natural (todo lo que no es NIT) ⇒ AdditionalAccountID "2" y
 *     responsabilidad "R-99-PN" (no responsable — 6.2.7). NIT ⇒ "1". La
 *     solicitud no sabe las responsabilidades fiscales de una empresa, así
 *     que también va "R-99-PN" ("No aplica – Otros"), que es lo que
 *     acepta la DIAN para un adquiriente del que no se declara nada más.
 *   · Régimen "49" (no responsable de IVA): la solicitud no trae el dato y
 *     declarar "48" sin saberlo sería afirmar algo del cliente.
 *   · Dirección: OPCIONAL. Sólo va el bloque cac:PhysicalLocation cuando
 *     hay municipio DANE resuelto del texto libre (ver
 *     `resolveCustomerMunicipio`) Y una línea de dirección; sin alguno de
 *     los dos se omite entero — la misma forma con la que sale (y la DIAN
 *     acepta) la factura a consumidor final. La solicitud ya no pide estos
 *     datos, así que lo normal es que no vayan.
 *   · Correo en cac:Contact — es a donde le llega el AttachedDocument.
 *
 * OJO: cambiar el adquiriente cambia el CUFE (`NumAdq` es este
 * `companyId`). `buildDianInvoiceXml` toma los dos —el que va al XML y el
 * del CUFE— de este mismo objeto, así que no pueden divergir.
 *
 * Si la identificación queda vacía después de normalizar (el comensal
 * escribió letras donde iba una cédula) se cae al consumidor final: una
 * cédula vacía es un rechazo seguro y cada rechazo quema un consecutivo.
 */
export function customerPartyFor(
  request: InvoiceRequestParty | null | undefined,
): DianParty {
  if (!request) return CONSUMIDOR_FINAL;
  const scheme = DOC_TYPE_SCHEME[request.docType] ?? "13";
  const companyId = customerCompanyId(request.docNumber, scheme);
  const name = request.customerName.trim();
  if (!companyId || !name) {
    console.warn("[dian] solicitud de factura sin identificación usable; sale a consumidor final", {
      docType: request.docType,
    });
    return CONSUMIDOR_FINAL;
  }
  const isNit = scheme === "31";
  const municipio = resolveCustomerMunicipio(request.city, request.department);
  const addressLine = (request.address ?? "").trim();
  const email = request.email?.trim();
  return {
    name,
    companyId,
    dv: isNit ? computeNitDv(companyId) : null,
    idSchemeName: scheme,
    taxLevelCode: "R-99-PN",
    taxRegimeCode: "49",
    personType: isNit ? "1" : "2",
    // Bloque de dirección sólo completo (municipio + línea): un
    // <cbc:Line> vacío o un municipio sin dirección nunca se ha enviado.
    address:
      municipio && addressLine
        ? {
            cityCode: municipio.code,
            cityName: municipio.name,
            deptCode: municipio.deptCode,
            deptName: municipio.deptName,
            line: addressLine,
          }
        : null,
    email: email || null,
  };
}

/** Misma regla que salesTax.isOwnTaxLine, sobre el item de la orden. */
function ownTaxItem(it: OrderItemForInvoice): boolean {
  return isOwnTaxLine({ amountCents: 0, taxKind: it.taxKind, taxPct: it.taxPct });
}

export type OrderItemForInvoice = {
  nameSnapshot: string;
  qty: number;
  priceCentsSnapshot: number;
  cancelledAt: Date | null;
  /** null ⇒ plato del menú (impuesto embebido con la tarifa del comercio). */
  taxKind: string | null;
  taxPct: number | null;
};

/** Tipo de impuesto → código del anexo: "01" IVA, "04" impoconsumo. */
function schemeOf(kind: SalesTaxKind): "01" | "04" {
  return kind === "inc" ? "04" : "01";
}

/**
 * Mapea los items vivos de una orden a líneas UBL (pura). Respeta los DOS
 * regímenes que conviven en una cuenta (ver src/lib/salesTax.ts):
 *
 *   · Plato de carta (taxKind null) → el impuesto va DENTRO del precio,
 *     con la tarifa del comercio: se reparte base + impuesto.
 *   · Línea libre (taxKind propio) → el impuesto se SUMA ENCIMA: la base
 *     es el precio tal cual y el impuesto se calcula sobre él.
 *
 * Antes se forzaba una sola tarifa para toda la factura, así que una
 * cuenta con un plato en INC 8% y un servicio en IVA 19% se enviaba a la
 * DIAN sin impuestos. Items cancelados fuera. Enteros exactos.
 */
export function orderToInvoiceLines(
  items: OrderItemForInvoice[],
  restaurantTax: RestaurantTax,
): DianLine[] {
  const lines: DianLine[] = [];
  for (const it of items) {
    const r = invoiceLineFor(it, restaurantTax);
    if (r) lines.push(r.line);
  }
  return lines;
}

/**
 * Una línea UBL a partir de un item (null si está cancelado o sin
 * cantidad). Es el ÚNICO lugar donde se reparte base + impuesto de un
 * plato: lo usa el XML (`orderToInvoiceLines`) y también la tirilla
 * (`embeddedMenuTax`, que congela el impuesto en el snapshot). Si el
 * reparto viviera en dos funciones, un redondeo distinto bastaría para
 * que el papel y el XML dijeran centavos diferentes.
 */
function invoiceLineFor(
  it: OrderItemForInvoice,
  restaurantTax: RestaurantTax,
): { line: DianLine; own: boolean } | null {
  if (it.cancelledAt || it.qty <= 0) return null;
  const grossLine = it.priceCentsSnapshot * it.qty;
  const own = ownTaxItem(it);
  const kind = (own ? it.taxKind : restaurantTax.kind) as SalesTaxKind;
  const pct = own ? (it.taxPct ?? 0) : restaurantTax.pct;
  const effectivePct = kind === "none" ? 0 : pct;

  let lineTotalCents: number;
  let unitPriceCents: number;
  let taxCents: number;
  if (own) {
    // Impuesto encima: la base es el precio de la línea.
    lineTotalCents = grossLine;
    unitPriceCents = it.priceCentsSnapshot;
    taxCents =
      effectivePct > 0 && grossLine > 0
        ? Math.round((grossLine * effectivePct) / 100)
        : 0;
  } else {
    // Impuesto embebido: base = bruto − impuesto (suman exacto).
    const split = splitTaxIncludedCents(grossLine, effectivePct * 100);
    lineTotalCents = split.baseCents;
    taxCents = split.taxCents;
    unitPriceCents = splitTaxIncludedCents(
      it.priceCentsSnapshot,
      effectivePct * 100,
    ).baseCents;
  }

  return {
    own,
    line: {
      description: it.nameSnapshot,
      quantity: it.qty,
      unitPriceCents,
      lineTotalCents,
      taxCents,
      taxPct: effectivePct.toFixed(2),
      taxSchemeId: schemeOf(kind),
    },
  };
}

export type EmbeddedMenuTax = {
  /** Σ del impuesto embebido de los platos del menú (0 si el comercio está en "none"). */
  taxCents: number;
  /** Σ de las bases (bruto − impuesto) de esos mismos platos. */
  baseCents: number;
  /** Σ del bruto de los platos del menú: base + impuesto. */
  grossCents: number;
};

/**
 * Impuesto EMBEBIDO de los platos del menú de una orden, con la tarifa
 * recibida — lo que la tirilla congela en el snapshot al emitirse.
 *
 * Es la suma, línea por línea, de los MISMOS `taxCents`/`lineTotalCents`
 * que `orderToInvoiceLines` pone en el XML (mismo `invoiceLineFor`, mismo
 * `splitTaxIncludedCents`), no una fórmula sobre el subtotal: partir el
 * subtotal entero redondea distinto que partir cada línea y el papel
 * quedaría a un centavo del XML. Las líneas libres no entran: su impuesto
 * va ENCIMA y ya viaja en `taxCents`/`taxByKind` del snapshot.
 *
 * Se calcula sobre el BRUTO de cada plato, sin descontar el descuento del
 * comensal, porque así lo hace el XML (`DianInvoiceInput` no lleva
 * descuento: cada línea va con su precio de carta). Cambiar el criterio
 * acá sin cambiarlo en el XML rompería la coincidencia al centavo.
 */
export function embeddedMenuTax(
  items: OrderItemForInvoice[],
  restaurantTax: RestaurantTax,
): EmbeddedMenuTax {
  let taxCents = 0;
  let baseCents = 0;
  for (const it of items) {
    const r = invoiceLineFor(it, restaurantTax);
    if (!r || r.own) continue;
    taxCents += r.line.taxCents;
    baseCents += r.line.lineTotalCents;
  }
  return { taxCents, baseCents, grossCents: baseCents + taxCents };
}

/**
 * Forma y medio de pago del XML según cómo se cobró la cuenta. Contado
 * (ID 1, efectivo "10") salvo que haya un cobro a crédito a un cliente:
 * entonces forma de pago "2" (crédito), medio "1" (instrumento no
 * definido — la plata llega después por el abono) y vencimiento = emisión
 * + plazo del cliente. `payments` es lo que trae la orden filtrado a
 * customer_credit aprobados (vacío en una venta normal).
 */
export function creditPaymentMeans(
  payments: readonly { billingCustomer: { creditTermsDays: number } | null }[],
  issueDate: string,
): Pick<DianInvoiceInput, "paymentMeansCode" | "paymentMeansId" | "paymentDueDate"> {
  const credit = payments.find((p) => p.billingCustomer);
  if (!credit?.billingCustomer) return { paymentMeansCode: "10" };
  const due = new Date(`${issueDate}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + Math.max(0, credit.billingCustomer.creditTermsDays));
  return {
    paymentMeansCode: "1",
    paymentMeansId: "2",
    paymentDueDate: due.toISOString().slice(0, 10),
  };
}

/** Hora Colombia "HH:mm:ss-05:00" para el XML/CUFE. */
export function bogotaIssueTime(now: Date): string {
  return (
    now.toLocaleTimeString("en-GB", { hour12: false, timeZone: "America/Bogota" }) +
    "-05:00"
  );
}

export type DianDocumentRef = {
  id: string;
  state: string;
  attempts: number;
  /** true si esta llamada lo creó (o adoptó un placeholder). */
  created: boolean;
};

const DOC_SELECT = { id: true, state: true, attempts: true } as const;

/**
 * Garantiza que la factura simple tenga su DianDocument (en `to_send` si
 * es nuevo). Idempotente y a prueba de carreras: `simpleInvoiceId` es
 * único, así que si dos rieles crean a la vez el perdedor cae al P2002 y
 * relee. Si la orden dejó un placeholder de `numbering_exhausted` (sin
 * tirilla, porque no había número), se ADOPTA en vez de crear otro: es el
 * mismo documento, que ahora sí tiene con qué salir.
 */
export async function ensureDianDocument(args: {
  simpleInvoiceId: string;
  restaurantId: string;
  orderId: string | null;
}): Promise<DianDocumentRef> {
  const existing = await db.dianDocument.findUnique({
    where: { simpleInvoiceId: args.simpleInvoiceId },
    select: DOC_SELECT,
  });
  if (existing) return { ...existing, created: false };

  if (args.orderId) {
    const adopted = await db.dianDocument.updateMany({
      where: { orderId: args.orderId, simpleInvoiceId: null, kind: "invoice" },
      data: {
        simpleInvoiceId: args.simpleInvoiceId,
        state: "to_send",
        lastError: null,
        nextAttemptAt: null,
        errors: [],
      },
    });
    if (adopted.count > 0) {
      const doc = await db.dianDocument.findUnique({
        where: { simpleInvoiceId: args.simpleInvoiceId },
        select: DOC_SELECT,
      });
      if (doc) return { ...doc, created: true };
    }
  }

  try {
    const created = await db.dianDocument.create({
      data: {
        restaurantId: args.restaurantId,
        simpleInvoiceId: args.simpleInvoiceId,
        orderId: args.orderId,
        kind: "invoice",
        state: "to_send",
      },
      select: DOC_SELECT,
    });
    return { ...created, created: true };
  } catch (err) {
    // Otro riel lo creó entre el findUnique y el create: es el suyo.
    if ((err as { code?: string })?.code === "P2002") {
      const doc = await db.dianDocument.findUnique({
        where: { simpleInvoiceId: args.simpleInvoiceId },
        select: DOC_SELECT,
      });
      if (doc) return { ...doc, created: false };
    }
    throw err;
  }
}

/**
 * RECLAMA la emisión: pasa el documento a `sent` con un updateMany
 * condicionado por estado (ver `claimWhere`). Es el cerrojo: si el
 * barrido y el intento inmediato del cobro llegan a la vez, sólo uno
 * actualiza una fila y sólo ese firma y envía. Devuelve el documento a
 * (re)enviar o null si ya está aceptado, pendiente en la DIAN o en vuelo.
 *
 * Crea el documento si no existe (ver `ensureDianDocument`).
 */
export async function claimDianDocument(
  simpleInvoiceId: string,
  restaurantId: string,
  opts: { orderId?: string | null; now?: Date } = {},
): Promise<{ id: string; attempts: number } | null> {
  const doc = await ensureDianDocument({
    simpleInvoiceId,
    restaurantId,
    orderId: opts.orderId ?? null,
  });
  const claimed = await db.dianDocument.updateMany({
    where: claimWhere(doc.id, opts.now ?? new Date()),
    data: { state: "sent" },
  });
  if (claimed.count === 0) return null;
  return { id: doc.id, attempts: doc.attempts };
}

/**
 * Deja constancia de una orden pagada que NO se pudo facturar porque el
 * rango de la resolución se agotó (`invoiceNextNumber > resolutionTo`): sin
 * número válido no hay tirilla ni SimpleInvoice, así que el registro
 * cuelga de la orden. Es un DianDocument en `to_send` con
 * `simpleInvoiceId` null; el barrido lo ve, vuelve a llamar a
 * `issueInvoiceOnPaid` y, cuando haya resolución nueva, la tirilla lo
 * adopta (ver `ensureDianDocument`). Uno por orden.
 */
export async function recordNumberingExhausted(args: {
  restaurantId: string;
  orderId: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  const data = {
    state: "to_send",
    lastError: "numbering_exhausted",
    errors: ["numbering_exhausted"],
    nextAttemptAt: new Date(now.getTime() + BLOCKED_RETRY_MS),
  };
  const touched = await db.dianDocument.updateMany({
    where: { orderId: args.orderId, simpleInvoiceId: null, kind: "invoice" },
    data,
  });
  if (touched.count > 0) return;
  await db.dianDocument.create({
    data: {
      restaurantId: args.restaurantId,
      orderId: args.orderId,
      kind: "invoice",
      ...data,
    },
    select: { id: true },
  });
}
