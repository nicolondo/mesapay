import { describe, expect, it } from "vitest";
import {
  DOCUMENT_MAX_AGE_DAYS,
  isStaleDocument,
} from "./onboardingDocuments";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe("isStaleDocument", () => {
  it("no vence a los 89 días", () => {
    expect(isStaleDocument(daysAgo(89), NOW, 90)).toBe(false);
  });
  it("no vence exactamente a los 90 días", () => {
    expect(isStaleDocument(daysAgo(90), NOW, 90)).toBe(false);
  });
  it("vence a los 91 días", () => {
    expect(isStaleDocument(daysAgo(91), NOW, 90)).toBe(true);
  });
  it("usa 90 días por defecto", () => {
    expect(isStaleDocument(daysAgo(91), NOW)).toBe(true);
    expect(isStaleDocument(daysAgo(89), NOW)).toBe(false);
  });
  it("acepta Date, ISO y milisegundos como referencia", () => {
    expect(isStaleDocument(new Date(daysAgo(120)), NOW.getTime(), 90)).toBe(
      true,
    );
    expect(isStaleDocument(daysAgo(10), NOW.getTime(), 90)).toBe(false);
  });
  it("una fecha inválida o ausente no vence", () => {
    expect(isStaleDocument("no-es-fecha", NOW, 90)).toBe(false);
    expect(isStaleDocument("", NOW, 90)).toBe(false);
    expect(isStaleDocument(null, NOW, 90)).toBe(false);
    expect(isStaleDocument(undefined, NOW, 90)).toBe(false);
    expect(isStaleDocument(new Date(NaN), NOW, 90)).toBe(false);
  });
  it("una vigencia inválida no vence", () => {
    expect(isStaleDocument(daysAgo(365), NOW, NaN)).toBe(false);
    expect(isStaleDocument(daysAgo(365), NOW, -1)).toBe(false);
  });
  it("un documento del futuro no vence", () => {
    expect(isStaleDocument(daysAgo(-5), NOW, 90)).toBe(false);
  });
});

describe("DOCUMENT_MAX_AGE_DAYS", () => {
  it("la composición accionaria vence a los 90 días y el resto no vence", () => {
    expect(DOCUMENT_MAX_AGE_DAYS.composicion_accionaria).toBe(90);
    expect(DOCUMENT_MAX_AGE_DAYS.rut).toBeUndefined();
    expect(DOCUMENT_MAX_AGE_DAYS.camara_comercio).toBeUndefined();
  });
});
