import { afterEach, describe, expect, it, vi } from "vitest";
import es from "../../../../messages/es.json";
import en from "../../../../messages/en.json";
import pt from "../../../../messages/pt.json";
import { addIngredientBarcode, barcodeChangeErrorKey, barcodeTakenOwner, moveIngredientBarcode, replaceIngredientBarcode } from "./barcodeApi";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const registry = (id: string, ...codes: string[]) => ({ id, barcode: codes[0] ?? null, barcodes: codes.map((barcode) => ({ barcode })) });

describe("dueño de un código ocupado", () => {
  it("lee el dueño del 409 y descarta respuestas sin id o sin nombre", () => {
    expect(barcodeTakenOwner({ error: "barcode_taken", owner: { id: "x", name: "Vino", active: false } })).toEqual({ id: "x", name: "Vino", active: false });
    expect(barcodeTakenOwner({ owner: { id: "x", name: "Vino" } })).toEqual({ id: "x", name: "Vino", active: true });
    for (const body of [null, {}, { owner: null }, { owner: { name: "Vino" } }, { owner: { id: "x", name: "" } }, { owner: { id: 7, name: "Vino" } }]) {
      expect(barcodeTakenOwner(body)).toBeNull();
    }
  });

  it("agregar un código ocupado devuelve el dueño para ofrecer «Pasárselo a este insumo»", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "barcode_taken", owner: { id: "old", name: "Vino viejo", active: false } }, 409)));
    expect(await addIngredientBarcode("new", "7804436720807")).toEqual({
      ok: false, errorKey: "barcodeAddTakenByArchived", errorValues: { name: "Vino viejo" }, owner: { id: "old", name: "Vino viejo", active: false },
    });
  });

  it("sin dueño en la respuesta queda el mensaje genérico, sin acción", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "barcode_taken", owner: null }, 409)));
    expect(await addIngredientBarcode("new", "123")).toEqual({ ok: false, errorKey: "barcodeAddTaken" });
  });
});

describe("editar el valor de un código", () => {
  it("normaliza el valor nuevo y manda un PATCH con el código actual", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ingredient: registry("a", "7702") }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await replaceIngredientBarcode("a", "7701", " 77 02\r\n")).toEqual({ ok: true, ingredient: registry("a", "7702") });
    expect(fetchMock).toHaveBeenCalledWith("/api/operator/ingredients/a/barcode", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ barcode: "7701", newBarcode: "7702" }) }));
  });

  it("un valor vacío no llega a la API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await replaceIngredientBarcode("a", "7701", " \t")).toEqual({ ok: false, errorKey: "barcodeAddInvalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("traduce los errores y sobrevive a una caída de red o a una respuesta de otro insumo", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: "barcode_taken", owner: { id: "b", name: "Arroz", active: true } }, 409))
      .mockResolvedValueOnce(json({ error: "barcode_not_found" }, 404))
      .mockResolvedValueOnce(json({ ingredient: registry("otro", "1") }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await replaceIngredientBarcode("a", "1", "2")).toEqual({ ok: false, errorKey: "barcodeAddTakenBy", errorValues: { name: "Arroz" }, owner: { id: "b", name: "Arroz", active: true } });
    expect(await replaceIngredientBarcode("a", "1", "2")).toEqual({ ok: false, errorKey: "barcodeRemoveMissing" });
    expect(await replaceIngredientBarcode("a", "1", "2")).toEqual({ ok: false, errorKey: "barcodeEditFailed" });
    expect(await replaceIngredientBarcode("a", "1", "2")).toEqual({ ok: false, errorKey: "barcodeEditFailed" });
  });
});

describe("pasar un código a otro insumo", () => {
  it("manda el PATCH al dueño actual y devuelve los dos registros", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ingredient: registry("old"), target: registry("new", "7804436720807") }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await moveIngredientBarcode("old", "7804436720807", "new")).toEqual({ ok: true, ingredient: registry("old"), target: registry("new", "7804436720807") });
    expect(fetchMock).toHaveBeenCalledWith("/api/operator/ingredients/old/barcode", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ barcode: "7804436720807", moveTo: "new" }) }));
  });

  it("no acepta una respuesta que no traiga exactamente origen y destino", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ingredient: registry("old") }))
      .mockResolvedValueOnce(json({ ingredient: registry("old"), target: registry("otro", "1") }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await moveIngredientBarcode("old", "1", "new")).toEqual({ ok: false, errorKey: "barcodeMoveFailed" });
    expect(await moveIngredientBarcode("old", "1", "new")).toEqual({ ok: false, errorKey: "barcodeMoveFailed" });
  });

  it.each([
    ["target_not_found", "barcodeMoveTargetMissing"],
    ["ingredient_inactive", "barcodeMoveTargetInactive"],
    ["ingredient_not_tracked", "barcodeMoveTargetNotTracked"],
    ["barcode_not_found", "barcodeMoveMissing"],
    ["operation_conflict", "barcodeAddConflict"],
    ["module_disabled", "barcodeAddUnavailable"],
    ["weird", "barcodeMoveFailed"],
  ])("%s → %s", async (code, key) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: code }, 409)));
    expect(await moveIngredientBarcode("old", "1", "new")).toEqual({ ok: false, errorKey: key });
    expect(barcodeChangeErrorKey(code, "move")).toBe(key);
  });
});

describe("textos del conteo y de los códigos en los tres idiomas", () => {
  const keys = [
    "barcodeEditFailed", "barcodeMoveFailed", "barcodeMoveMissing", "barcodeMoveTargetMissing", "barcodeMoveTargetInactive", "barcodeMoveTargetNotTracked",
    "barcodeTakenByOffer", "barcodeTakenByArchivedOffer", "barcodeTakeHere", "barcodeTakeConfirm", "barcodeTaken", "barcodeEdit", "barcodeEditNamed",
    "barcodeEditLabel", "barcodeEdited", "barcodeMove", "barcodeMoveNamed", "barcodeMovePick", "barcodeMoveSearch", "barcodeMoveEmpty", "barcodeMoveConfirm", "barcodeMoved",
    "countStateInvalid", "countPartsChip", "countPartsToggle", "countPartsGroup", "countFirstShort", "countExpectedShort", "countAddPartNamed", "countAddPartTitle",
    "countErrNotEditable", "countRestoreFailed", "countAppendNotTracked", "countRestoredNotTracked", "countRestoredNext", "countAppendedOutsideScope", "countAppended",
    "countRestoredAppended", "countGoToExisting", "countScanAppend", "countScanRestore", "countNewIngredientShort", "countSearchPlaceholder", "countHintToggle",
    "countColItem", "countColQty", "countColTotal", "countColFirst", "countColExpected", "countColDiff", "countCompactHint", "countCreateNamed", "countRecentGroup",
    "countRestGroup", "countAllGroup", "countScanMove", "countScanLink", "countPickLinkIntro", "countPickMoveIntro", "countPickSearch", "countScanLooking", "countLinked",
    "countLinkUndo", "countLinkFix", "countScanUnknown", "countScanFree", "countScanCreate", "countNoCategory", "countScanArchived", "countScanNotTracked",
    "countScanCategoryExcluded", "countScanOutsideScope", "countScanAddedLater", "countNewIngredientIntro", "countNewIngredientOutsideScope",
    "ingredientNameTakenBy", "ingredientNameTakenByArchived", "ingredientCodeTakenBy", "ingredientCodeTakenByArchived", "draftSaved", "scanBarcodePlaceholder",
  ];
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]).sort().join(",");

  it("existen y conservan los mismos {valores}", () => {
    const base = es.opErp as Record<string, string>;
    for (const key of keys) {
      expect(base[key], `es.${key}`).toBeTruthy();
      for (const [locale, catalog] of [["en", en], ["pt", pt]] as const) {
        const text = (catalog.opErp as Record<string, string>)[key];
        expect(text, `${locale}.${key}`).toBeTruthy();
        expect(placeholders(text), `${locale}.${key}`).toBe(placeholders(base[key]));
      }
    }
  });

  it("el español del conteo va de «tú», sin voseo", () => {
    const base = es.opErp as Record<string, string>;
    for (const key of keys) expect(base[key], key).not.toMatch(/\b(escaneá|buscá|tocá|escribí|elegí|revisá|podés|tenés|querés|agregá|contá|pulsá)\b/i);
  });
});
