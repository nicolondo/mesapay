import { afterEach, describe, expect, it, vi } from "vitest";
import es from "../../../../messages/es.json";
import en from "../../../../messages/en.json";
import pt from "../../../../messages/pt.json";
import { addIngredientBarcode, barcodeErrorKey, barcodeTakenError, parseBarcodeResponse, removeIngredientBarcode } from "./barcodeApi";

afterEach(() => vi.unstubAllGlobals());

describe("errores de códigos de barras", () => {
  it.each([
    ["barcode_taken", "add", "barcodeAddTaken"],
    ["ingredient_inactive", "add", "barcodeAddInactive"],
    ["operation_conflict", "remove", "barcodeAddConflict"],
    ["barcode_not_found", "remove", "barcodeRemoveMissing"],
    ["invalid", "remove", "barcodeRemoveFailed"],
    ["weird", "add", "barcodeAddFailed"],
    [undefined, "remove", "barcodeRemoveFailed"],
  ] as const)("%s (%s) → %s", (code, mode, key) => {
    expect(barcodeErrorKey(code, mode)).toBe(key);
  });

  it("todas las claves existen en los tres idiomas", () => {
    const keys = ["barcodeAddTaken", "barcodeAddInvalid", "barcodeAddInactive", "barcodeAddNotTracked", "barcodeAddUnavailable", "barcodeAddConflict", "barcodeAddFailed", "barcodeRemoveFailed", "barcodeRemoveMissing"];
    for (const catalog of [es, en, pt]) {
      for (const key of keys) expect((catalog.opErp as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});

describe("respuesta de la API", () => {
  it("acepta solo el registro del mismo insumo", () => {
    const ingredient = { id: "a", barcode: "1", barcodes: [{ barcode: "1" }] };
    expect(parseBarcodeResponse("a", { ingredient })).toEqual(ingredient);
    expect(parseBarcodeResponse("b", { ingredient })).toBeNull();
    expect(parseBarcodeResponse("a", { ingredient: { id: "a" } })).toBeNull();
    expect(parseBarcodeResponse("a", null)).toBeNull();
  });

  it("normaliza antes de agregar y no llama a la API con un código vacío", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ingredient: { id: "a", barcode: "77", barcodes: [{ barcode: "77" }] } })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await addIngredientBarcode("a", " \t")).toEqual({ ok: false, errorKey: "barcodeAddInvalid" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await addIngredientBarcode("a", " 7 7\r\n")).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/operator/ingredients/a/barcode", expect.objectContaining({ method: "POST", body: JSON.stringify({ barcode: "77" }) }));
  });

  it("quita con DELETE y traduce los errores; una caída de red no rompe", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "barcode_not_found" }), { status: 404 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await removeIngredientBarcode("a", "77")).toEqual({ ok: false, errorKey: "barcodeRemoveMissing" });
    expect(fetchMock).toHaveBeenCalledWith("/api/operator/ingredients/a/barcode", expect.objectContaining({ method: "DELETE" }));
    expect(await removeIngredientBarcode("a", "77")).toEqual({ ok: false, errorKey: "barcodeRemoveFailed" });
  });
});

describe("barcodeTakenError: el aviso dice de quién es el código", () => {
  it("con el dueño activo nombra el producto", () => {
    expect(barcodeTakenError({ error: "barcode_taken", owner: { id: "i1", name: "Vino blanco", active: true } }))
      .toEqual({ errorKey: "barcodeAddTakenBy", errorValues: { name: "Vino blanco" } });
  });

  it("con el dueño archivado lo dice", () => {
    expect(barcodeTakenError({ error: "barcode_taken", owner: { id: "i1", name: "Vino blanco", active: false } }))
      .toEqual({ errorKey: "barcodeAddTakenByArchived", errorValues: { name: "Vino blanco" } });
  });

  it("sin dueño (respuesta vieja o el código se liberó entre tanto) usa el aviso genérico", () => {
    expect(barcodeTakenError({ error: "barcode_taken" })).toEqual({ errorKey: "barcodeAddTaken" });
    expect(barcodeTakenError({ error: "barcode_taken", owner: null })).toEqual({ errorKey: "barcodeAddTaken" });
    expect(barcodeTakenError(null)).toEqual({ errorKey: "barcodeAddTaken" });
  });
});
