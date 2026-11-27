import { describe, expect, it } from "vitest";
import { terminalWarnings } from "./terminalHealth";

const devices = [
  { label: "A", kushkiDeviceId: "1", serialNumber: "A", active: true },
  { label: "B", kushkiDeviceId: "2", serialNumber: "B", active: true },
];
const timeout = (serial: string, ms: number) => ({ kind: "timeout" as const, at: new Date(ms), serial });

const busy = (serial: string, ms: number) => ({ kind: "cloud_busy" as const, at: new Date(ms), serial });

describe("salud del datáfono", () => {
  it("504 seguido de dos rechazos de la nube: avisa ya con el primero, desde el 504", () => {
    const gateway = timeout("A", 16_000);
    const retry = busy("A", 37_000);
    expect(terminalWarnings(devices, [gateway])).toEqual([]);
    expect(terminalWarnings(devices, [retry, gateway])).toMatchObject([{ count: 2, since: gateway.at.toISOString() }]);
    expect(terminalWarnings(devices, [busy("A", 42_000), retry, gateway])).toMatchObject([{ count: 3, since: gateway.at.toISOString() }]);
  });
  it("un ocupado aislado, anterior al timeout o de otro serial no inicia la alerta", () => {
    expect(terminalWarnings(devices, [busy("A", 1), busy("A", 2)])).toEqual([]);
    expect(terminalWarnings(devices, [busy("A", 1), timeout("A", 2), busy("B", 3)])).toEqual([]);
  });
  it.each(["approved", "answered", "printed"] as const)("una respuesta %s despeja el aviso y el siguiente ocupado queda aislado", kind => {
    expect(terminalWarnings(devices, [timeout("A", 1), busy("A", 2), { kind, serial: "A", at: new Date(3) }, busy("A", 4)])).toEqual([]);
  });
  it("cuenta desde el primer timeout de gateway del mismo serial", () => {
    expect(terminalWarnings(devices, [timeout("A", 2), timeout("B", 1)])).toEqual([]);
    expect(terminalWarnings(devices, [timeout("A", 6), timeout("B", 3), timeout("A", 2)])).toEqual([
      { deviceIds: ["1"], serial: "A", label: "A", count: 2, since: new Date(2).toISOString() },
    ]);
  });
  it.each(["approved", "answered", "printed"] as const)("reinicia la cuenta con %s aunque las filas lleguen desordenadas", kind => {
    const events = [timeout("A", 1), timeout("A", 2), timeout("A", 4), { kind, serial: "A", at: new Date(3) }];
    expect(terminalWarnings(devices, events)).toEqual([]);
    expect(terminalWarnings(devices, [...events, timeout("A", 5)])[0]).toMatchObject({ since: new Date(4).toISOString(), count: 2 });
  });
  it("agrupa las asignaciones del mismo equipo y conserva el aviso si responde otro serial", () => {
    const alias = { ...devices[0], kushkiDeviceId: "3" };
    const result = terminalWarnings([...devices, alias], [timeout("A", 2), timeout("A", 4), { kind: "answered", serial: "B", at: new Date(5) }]);
    expect(result).toHaveLength(1);
    expect(result[0].deviceIds).toEqual(["1", "3"]);
  });
});
