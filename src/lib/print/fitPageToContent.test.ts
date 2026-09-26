import { describe, expect, it } from "vitest";
import {
  CSS_PX_PER_MM,
  DEFAULT_PAPER_WIDTH_MM,
  FIT_PAGE_BOTTOM_MARGIN_MM,
  FIT_PAGE_MAX_MM,
  FIT_STYLE_ID,
  fitPageCss,
  fitPageToContent,
  pageHeightMm,
  paperWidthMmFrom,
} from "./fitPageToContent";

/**
 * Una sola página del alto del documento al imprimir desde el navegador.
 * La lógica pura (px → mm, margen, tope) se prueba sola; el paso por el
 * DOM, con un documento de mentira (vitest corre en node, sin jsdom).
 */

describe("pageHeightMm — px CSS a mm de papel", () => {
  it("96 px CSS son 25,4 mm (una pulgada)", () => {
    expect(96 / CSS_PX_PER_MM).toBeCloseTo(25.4, 10);
  });

  it("suma el margen al pie y redondea hacia ARRIBA (nunca una página más corta que el contenido)", () => {
    // 1000 px = 264,58 mm → + 4 mm = 268,58 → 269.
    expect(pageHeightMm(1000)).toBe(269);
    expect(FIT_PAGE_BOTTOM_MARGIN_MM).toBe(4);
    // Justo una pulgada: 25,4 + 4 = 29,4 → 30.
    expect(pageHeightMm(96)).toBe(30);
  });

  it("el margen se puede cambiar", () => {
    expect(pageHeightMm(96, { bottomMarginMm: 0 })).toBe(26);
  });

  it("topa en 3000 mm: un documento absurdo no pide una página infinita", () => {
    expect(FIT_PAGE_MAX_MM).toBe(3000);
    expect(pageHeightMm(1_000_000)).toBe(3000);
    expect(pageHeightMm(1_000_000, { maxMm: 500 })).toBe(500);
  });

  it("una medición que no sirve (0, negativa, NaN, infinita) ⇒ null: no se toca nada", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pageHeightMm(bad)).toBeNull();
    }
  });

  it("una factura de ~40 platos (unos 2.600 px en pantalla) cabe en UNA página de menos de un metro", () => {
    const mm = pageHeightMm(2600)!;
    expect(mm).toBeGreaterThan(297); // más larga que el papel del driver: por eso salía en dos tiras
    expect(mm).toBeLessThan(1000);
  });
});

describe("paperWidthMmFrom — el ancho que declara la página", () => {
  it("58 y 80 pasan tal cual", () => {
    expect(paperWidthMmFrom("58")).toBe(58);
    expect(paperWidthMmFrom("80")).toBe(80);
  });

  it("vacío, basura o fuera de rango ⇒ 80", () => {
    for (const raw of [null, undefined, "", "abc", "10", "500"]) {
      expect(paperWidthMmFrom(raw)).toBe(DEFAULT_PAPER_WIDTH_MM);
    }
  });
});

describe("fitPageCss", () => {
  it("declara el papel del alto exacto, sin márgenes", () => {
    const css = fitPageCss(80, 812);
    expect(css).toContain("@page { size: 80mm 812mm; margin: 0; }");
  });

  it("al imprimir esconde lo que no es el documento y aplana sus ancestros", () => {
    const css = fitPageCss(58, 300);
    expect(css).toContain('[data-print-fit="off"] { display: none !important; }');
    expect(css).toMatch(/\[data-print-fit="path"\] \{[^}]*padding: 0 !important/);
    expect(css).toMatch(/@media print/);
  });
});

// ── El paso por el DOM, con un documento de mentira ────────────────────

class FakeEl {
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  textContent = "";
  id = "";
  constructor(
    public tagName: string,
    private height = 0,
  ) {}
  append(...kids: FakeEl[]) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  appendChild(k: FakeEl) {
    if (k.parentElement) {
      k.parentElement.children = k.parentElement.children.filter((c) => c !== k);
    }
    this.append(k);
    return k;
  }
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  setAttribute(n: string, v: string) {
    this.attrs[n] = v;
  }
  removeAttribute(n: string) {
    delete this.attrs[n];
  }
  getBoundingClientRect() {
    return { height: this.height };
  }
  *walk(): Generator<FakeEl> {
    yield this;
    for (const c of this.children) yield* c.walk();
  }
}

/** html > [head, body > [header, main > [controls, receipt], nav]]. */
function fakeDoc(receiptHeightPx: number, widthAttr: string | null = "58") {
  const html = new FakeEl("HTML");
  const head = new FakeEl("HEAD");
  const body = new FakeEl("BODY");
  const header = new FakeEl("HEADER");
  const main = new FakeEl("MAIN");
  const controls = new FakeEl("DIV");
  const receipt = new FakeEl("ARTICLE", receiptHeightPx);
  receipt.setAttribute("data-print-document", "factura");
  if (widthAttr) receipt.setAttribute("data-print-width-mm", widthAttr);
  const script = new FakeEl("SCRIPT");
  const nav = new FakeEl("NAV");
  html.append(head, body);
  main.append(controls, receipt);
  body.append(header, main, nav, script);
  const all = () => [...html.walk()];
  const doc = {
    head,
    body,
    documentElement: html,
    querySelector: (sel: string) =>
      sel === "[data-print-document]"
        ? (all().find((e) => e.attrs["data-print-document"]) ?? null)
        : null,
    querySelectorAll: (sel: string) =>
      sel === "[data-print-fit]" ? all().filter((e) => "data-print-fit" in e.attrs) : [],
    getElementById: (id: string) => all().find((e) => e.id === id) ?? null,
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
  };
  return { doc: doc as unknown as Document, html, head, body, header, main, controls, receipt, nav, script };
}

describe("fitPageToContent — sobre el documento", () => {
  it("mide el documento, declara la página a su medida y la deja al final del documento", () => {
    const d = fakeDoc(1000);
    expect(fitPageToContent(d.doc)).toEqual({ widthMm: 58, heightMm: 269 });
    const style = d.body.children.at(-1)!;
    expect(style.id).toBe(FIT_STYLE_ID);
    expect(style.textContent).toContain("@page { size: 58mm 269mm; margin: 0; }");
  });

  it("aísla el documento: esconde lo que no está en su camino y marca sus ancestros", () => {
    const d = fakeDoc(1000);
    fitPageToContent(d.doc);
    expect(d.receipt.attrs["data-print-fit"]).toBe("doc");
    expect(d.main.attrs["data-print-fit"]).toBe("path");
    expect(d.controls.attrs["data-print-fit"]).toBe("off");
    expect(d.header.attrs["data-print-fit"]).toBe("off");
    expect(d.nav.attrs["data-print-fit"]).toBe("off");
    // Ni <body>/<html> (tienen su propia regla) ni lo que no se pinta.
    expect(d.body.attrs["data-print-fit"]).toBeUndefined();
    expect(d.html.attrs["data-print-fit"]).toBeUndefined();
    expect(d.script.attrs["data-print-fit"]).toBeUndefined();
    expect(d.head.attrs["data-print-fit"]).toBeUndefined();
  });

  it("volver a ajustar reescribe el mismo <style> (no apila uno por impresión)", () => {
    const d = fakeDoc(1000);
    fitPageToContent(d.doc);
    (d.receipt as unknown as { height: number }).height = 2000;
    fitPageToContent(d.doc);
    const styles = [...d.html.walk()].filter((e) => e.id === FIT_STYLE_ID);
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain("58mm 534mm");
  });

  it("sin ancho declarado usa 80 mm", () => {
    const d = fakeDoc(500, null);
    expect(fitPageToContent(d.doc)?.widthMm).toBe(80);
  });

  it("sin documento imprimible, o sin alto, no toca nada", () => {
    const d = fakeDoc(0);
    expect(fitPageToContent(d.doc)).toBeNull();
    expect(d.receipt.attrs["data-print-fit"]).toBeUndefined();
    const empty = { querySelector: () => null } as unknown as Document;
    expect(fitPageToContent(empty)).toBeNull();
  });

  it("nunca lanza: un documento raro devuelve null", () => {
    const weird = {
      querySelector: () => {
        throw new Error("boom");
      },
    } as unknown as Document;
    expect(fitPageToContent(weird)).toBeNull();
  });
});
