// Nunca más un error mudo al confirmar una factura leída con IA: cada código
// del servidor tiene su mensaje, y lo no mapeado muestra el código crudo.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API_CONFIRM_ERROR_KEYS, confirmErrorMessage } from "./confirmErrorKeys";

describe("confirmErrorMessage", () => {
  it("maps every known server code to its specific message key", () => {
    expect(confirmErrorMessage("totals_unconfirmed", 409)).toEqual({ key: "invRecAckRequired" });
    expect(confirmErrorMessage("ingredient_archived", 400)).toEqual({ key: "invReviewErrIngredientArchived" });
    expect(confirmErrorMessage("ingredient_name_taken", 400)).toEqual({ key: "invReviewErrIngredientNameTaken" });
    expect(confirmErrorMessage("supplier_archived", 400)).toEqual({ key: "invReviewErrSupplierArchived" });
    // El choque de concurrencia que secureApi responde ante un error inesperado
    // de base de datos (fue el síntoma del bug: antes caía al genérico mudo).
    expect(confirmErrorMessage("operation_conflict", 409)).toEqual({ key: "errConcurrentConflict" });
  });

  it("shows the raw server code when it is not mapped, never a mute generic", () => {
    expect(confirmErrorMessage("internal_error", 500)).toEqual({ key: "errSaveFailedCode", code: "internal_error" });
    expect(confirmErrorMessage("something_new", 400)).toEqual({ key: "errSaveFailedCode", code: "something_new" });
  });

  it("falls back to the HTTP status when the body has no error code", () => {
    expect(confirmErrorMessage(undefined, 502)).toEqual({ key: "errSaveFailedCode", code: "HTTP 502" });
    expect(confirmErrorMessage("", 413)).toEqual({ key: "errSaveFailedCode", code: "HTTP 413" });
  });

  it("has every mapped key (and the fallback) in the three catalogs", () => {
    const keys = [...new Set(Object.values(API_CONFIRM_ERROR_KEYS)), "errSaveFailedCode"];
    for (const locale of ["es", "en", "pt"]) {
      const catalog = JSON.parse(
        readFileSync(path.join(__dirname, `../../../../messages/${locale}.json`), "utf8"),
      ) as { opErp: Record<string, string> };
      for (const key of keys) {
        expect(catalog.opErp[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
