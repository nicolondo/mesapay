import { createTranslator } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import es from "../../../messages/es.json";
import en from "../../../messages/en.json";
import pt from "../../../messages/pt.json";
import type { Locale } from "@/i18n/config";

// La regla vive en el server; acá solo se usa su lista de motivos.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: vi.fn() }));

import { INGREDIENT_DELETION_REASONS, type IngredientDeletionReason } from "./ingredientDeletion";
import {
  BULK_DELETE_MAX_IDS,
  DELETION_REASON_KEYS,
  deleteIngredient,
  deleteIngredients,
  deletionReasonsText,
  deletionReasonText,
  fetchIngredientDeletionCheck,
  previewIngredientsDeletion,
  skippedIngredientsText,
} from "./ingredientDeletionText";

const catalogs = { es, en, pt } as const;
type Translate = Parameters<typeof deletionReasonText>[0];
const translator = (locale: Locale) =>
  createTranslator({ locale, messages: catalogs[locale], namespace: "opErp" }) as unknown as Translate;

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("«No se puede eliminar: …» en palabras simples", () => {
  const t = translator("es");

  it.each<[IngredientDeletionReason, string]>([
    [{ code: "stock", count: 1 }, "tiene existencias"],
    [{ code: "movements", count: 1 }, "tiene 1 movimiento de inventario"],
    [{ code: "movements", count: 12 }, "tiene 12 movimientos de inventario"],
    [{ code: "purchases", count: 1 }, "aparece en 1 compra"],
    [{ code: "purchases", count: 4 }, "aparece en 4 compras"],
    [{ code: "draftPurchases", count: 1, labels: ["7"] }, "está en la orden de compra en borrador OC-0007"],
    [{ code: "draftPurchases", count: 2, labels: ["7", "12"] }, "está en 2 órdenes de compra en borrador (OC-0007, OC-0012)"],
    [{ code: "production", count: 2 }, "tiene 2 producciones registradas"],
    [{ code: "closedCounts", count: 1 }, "aparece en 1 conteo cerrado"],
    [{ code: "recipes", count: 1, labels: ["Ajiaco"] }, "está en 1 receta (Ajiaco)"],
    [{ code: "recipes", count: 3, labels: ["Ajiaco", "Bandeja", "Hogao"] }, "está en 3 recetas (Ajiaco, Bandeja, Hogao)"],
    [{ code: "recipes", count: 5, labels: ["Ajiaco", "Bandeja", "Hogao"] }, "está en 5 recetas (Ajiaco, Bandeja, Hogao…)"],
    [{ code: "modifierRecipes", count: 1, labels: ["Arepa · Extra queso"] }, "está en 1 opción de modificador (Arepa · Extra queso)"],
    [{ code: "ownRecipe", count: 2 }, "es una sub-receta con 2 ingredientes"],
    [{ code: "priceHistory", count: 3 }, "tiene historial de precios en la lista de un proveedor"],
    [{ code: "busy", count: 1 }, "otra operación lo está usando en este momento"],
  ])("%j → %s", (reason, text) => {
    expect(deletionReasonText(t, "es", reason)).toBe(text);
  });

  it("el conteo en borrador se nombra por su fecha (sin hora), en la zona del comercio", () => {
    // 01:30 UTC del 13 = 20:30 del 12 en Bogotá. El texto exacto del mes
    // depende de la versión de ICU: se compara contra el formateador.
    const text = deletionReasonText(t, "es", { code: "draftCount", count: 1, labels: ["2026-11-13T01:30:00.000Z"] });
    const date = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Bogota" })
      .format(new Date("2026-11-13T01:30:00.000Z"));
    expect(text).toBe(`está en el conteo en borrador del ${date}`);
    expect(date).toMatch(/^12\b.*2026$/);
    expect(text).not.toMatch(/\d:\d/);
  });

  it("une los motivos como una frase", () => {
    const reasons: IngredientDeletionReason[] = [{ code: "recipes", count: 3, labels: ["Ajiaco"] }, { code: "movements", count: 12 }, { code: "stock", count: 1 }];
    expect(t("deleteIngredientBlocked", { name: "Tomate", reasons: deletionReasonsText(t, "es", reasons) }))
      .toBe("No se puede eliminar «Tomate»: está en 3 recetas (Ajiaco…), tiene 12 movimientos de inventario y tiene existencias.");
    expect(deletionReasonsText(t, "es", [{ code: "stock", count: 1 }])).toBe("tiene existencias");
  });

  it("en inglés y portugués dice lo mismo", () => {
    const reasons: IngredientDeletionReason[] = [{ code: "draftPurchases", count: 1, labels: ["7"] }, { code: "movements", count: 2 }];
    expect(deletionReasonsText(translator("en"), "en", reasons)).toBe("it is in draft purchase order PO-0007 and it has 2 stock movements");
    expect(deletionReasonsText(translator("pt"), "pt", reasons)).toBe("está na ordem de compra em rascunho OC-0007 e tem 2 movimentações de estoque");
  });

  it("nombra hasta tres insumos que no se pudieron y cuenta el resto", () => {
    const row = (name: string) => ({ id: name, name, reasons: [{ code: "stock" as const, count: 1 }] });
    expect(skippedIngredientsText(t, "es", [row("Sal"), row("Ajo")])).toBe("«Sal» (tiene existencias); «Ajo» (tiene existencias)");
    expect(skippedIngredientsText(t, "es", ["A", "B", "C", "D", "E"].map(row)))
      .toBe("«A» (tiene existencias); «B» (tiene existencias); «C» (tiene existencias) y 2 más");
    // De cada uno, los dos primeros motivos: el detalle completo está en su ficha.
    expect(skippedIngredientsText(t, "es", [{ id: "x", name: "Aceite", reasons: [
      { code: "stock", count: 1 }, { code: "movements", count: 352 }, { code: "purchases", count: 7 }, { code: "recipes", count: 2, labels: ["Burrata"] },
    ] }])).toBe("«Aceite» (tiene existencias y tiene 352 movimientos de inventario…)");
    expect(t("ingredientsDeletedSkipped", { deleted: 9, skipped: 3, details: "…" })).toBe("9 insumos eliminados, 3 no se pudieron: ….");
    expect(t("ingredientsDeletedSkipped", { deleted: 0, skipped: 1, details: "…" })).toBe("Ningún insumo eliminado, 1 no se pudo: ….");
    expect(t("ingredientsDeletedNotice", { count: 1 })).toBe("Insumo eliminado.");
    expect(t("ingredientsDeletedNotice", { count: 4 })).toBe("4 insumos eliminados.");
  });

  it("la confirmación dice lo que pidió el dueño", () => {
    expect(t("deleteIngredientConfirmBody", { name: "Tomate" })).toBe("Se elimina «Tomate» y sus códigos de barras. No se puede deshacer.");
    expect(t("bulkDeleteBody", { count: 9 })).toBe("Se eliminan 9 insumos y sus códigos de barras. No se puede deshacer.");
    expect(t("bulkDeleteConfirm", { count: 1 })).toBe("Sí, eliminar 1 insumo");
  });

  it("cada motivo de la regla tiene su texto en los tres idiomas", () => {
    expect(Object.keys(DELETION_REASON_KEYS).sort()).toEqual([...INGREDIENT_DELETION_REASONS, "busy"].sort());
    const keys = [
      ...Object.values(DELETION_REASON_KEYS),
      "deleteIngredient", "deleteIngredientNamed", "deleteIngredientTitle", "deleteIngredientChecking", "deleteIngredientConfirmBody",
      "deleteIngredientAlsoRemoves", "deleteRemovesSupplierItems", "deleteRemovesAliases", "deleteIngredientConfirm", "deleteIngredientDeleting",
      "deleteIngredientBlocked", "deleteIngredientBlockedShort", "deleteIngredientArchiveInstead", "deleteIngredientAlreadyArchived",
      "deleteIngredientCheckFailed", "deleteIngredientFailed", "deleteIngredientGone", "deleteIngredientCanDelete", "ingredientDeletedNotice",
      "ingredientsDeletedNotice", "ingredientsDeletedSkipped", "ingredientsDeleteFailedSome", "deleteSkippedItem", "deleteSkippedMore",
      "filterNoMovements", "noMovementsHint", "bulkDelete", "bulkDeleteTitle", "bulkDeleteBody", "bulkDeleteSkipNote", "bulkDeleteNone",
      "bulkDeleteConfirm", "poNumber", "retry", "closeSheet", "cancel", "archiveIngredient",
    ];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const key of keys) expect((catalog.opErp as Record<string, string>)[key], `${locale}.${key}`).toBeTruthy();
      expect((catalog.opAdmin as Record<string, string>).audit_ingredient_delete, locale).toBeTruthy();
      // Ningún motivo revienta al formatearse, con y sin lista.
      const tr = translator(locale as Locale);
      for (const code of [...INGREDIENT_DELETION_REASONS, "busy" as const]) {
        for (const count of [1, 2]) {
          expect(deletionReasonText(tr, locale as Locale, { code, count, labels: ["2026-11-12T19:30:00.000Z"] })).not.toMatch(/[{}]|opErp\./);
        }
      }
    }
  });
});

describe("llamadas a la API", () => {
  it("pregunta si se puede eliminar y valida la respuesta", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ deletable: true, removes: { barcodes: 2, supplierItems: 1 } }))
      .mockResolvedValueOnce(json({ deletable: false, reasons: [{ code: "recipes", count: 2, labels: ["Ajiaco"] }] }))
      .mockResolvedValueOnce(json({ deletable: false, reasons: [{ code: "desconocido", count: 1 }] }))
      .mockResolvedValueOnce(json({ deletable: false, reasons: [] }))
      .mockResolvedValueOnce(json({ error: "not_found" }, 404))
      .mockResolvedValueOnce(json({ error: "module_disabled" }, 403))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchIngredientDeletionCheck("a/b")).toEqual({ ok: true, check: { deletable: true, removes: { barcodes: 2, supplierItems: 1, invoiceAliases: 0 } } });
    expect(fetchMock).toHaveBeenCalledWith("/api/operator/ingredients/a%2Fb/delete", { cache: "no-store" });
    expect(await fetchIngredientDeletionCheck("a")).toEqual({ ok: true, check: { deletable: false, reasons: [{ code: "recipes", count: 2, labels: ["Ajiaco"] }] } });
    // Un «no se puede» sin motivos reconocibles no se muestra como si lo fuera.
    expect(await fetchIngredientDeletionCheck("a")).toEqual({ ok: false, error: "failed" });
    expect(await fetchIngredientDeletionCheck("a")).toEqual({ ok: false, error: "failed" });
    expect(await fetchIngredientDeletionCheck("a")).toEqual({ ok: false, error: "not_found" });
    expect(await fetchIngredientDeletionCheck("a")).toEqual({ ok: false, error: "failed" });
    expect(await fetchIngredientDeletionCheck("a")).toEqual({ ok: false, error: "failed" });
  });

  it("elimina y traduce cada respuesta del server", async () => {
    const reasons = [{ code: "movements", count: 3 }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, deleted: { id: "a", name: "A" } }))
      .mockResolvedValueOnce(json({ error: "not_deletable", reasons }, 409))
      .mockResolvedValueOnce(json({ error: "conflict" }, 409))
      .mockResolvedValueOnce(json({ error: "not_found" }, 404))
      .mockResolvedValueOnce(json({ error: "not_deletable" }, 409))
      .mockResolvedValueOnce(new Response("<html>", { status: 500 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await deleteIngredient("a")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/operator/ingredients/a/delete", { method: "DELETE" });
    expect(await deleteIngredient("a")).toEqual({ ok: false, error: "not_deletable", reasons });
    expect(await deleteIngredient("a")).toEqual({ ok: false, error: "conflict" });
    expect(await deleteIngredient("a")).toEqual({ ok: false, error: "not_found" });
    expect(await deleteIngredient("a")).toEqual({ ok: false, error: "failed" });
    expect(await deleteIngredient("a")).toEqual({ ok: false, error: "failed" });
    expect(await deleteIngredient("a")).toEqual({ ok: false, error: "failed" });
  });

  it("la eliminación masiva va por lotes y un lote caído no frena a los demás", async () => {
    const ids = Array.from({ length: BULK_DELETE_MAX_IDS * 2 + 5 }, (_, i) => `id-${i}`);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ deleted: [{ id: "id-0", name: "Cero" }], skipped: [{ id: "id-1", name: "Uno", reasons: [{ code: "stock", count: 1 }] }], missing: [] }))
      .mockResolvedValueOnce(json({ error: "conflict" }, 409))
      .mockResolvedValueOnce(json({ error: "not_found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const result = await deleteIngredients(ids);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).ids.length)).toEqual([BULK_DELETE_MAX_IDS, BULK_DELETE_MAX_IDS, 5]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("dryRun");
    expect(result.deleted).toEqual([{ id: "id-0", name: "Cero" }]);
    expect(result.skipped).toEqual([{ id: "id-1", name: "Uno", reasons: [{ code: "stock", count: 1 }] }]);
    expect(result.failed).toEqual(ids.slice(BULK_DELETE_MAX_IDS, BULK_DELETE_MAX_IDS * 2));
  });

  it("la vista previa manda dryRun y lee «deletable»; una respuesta rara cuenta como fallo", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ deletable: [{ id: "a", name: "A" }], skipped: [], missing: [] }))
      .mockResolvedValueOnce(json({ deleted: [{ id: "a", name: "A" }], skipped: [] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await previewIngredientsDeletion(["a", "b"])).toEqual({ deletable: [{ id: "a", name: "A" }], skipped: [], failed: [] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ids: ["a", "b"], dryRun: true });
    expect(await previewIngredientsDeletion(["a"])).toEqual({ deletable: [], skipped: [], failed: ["a"] });
  });
});
