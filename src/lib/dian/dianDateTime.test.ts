// Fecha y hora fiscal colombiana de los documentos DIAN. Lo que se cuida:
// el día de la factura es el día de BOGOTÁ, también de 7 p. m. a
// medianoche (00:00–05:00 UTC), que es justo cuando el día UTC ya cambió.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { dianDueDate, dianIssueDateTime, dianSigningTime } from "./dianDateTime";
import { bogotaIssueTime, creditPaymentMeans } from "./emit";

/** Instante a partir de la hora de pared de Bogotá (UTC−5). */
const bogota = (wall: string) => new Date(`${wall}-05:00`);

describe("dianIssueDateTime — el día y la hora de Bogotá", () => {
  it.each([
    // [hora de pared en Bogotá, instante UTC, fecha, hora]
    ["2026-09-15T18:59:00", "2026-09-15T23:59:00.000Z", "2026-09-15", "18:59:00-05:00"],
    // 7 p. m.: medianoche UTC. Antes la factura ya decía "16".
    ["2026-09-15T19:00:00", "2026-09-16T00:00:00.000Z", "2026-09-15", "19:00:00-05:00"],
    ["2026-09-15T23:59:59", "2026-09-16T04:59:59.000Z", "2026-09-15", "23:59:59-05:00"],
    // Pasada la medianoche de Bogotá sí es el día siguiente, y la hora es
    // "00:30", no "24:30".
    ["2026-09-16T00:30:00", "2026-09-16T05:30:00.000Z", "2026-09-16", "00:30:00-05:00"],
  ])("%s en Bogotá", (wall, utc, date, time) => {
    const at = bogota(wall);
    expect(at.toISOString()).toBe(utc);
    expect(dianIssueDateTime(at)).toEqual({ date, time });
  });

  it("el 30/09 a las 8 p. m. sigue siendo septiembre (cierre del período de IVA/INC)", () => {
    const at = bogota("2026-09-30T20:00:00");
    expect(at.toISOString()).toBe("2026-10-01T01:00:00.000Z");
    // Lo que hacía el código viejo: el día UTC, ya octubre.
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(dianIssueDateTime(at)).toEqual({ date: "2026-09-30", time: "20:00:00-05:00" });
  });

  it("fin de año: el 31/12 por la noche no se va al año siguiente", () => {
    expect(dianIssueDateTime(bogota("2026-12-31T23:15:00")).date).toBe("2026-12-31");
    expect(dianIssueDateTime(bogota("2027-01-01T00:00:00")).date).toBe("2027-01-01");
  });

  it("trunca los milisegundos (nunca redondea hacia el segundo siguiente)", () => {
    const at = new Date("2026-10-01T04:59:59.999Z");
    expect(dianIssueDateTime(at)).toEqual({ date: "2026-09-30", time: "23:59:59-05:00" });
  });

  it("fecha + hora declaradas vuelven a ser el mismo instante (al segundo)", () => {
    const at = new Date("2026-10-01T01:23:45.678Z");
    const { date, time } = dianIssueDateTime(at);
    expect(new Date(`${date}T${time}`).getTime()).toBe(Math.floor(at.getTime() / 1000) * 1000);
  });

  it("coincide con la zona America/Bogota de ICU en cualquier momento (UTC−5 fijo, sin horario de verano)", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const start = Date.UTC(2026, 0, 1);
    // Cada 37 minutos durante dos años: cruza todas las horas y medianoches.
    for (let t = start; t < start + 2 * 366 * 86_400_000; t += 37 * 60_000) {
      const at = new Date(t);
      const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
      expect(dianIssueDateTime(at)).toEqual({
        date: `${p.year}-${p.month}-${p.day}`,
        time: `${p.hour}:${p.minute}:${p.second}-05:00`,
      });
    }
  });

  it("no depende de la zona horaria del servidor", () => {
    // El helper no lee la zona del proceso; se prueba igual con el
    // instante de la 7 p. m. escrito en tres zonas distintas.
    const same = [
      new Date("2026-09-15T19:00:00-05:00"),
      new Date("2026-09-16T00:00:00Z"),
      new Date("2026-09-16T09:00:00+09:00"),
    ].map(dianIssueDateTime);
    expect(new Set(same.map((x) => `${x.date} ${x.time}`)).size).toBe(1);
    expect(same[0]).toEqual({ date: "2026-09-15", time: "19:00:00-05:00" });
  });

  it("una fecha inválida revienta en vez de declarar 'NaN'", () => {
    expect(() => dianIssueDateTime(new Date("no-es-fecha"))).toThrow(RangeError);
  });

  it("`bogotaIssueTime` (atajo compatible) da la misma hora que el helper", () => {
    for (const wall of ["2026-09-15T18:59:00", "2026-09-15T19:00:00", "2026-09-16T00:30:00"]) {
      const at = bogota(wall);
      expect(bogotaIssueTime(at)).toBe(dianIssueDateTime(at).time);
    }
  });
});

describe("dianSigningTime — xades:SigningTime", () => {
  it("es la hora de Bogotá con su desfase, del mismo día que el IssueDate", () => {
    const at = bogota("2026-09-30T20:00:00");
    const signing = dianSigningTime(at);
    expect(signing).toBe("2026-09-30T20:00:00-05:00");
    expect(signing.slice(0, 10)).toBe(dianIssueDateTime(at).date);
    // Y es el instante real, no cinco horas en el futuro (lo de antes:
    // "2026-10-01T01:00:00-05:00").
    expect(new Date(signing).getTime()).toBe(at.getTime());
  });
});

describe("vencimiento del crédito — desde la fecha de Bogotá", () => {
  it("dianDueDate suma días calendario y tolera plazo 0 o negativo", () => {
    expect(dianDueDate("2026-09-30", 30)).toBe("2026-10-30");
    expect(dianDueDate("2026-12-15", 30)).toBe("2027-01-14");
    expect(dianDueDate("2026-09-30", 0)).toBe("2026-09-30");
    expect(dianDueDate("2026-09-30", -5)).toBe("2026-09-30");
  });

  it("venta a crédito a 1 día el 30/09 a las 8 p. m. vence el 1/10, no el 2/10", () => {
    const issued = dianIssueDateTime(bogota("2026-09-30T20:00:00"));
    const means = creditPaymentMeans([{ billingCustomer: { creditTermsDays: 1 } }], issued.date);
    expect(means.paymentDueDate).toBe("2026-10-01");
  });
});
