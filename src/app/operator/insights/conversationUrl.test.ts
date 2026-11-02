import { describe, expect, it } from "vitest";
import { conversationHref, formatConversationDate, readConversationId } from "./conversationUrl";

const CUID = "cmhgq3x9k0001l8d2f4b7e9ab";

describe("readConversationId", () => {
  it("devuelve el id de ?c= cuando tiene pinta de cuid", () => {
    expect(readConversationId(`c=${CUID}`)).toBe(CUID);
    expect(readConversationId(new URLSearchParams({ tab: "x", c: CUID }))).toBe(CUID);
  });

  it("devuelve null si falta, está vacío o trae caracteres raros", () => {
    expect(readConversationId("")).toBeNull();
    expect(readConversationId(null)).toBeNull();
    expect(readConversationId(undefined)).toBeNull();
    expect(readConversationId("c=")).toBeNull();
    expect(readConversationId("c=abc")).toBeNull();
    expect(readConversationId("c=../../etc")).toBeNull();
    expect(readConversationId("c=%3Cscript%3Ealert(1)%3C/script%3E")).toBeNull();
    expect(readConversationId(`c=${"a".repeat(41)}`)).toBeNull();
  });
});

describe("conversationHref", () => {
  it("fija ?c= conservando el resto de la query", () => {
    expect(conversationHref("/operator/insights", "", CUID)).toBe(`/operator/insights?c=${CUID}`);
    expect(conversationHref("/operator/insights", "tab=x", CUID)).toBe(`/operator/insights?tab=x&c=${CUID}`);
    expect(conversationHref("/operator/insights", `c=otro&tab=x`, CUID)).toBe(`/operator/insights?c=${CUID}&tab=x`);
  });

  it("quita ?c= y no deja un «?» colgando", () => {
    expect(conversationHref("/operator/insights", `c=${CUID}`, null)).toBe("/operator/insights");
    expect(conversationHref("/operator/insights", `c=${CUID}&tab=x`, null)).toBe("/operator/insights?tab=x");
  });
});

describe("formatConversationDate", () => {
  const tz = "America/Bogota";
  // 2 de noviembre de 2026, 15:05 en Bogotá (UTC-5).
  const now = new Date("2026-11-02T20:05:00Z");

  it("hoy: sólo la hora", () => {
    const s = formatConversationDate(new Date("2026-11-02T14:30:00Z"), { locale: "en", now, timeZone: tz });
    expect(s).toMatch(/9:30/);
    expect(s).not.toMatch(/2026|Nov/);
  });

  it("este año: día y mes cortos, sin hora", () => {
    const s = formatConversationDate(new Date("2026-10-05T14:30:00Z"), { locale: "en", now, timeZone: tz });
    expect(s).toBe("Oct 5");
    const es = formatConversationDate("2026-10-05T14:30:00Z", { locale: "es", now, timeZone: tz });
    expect(es).toMatch(/^5 (de )?oct/);
    expect(es).not.toMatch(/2026|:/);
  });

  it("otro año: fecha corta con el año", () => {
    const s = formatConversationDate(new Date("2025-10-05T14:30:00Z"), { locale: "en", now, timeZone: tz });
    expect(s).toMatch(/25/);
    expect(s).not.toMatch(/:/);
  });

  it("decide «hoy» en la zona horaria dada, no en UTC", () => {
    // 23:30 del 1 de noviembre en Bogotá = 04:30Z del 2 de noviembre.
    const lateYesterday = new Date("2026-11-02T04:30:00Z");
    const earlyToday = new Date("2026-11-02T05:30:00Z"); // 00:30 del 2 en Bogotá
    expect(formatConversationDate(lateYesterday, { locale: "en", now: earlyToday, timeZone: tz })).toBe("Nov 1");
    expect(formatConversationDate(lateYesterday, { locale: "en", now: earlyToday, timeZone: "UTC" })).toMatch(/4:30/);
  });
});
