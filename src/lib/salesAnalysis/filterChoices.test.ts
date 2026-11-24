import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import es from "../../../messages/es.json";
import en from "../../../messages/en.json";
import type { Tr } from "./dimLabels";
import { categorySelection } from "./categorySelection";
import { parseSalesFilters } from "./filters";
import { buildFilterChoices } from "./filterChoices";
import type { FilterOptions } from "./types";

const category = (label: string, parentLabel: string | null = null) => ({
  id: label, label, parentId: parentLabel, parentLabel,
});
const options: FilterOptions = {
  categories: [
    category("tempranillo", "Vinos"), category("Ñame"), category("Vinos blancos"),
    category("Árabe", "Vinos"), category("nueces"), category("Ácidas"), category("Vinos"),
    category("otro"), category("aceites"),
  ],
  tables: [{ id: "ten", number: 10, label: "Barra" }, { id: "two", number: 2, label: "Terraza" }],
  products: [
    { id: "1", name: "Zanahoria", categoryId: "Ácidas" },
    { id: "2", name: "ají", categoryId: "Otros" },
    { id: "3", name: "Ápionabo", categoryId: "Ácidas" },
  ],
  waiters: [
    { id: "z", name: "Zoé", disabled: false },
    { id: "a", name: "Ángela", disabled: true },
  ],
};
const t = createTranslator({ locale: "es", messages: es.salesAnalysis }) as Tr;

describe("opciones del análisis de ventas", () => {
  it("fija Todos y ordena las categorías en español por padre y luego por hija", () => {
    const result = buildFilterChoices(options, t, "es", false);
    for (const choices of [result.canal, result.pago, result.mesa, result.producto, result.mesero]) {
      expect(choices[0]).toEqual({ value: "", label: t("all") });
    }
    expect(result.categoria.map((c) => c.label)).toEqual([
      "aceites", "Ácidas", "nueces", "Ñame", "otro", "Vinos",
      "Vinos › Árabe", "Vinos › tempranillo", "Vinos blancos",
    ]);
  });

  it("deduplica los ids para la consulta y conserva la selección explícita en el orden del enlace", () => {
    const filters = parseSalesFilters(new URLSearchParams("categoria=child&categoria=other&categoria=parent"));
    const categories = [
      { id: "parent", parentId: null }, { id: "child", parentId: "parent" }, { id: "other", parentId: null },
    ];
    for (const rows of [categories, [...categories].reverse()]) {
      const { explicit, included } = categorySelection(rows, filters.dims.categoria);
      expect(explicit).toEqual(["other", "parent"]);
      expect([...included].sort()).toEqual(["child", "other", "parent"]);
    }
  });

  it("desempata etiquetas equivalentes por id con cualquier orden de entrada", () => {
    const products = [{ id: "a", name: "Ají", categoryId: "p" }, { id: "b", name: "aji", categoryId: "p" }];
    for (const rows of [products, [...products].reverse()]) {
      const categories = rows.map((p) => ({ id: p.id, label: p.name, parentId: "p", parentLabel: "Verduras" }));
      const result = buildFilterChoices({ ...options, categories, products: rows }, t, "es", false);
      expect(result.categoria.map((c) => c.value)).toEqual(["a", "b"]);
      expect(result.producto.map((p) => p.value)).toEqual(["", "a", "b"]);
    }
  });

  it("mantiene el número de mesa, los ids y el filtro de productos por categoría", () => {
    const result = buildFilterChoices(options, t, "es", false, ["Ácidas"]);
    expect(result.mesa.map((c) => c.value)).toEqual(["", "two", "ten"]);
    expect(result.producto.map((c) => c.value)).toEqual(["", "3", "1"]);
    expect(result.mesero.slice(1).map((c) => c.label)).toEqual([
      t("disabledWaiter", { name: "Ángela" }), t("noWaiter"), "Zoé",
    ]);
  });

  it("ordena canales y pagos por su etiqueta traducida y considera el modo mostrador", () => {
    const english = createTranslator({ locale: "en", messages: en.salesAnalysis }) as Tr;
    for (const [locale, translate] of [["es", t], ["en", english]] as const) {
      const result = buildFilterChoices(options, translate, locale, true);
      expect(result.canal).toContainEqual({ value: "salon", label: translate("channel.counter") });
      for (const choices of [result.canal, result.pago]) {
        const labels = choices.slice(1).map((c) => c.label);
        expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, locale)));
      }
    }
  });
});
