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
import { dianDueDate, dianIssueDateTime } from "@/lib/dian/dianDateTime";
import { BLOCKED_RETRY_MS, claimWhere } from "@/lib/dian/retry";
import { type DianInvoiceInput, type DianParty } from "@/lib/dian/ubl";
import { computeNitDv } from "@/lib/erp/exogena";

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

// El mapeo ítems → líneas UBL (con el descuento del cliente adentro de cada
// línea) vive en `discountedLines.ts`, puro: lo comparten el XML, la
// tirilla, la precuenta y los reportes. Se re-exporta acá porque es lo que
// importaban los callers de siempre.
export {
  embeddedMenuTax,
  orderToInvoiceLines,
  saleLines,
  type EmbeddedMenuTax,
  type OrderItemForInvoice,
  type SaleLines,
} from "@/lib/dian/discountedLines";

/**
 * Forma y medio de pago del XML según cómo se cobró la cuenta. Contado
 * (ID 1, efectivo "10") salvo que haya un cobro a crédito a un cliente:
 * entonces forma de pago "2" (crédito), medio "1" (instrumento no
 * definido — la plata llega después por el abono) y vencimiento = emisión
 * + plazo del cliente. `payments` es lo que trae la orden filtrado a
 * customer_credit aprobados (vacío en una venta normal).
 *
 * `issueDate` es la fecha que DECLARA la factura (`dianIssueDateTime`, día
 * colombiano): el vencimiento se cuenta desde ahí, nunca desde el día UTC.
 */
export function creditPaymentMeans(
  payments: readonly { billingCustomer: { creditTermsDays: number } | null }[],
  issueDate: string,
): Pick<DianInvoiceInput, "paymentMeansCode" | "paymentMeansId" | "paymentDueDate"> {
  const credit = payments.find((p) => p.billingCustomer);
  if (!credit?.billingCustomer) return { paymentMeansCode: "10" };
  return {
    paymentMeansCode: "1",
    paymentMeansId: "2",
    paymentDueDate: dianDueDate(issueDate, credit.billingCustomer.creditTermsDays),
  };
}

/**
 * Forma y medio de pago de la factura (cac:PaymentMeans), con la factura
 * emitida ANTES de cobrar en la cuenta.
 *
 *   1. Cobro a crédito de cliente ⇒ crédito, como siempre
 *      (`creditPaymentMeans`: forma "2", medio "1", vencimiento).
 *   2. Emitida antes de cobrar ⇒ contado con medio "1 – Instrumento no
 *      definido": cuando la DIAN la recibe nadie sabe todavía si van a
 *      pagar en efectivo, con datáfono, por link o dividido entre varios.
 *      Declarar "10 – Efectivo" sería afirmar algo que no se sabe. Anexo
 *      técnico (Res. 000012/2021, v1.8), tabla 13.3.4.2 «Medios de Pago»:
 *      el código "1" existe para esto, y las reglas de `cac:PaymentMeans`
 *      (FAN01–FAN05) no restringen el medio con forma de pago contado —
 *      sólo exigen que esté en la tabla (FAN03a), que se informe en las
 *      de contado (FAN03b) y el vencimiento en las de crédito (FAN04).
 *   3. Si no ⇒ contado "10", como se emitió siempre al cobrar.
 *
 * `issuedBeforePayment` sale del SNAPSHOT de la factura, no del estado de
 * la orden: un reintento de la emisión después de que la cuenta se pagó
 * tiene que declarar lo mismo que ya dice el papel que tiene el cliente.
 */
export function invoicePaymentMeans(
  payments: readonly { billingCustomer: { creditTermsDays: number } | null; method?: string | null }[],
  issueDate: string,
  opts: { issuedBeforePayment?: boolean } = {},
): Pick<DianInvoiceInput, "paymentMeansCode" | "paymentMeansId" | "paymentDueDate"> {
  const credit = creditPaymentMeans(payments, issueDate);
  if (credit.paymentMeansId === "2") return credit;
  if (opts.issuedBeforePayment) return { paymentMeansCode: "1" };
  // Cuenta pagada TODA con Bre-B (transferencia inmediata de cuenta a
  // cuenta): medio "47 – Transferencia Débito Bancaria" de la tabla 13.3.4.2
  // «Medios de Pago» del anexo técnico (Res. 000012/2021), el código de
  // transferencia que ya usa este módulo (ver `DianInvoiceInput` en ubl.ts).
  // Con medios mezclados se sigue declarando "10", como siempre: una
  // factura lleva un solo medio. Pendiente de confirmar con el contador si
  // prefiere "45 – Transferencia Crédito Bancaria" (también de la tabla).
  if (payments.length > 0 && payments.every((p) => p.method === "kushki_bre_b")) {
    return { paymentMeansCode: BRE_B_PAYMENT_MEANS_CODE };
  }
  return credit;
}

/** Medio DIAN de una cuenta pagada toda con Bre-B (ver `invoicePaymentMeans`). */
export const BRE_B_PAYMENT_MEANS_CODE = "47";

/**
 * Hora Colombia "HH:mm:ss-05:00" para el XML/CUFE. Para documentos nuevos
 * usar `dianIssueDateTime(at)`, que da la fecha Y la hora del mismo
 * instante; esto queda como atajo compatible (lo importa la rama de notas
 * crédito) y sale del mismo helper.
 */
export function bogotaIssueTime(now: Date): string {
  return dianIssueDateTime(now).time;
}

export type DianDocumentRef = {
  id: string;
  state: string;
  attempts: number;
  /** CUFE del último envío (null si nunca salió). */
  cufe?: string | null;
  /** true si esta llamada lo creó (o adoptó un placeholder). */
  created: boolean;
};

const DOC_SELECT = { id: true, state: true, attempts: true, cufe: true } as const;

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
): Promise<{
  id: string;
  attempts: number;
  /** Estado antes del reclamo. */
  previousState: string;
  /**
   * CUFE de un envío anterior. Si existe, la DIAN pudo haberlo aceptado
   * aunque nosotros no nos hayamos enterado (timeout): la emisión pregunta
   * por él ANTES de mandar uno nuevo con el mismo número (regla 90).
   */
  previousCufe: string | null;
} | null> {
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
  return {
    id: doc.id,
    attempts: doc.attempts,
    previousState: doc.state,
    previousCufe: doc.cufe ?? null,
  };
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
