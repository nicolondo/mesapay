/**
 * "Imprimir" desde un botón del STAFF: primero el AGENTE (ESC/POS, como
 * las comandas), y el navegador sólo como respaldo.
 *
 * El dueño: "quisiera que la impresión de facturas se haga como se hacen
 * las de las comandas en vez de con el driver de Windows que se usa
 * actualmente". El driver de Windows pagina la factura al largo del papel
 * que tenga configurado y corta al final de cada página: una cuenta larga
 * salía en dos tiras. Por el agente sale en una, con un solo corte.
 *
 * Qué hace, para la factura y para la precuenta por igual:
 *
 *   1. POST a la ruta de siempre (`reprint-invoice` / `prebill`), que
 *      encola en la impresora de facturas del comercio —la elegida en
 *      Configuración o las de tipo factura— si su agente responde.
 *   2. Encolada ⇒ `{ via: "agent", printerName }` ("Enviada a Caja").
 *   3. Sin impresora (`no_printer`) o con el agente caído
 *      (`agent_offline`) ⇒ imprime la vista HTML en un iframe oculto
 *      (`printInBrowserOrOpenTab`), que ahora pide una sola página del
 *      alto del documento (`fitPageToContent`), y devuelve cómo le fue.
 *   4. Cualquier otra respuesta ⇒ `{ via: "error" }`: no se imprime nada
 *      por el navegador a ciegas (una cuenta cerrada, una sesión vencida).
 *
 * Y el COMENSAL: nunca pasa por acá. Su pantalla sólo abre la vista para
 * imprimir en su propio dispositivo, y las dos rutas exigen sesión de
 * staff (sin ella dan 401/403), así que desde un celular de la mesa no se
 * puede disparar papel en la caja.
 *
 * Sin DOM ni `fetch` directos: entran por `deps`, para probar el flujo
 * entero en vitest (entorno node).
 */

import {
  printInBrowserOrOpenTab,
  type BrowserPrintOutcome,
  type PrintInBrowserOrTabOptions,
} from "@/lib/printInBrowser";

/**
 * Quién imprime por el agente: el staff que cobra (roles de operador y el
 * mesero). Es la MISMA lista que acepta `reprint-invoice`; la precuenta
 * usa `requireOperatorScope`, que es este mismo conjunto.
 */
export const STAFF_PRINT_ROLES: readonly string[] = [
  "operator",
  "platform_admin",
  "group_admin",
  "mesero",
];

/**
 * Lo que una pantalla necesita saber para mostrar el botón del staff: si
 * quien mira puede entrar a Configuración → Impresoras de red (el mesero
 * no: a él se le dice a quién pedírselo). `null` = no es staff (el
 * comensal): su pantalla abre la vista de la factura como siempre.
 */
export type StaffPrintAccess = { canConfigurePrinters: boolean };

export function staffPrintAccessFor(
  role: string | null | undefined,
): StaffPrintAccess | null {
  if (!role || !STAFF_PRINT_ROLES.includes(role)) return null;
  return { canConfigurePrinters: role !== "mesero" };
}

/** Qué documento se imprime. */
export type StaffPrintDoc = {
  kind: "invoice" | "prebill";
  orderId: string;
  /**
   * La vista HTML que imprime el navegador si no hay agente, como RUTA de
   * este mismo origen (el iframe oculto no imprime otro origen):
   * `/factura/[id]` (ver `invoicePrintHref`), o la precuenta —
   * `/operator/orders/[id]/precuenta` en el panel, `/mesero/precuenta/[id]`
   * en la PWA del mesero.
   */
  href: string;
};

/**
 * La ruta de la factura imprimible a partir de su id o de su URL pública
 * (`invoiceUrlFor` la arma con el dominio principal, y el staff puede
 * estar en el subdominio del comercio: se usa sólo la ruta).
 */
export function invoicePrintHref(ref: { invoiceId: string } | { invoiceUrl: string }): string {
  if ("invoiceId" in ref) return `/factura/${ref.invoiceId}`;
  const m = /\/factura\/([^/?#]+)/.exec(ref.invoiceUrl);
  return m ? `/factura/${m[1]}` : ref.invoiceUrl;
}

/** Por qué se cayó al navegador. */
export type StaffPrintFallbackReason = "no_printer" | "agent_offline";

export type StaffPrintResult =
  | {
      via: "agent";
      /** "Caja" (o "Caja · Barra" si salió por dos). Puede venir vacío. */
      printerName: string;
      /** Factura: qué salió — la electrónica aceptada o el comprobante. */
      document?: "factura_electronica" | "comprobante";
      /** Factura con `einvoicing` y la DIAN todavía sin aceptarla. */
      dianPending?: boolean;
    }
  | {
      via: "browser";
      reason: StaffPrintFallbackReason;
      outcome: BrowserPrintOutcome;
      /** La pestaña de respaldo (`?print=1`), para el link "abrir a mano". */
      tabUrl: string;
    }
  | { via: "error"; code: string | null };

export type StaffPrintDeps = {
  fetch?: (url: string, init: { method: "POST" }) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
  printInBrowser?: (
    url: string,
    options: PrintInBrowserOrTabOptions,
  ) => Promise<BrowserPrintOutcome>;
  /** Abre la pestaña de respaldo (en la PWA del mesero, navega in-app). */
  openTab?: (url: string) => boolean;
  /**
   * Se llama apenas se sabe que va por el navegador, ANTES de que el
   * iframe cargue: para mostrar "sin impresora… preparando impresión".
   */
  onBrowserFallback?: (reason: StaffPrintFallbackReason) => void;
};

/** La ruta que encola en el agente. */
export function staffPrintEndpoint(doc: StaffPrintDoc): string {
  return doc.kind === "invoice"
    ? `/api/operator/orders/${doc.orderId}/reprint-invoice`
    : `/api/operator/orders/${doc.orderId}/prebill`;
}

/** La vista HTML que imprime el navegador cuando no hay agente. */
export function browserPrintUrl(doc: StaffPrintDoc): string {
  return doc.href;
}

type RouteBody = {
  queued?: boolean;
  reason?: string;
  error?: string;
  printerName?: string;
  document?: "factura_electronica" | "comprobante";
  dianPending?: boolean;
};

export async function printAsStaff(
  doc: StaffPrintDoc,
  deps: StaffPrintDeps = {},
): Promise<StaffPrintResult> {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  let body: RouteBody | null = null;
  let ok = false;
  try {
    const res = await doFetch(staffPrintEndpoint(doc), { method: "POST" });
    ok = res.ok;
    body = ((await res.json().catch(() => null)) as RouteBody | null) ?? null;
  } catch {
    return { via: "error", code: null };
  }
  if (!ok || !body) return { via: "error", code: body?.error ?? null };

  if (body.queued) {
    return {
      via: "agent",
      printerName: body.printerName ?? "",
      ...(body.document && { document: body.document }),
      ...(body.dianPending && { dianPending: true }),
    };
  }

  const reason: StaffPrintFallbackReason | null =
    body.reason === "no_printer" || body.reason === "agent_offline"
      ? body.reason
      : null;
  if (!reason) return { via: "error", code: body.reason ?? null };

  deps.onBrowserFallback?.(reason);
  const href = browserPrintUrl(doc);
  // `?print=1` sólo para la pestaña de respaldo: en el iframe imprime el
  // helper y la página no se auto-imprime (isEmbeddedFrame).
  const tabUrl = `${href}?print=1`;
  const print = deps.printInBrowser ?? printInBrowserOrOpenTab;
  const outcome = await print(href, {
    tabUrl,
    ...(deps.openTab && { openTab: deps.openTab }),
  });
  return { via: "browser", reason, outcome, tabUrl };
}

/**
 * Qué decirle al que apretó el botón cuando salió por el agente: la clave
 * del namespace `staffPrint` y sus valores. Con la DIAN todavía sin
 * aceptar la factura electrónica, un aviso que se queda (salió el
 * comprobante: que nadie lo entregue como la electrónica).
 */
export function agentMessage(result: Extract<StaffPrintResult, { via: "agent" }>): {
  tone: "ok" | "warn";
  key: "sent" | "sentTo" | "sentToEinvoice" | "sentDianPending";
  values?: { printer: string };
} {
  const printer = result.printerName;
  if (result.dianPending) {
    return { tone: "warn", key: "sentDianPending", values: { printer } };
  }
  if (!printer) return { tone: "ok", key: "sent" };
  return {
    tone: "ok",
    key: result.document === "factura_electronica" ? "sentToEinvoice" : "sentTo",
    values: { printer },
  };
}
