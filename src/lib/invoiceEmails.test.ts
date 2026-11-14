import { describe, expect, it } from "vitest";
import { invoiceRecipients, MAX_INVOICE_EMAILS, normalizeExtraEmails, sameExtraEmails, storedExtraEmails } from "./invoiceEmails";

describe("varios correos por factura", () => {
  it("normaliza: sin vacíos, en minúsculas, sin repetidos ni el principal", () => {
    expect(normalizeExtraEmails("Main@Empresa.test", [" Conta@Empresa.test ", "", "main@empresa.test", "conta@empresa.test", "gerencia@empresa.test"])).toEqual({
      ok: true,
      emails: ["conta@empresa.test", "gerencia@empresa.test"],
    });
    expect(normalizeExtraEmails("a@e.test", undefined)).toEqual({ ok: true, emails: [] });
  });

  it("uno mal escrito es un error con su posición", () => {
    expect(normalizeExtraEmails("a@e.test", ["b@e.test", "mal"])).toEqual({ ok: false, error: "invalid_email", index: 1 });
  });

  it(`máximo ${MAX_INVOICE_EMAILS} en total contando el principal`, () => {
    expect(normalizeExtraEmails("a@e.test", ["b@e.test", "c@e.test", "d@e.test", "e@e.test"])).toMatchObject({ ok: true });
    expect(normalizeExtraEmails("a@e.test", ["b@e.test", "c@e.test", "d@e.test", "e@e.test", "f@e.test"])).toEqual({ ok: false, error: "too_many_emails" });
  });

  it("lo guardado se filtra sin fallar (para el envío)", () => {
    expect(storedExtraEmails("a@e.test", ["mal", "B@e.test", "a@e.test", "c@e.test", "d@e.test", "e@e.test", "f@e.test"])).toEqual(["b@e.test", "c@e.test", "d@e.test", "e@e.test"]);
  });

  it("destinatarios: el principal en to y los demás en copia", () => {
    expect(invoiceRecipients("a@e.test", ["b@e.test", "A@e.test"])).toEqual({ to: "a@e.test", cc: ["b@e.test"] });
  });

  it("compara conjuntos sin importar orden ni mayúsculas", () => {
    expect(sameExtraEmails(["B@e.test", "c@e.test"], ["c@e.test", "b@e.test"])).toBe(true);
    expect(sameExtraEmails(["b@e.test"], [])).toBe(false);
  });
});
