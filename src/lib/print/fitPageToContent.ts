/**
 * UNA SOLA PÁGINA del alto exacto del documento al imprimir desde el
 * navegador en una térmica.
 *
 * El problema (la foto del dueño): una factura larga impresa desde el
 * navegador salió en DOS tiras. El driver de Windows de la térmica tiene
 * un "papel" de largo fijo (80 × 297 mm, por ejemplo); Chrome pagina el
 * documento a ese largo y el driver corta al final de CADA página. Todo lo
 * que pase de 297 mm es una segunda tira.
 *
 * La salida: justo antes de `print()`, medir el alto real del documento
 * imprimible y declarar `@page { size: <ancho>mm <alto>mm; margin: 0 }`.
 * Chrome usa ese tamaño como papel: una página, un corte. El ancho es el
 * del papel del comercio (`Restaurant.printPaperWidthMm`, 80 o 58), que la
 * página declara en `data-print-width-mm` junto al `data-print-document`.
 *
 * Además AÍSLA el documento para la impresión: esconde todo lo que no
 * está en su camino desde <body> (el menú del panel, la barra del mesero,
 * un aviso flotante) y le quita márgenes y rellenos a sus ancestros. Sin
 * eso, el `padding-bottom` de la PWA del mesero o el encabezado del panel
 * sumarían alto que la medición no ve, y el resto caería en una segunda
 * página: justo lo que se quiere evitar.
 *
 * LIMITACIÓN (documentada también en el PR): si un driver ignora el
 * tamaño de papel personalizado, sigue paginando a su largo fijo. El plan
 * B está en el driver: elegir el papel más largo que ofrezca (p. ej.
 * "80 × 3276 mm") y "cortar al final del documento" en vez de "por
 * página". Y lo de fondo es no depender del driver: imprimir por el
 * AGENTE, como las comandas (ver `staffPrint.ts`).
 *
 * La parte pura (px → mm, margen, tope) está separada para testearla sin
 * DOM; `fitPageToContent` es la que toca el documento.
 */

/** Chrome imprime a 96 px CSS por pulgada: 25,4 mm. */
export const CSS_PX_PER_MM = 96 / 25.4;

/**
 * Aire al pie de la página, en mm. Absorbe el redondeo entre la medición
 * (px con decimales) y el motor de impresión —si la página quedara medio
 * punto más corta que el contenido, el último renglón saltaría a una
 * segunda página y habría DOS cortes— y deja un margen para arrancar la
 * tirilla sin comerse el pie.
 */
export const FIT_PAGE_BOTTOM_MARGIN_MM = 4;

/**
 * Tope del alto de página, en mm: 3 metros. Una factura de 150 platos
 * mide ~1,5 m; el tope sólo existe para que un documento absurdo (o una
 * medición rota) no le pida al driver una página infinita. Los drivers
 * térmicos suelen aceptar hasta ~3276 mm; por encima, el documento se
 * pagina como antes (dos tiras), que es mejor que no imprimir.
 */
export const FIT_PAGE_MAX_MM = 3000;

/** Ancho de papel por defecto si la página no lo declara. */
export const DEFAULT_PAPER_WIDTH_MM = 80;

/** Atributo con el que la página declara el ancho de su papel, en mm. */
export const PRINT_WIDTH_ATTR = "data-print-width-mm";

/** Id del <style> que se inyecta (uno solo: cada ajuste lo reescribe). */
export const FIT_STYLE_ID = "mesapay-fit-page";

/** Marca de los elementos aislados para la impresión. */
const FIT_ATTR = "data-print-fit";

/**
 * Alto de página en mm (entero, hacia arriba) para `contentPx` px CSS de
 * contenido, con el margen al pie y acotado al tope. `null` si la
 * medición no sirve (0, negativa, NaN): ahí no se toca nada.
 */
export function pageHeightMm(
  contentPx: number,
  opts: { bottomMarginMm?: number; maxMm?: number } = {},
): number | null {
  if (!Number.isFinite(contentPx) || contentPx <= 0) return null;
  const margin = opts.bottomMarginMm ?? FIT_PAGE_BOTTOM_MARGIN_MM;
  const max = opts.maxMm ?? FIT_PAGE_MAX_MM;
  return Math.min(max, Math.ceil(contentPx / CSS_PX_PER_MM + margin));
}

/**
 * El ancho declarado por la página: 58 u 80 (o lo que tenga el comercio,
 * dentro de lo razonable para una térmica); cualquier otra cosa, 80.
 */
export function paperWidthMmFrom(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 40 || n > 120) return DEFAULT_PAPER_WIDTH_MM;
  return Math.round(n);
}

/**
 * La hoja de estilo que se inyecta: el tamaño de página y el aislamiento
 * del documento (ver el encabezado).
 */
export function fitPageCss(widthMm: number, heightMm: number): string {
  return [
    `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`,
    "@media print {",
    "  html, body { margin: 0 !important; padding: 0 !important; height: auto !important; min-height: 0 !important; background: #fff !important; }",
    `  [${FIT_ATTR}="off"] { display: none !important; }`,
    `  [${FIT_ATTR}="path"] { display: block !important; position: static !important; margin: 0 !important; padding: 0 !important; border: 0 !important; width: auto !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; transform: none !important; box-shadow: none !important; background: #fff !important; }`,
    `  [${FIT_ATTR}="doc"] { margin: 0 !important; box-shadow: none !important; }`,
    "}",
  ].join("\n");
}

/** Etiquetas que no se pintan: no hace falta esconderlas. */
const NON_RENDERED = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE"]);

/**
 * Mide el documento imprimible (`[data-print-document]`) y deja lista la
 * página a su medida. Devuelve el tamaño aplicado, o `null` si no había
 * documento o no se pudo medir (entonces no toca nada y el navegador
 * imprime como siempre). No lanza: imprimir sin ajustar es mejor que no
 * imprimir.
 *
 * La medición se hace con los estilos de PANTALLA: por eso las páginas
 * imprimibles usan el mismo ancho y el mismo relleno en pantalla que en
 * papel (lo que cambia al imprimir es sólo decorado: sombra, fondo).
 */
export function fitPageToContent(
  doc: Document = document,
  selector = "[data-print-document]",
): { widthMm: number; heightMm: number } | null {
  try {
    const el = doc.querySelector<HTMLElement>(selector);
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    const widthMm = paperWidthMmFrom(el.getAttribute(PRINT_WIDTH_ATTR));
    const heightMm = pageHeightMm(el.getBoundingClientRect().height);
    if (heightMm === null) return null;

    // Aislar: limpiar las marcas de un ajuste anterior y marcar de nuevo.
    for (const old of Array.from(doc.querySelectorAll(`[${FIT_ATTR}]`))) {
      old.removeAttribute(FIT_ATTR);
    }
    el.setAttribute(FIT_ATTR, "doc");
    let node: HTMLElement = el;
    while (node.parentElement) {
      const parent: HTMLElement = node.parentElement;
      for (const sib of Array.from(parent.children)) {
        if (sib === node || NON_RENDERED.has(sib.tagName)) continue;
        sib.setAttribute(FIT_ATTR, "off");
      }
      if (parent.tagName !== "HTML" && parent.tagName !== "BODY") {
        parent.setAttribute(FIT_ATTR, "path");
      }
      node = parent;
    }

    let style = doc.getElementById(FIT_STYLE_ID);
    if (!style) {
      style = doc.createElement("style");
      style.id = FIT_STYLE_ID;
    }
    style.textContent = fitPageCss(widthMm, heightMm);
    // Al FINAL del documento: entre reglas @page iguales gana la última, y
    // las páginas imprimibles traen su <style> inline dentro del <body>.
    (doc.body ?? doc.head ?? doc.documentElement).appendChild(style);
    return { widthMm, heightMm };
  } catch {
    return null;
  }
}
