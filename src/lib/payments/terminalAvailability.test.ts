// Las precondiciones del datáfono Kushki en un solo lugar: las mismas que
// `terminal/charge` exige para empujar un cobro, más que el método esté
// habilitado. terminal-request y PayFlow las usan para no crear ni ofrecer
// una solicitud imposible (Son y Melona, 2026-10-31).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  devices: [] as Array<{ kushkiDeviceId?: string; label?: string; active: boolean; serialNumber: string | null }>,
  platformCode: undefined as string | undefined,
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { terminalDevice: { findMany: m.findMany } } }));
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, prop) => (prop === "KUSHKI_BP_BUSINESS_CODE" ? m.platformCode : undefined) }),
}));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async (r: { kushkiMode?: string | null }) => r.kushkiMode ?? "mock",
}));

import {
  kushkiTerminalAvailability,
  kushkiTerminalSetup,
  terminalDeviceUsable,
  usableTerminalDevices,
} from "./terminalAvailability";

const tenant = (over: Record<string, unknown> = {}) => ({
  id: "rest-1",
  kushkiMode: "production",
  cloudTerminalBusinessCode: "bc-1",
  enabledPaymentMethods: ["kushki_card_terminal", "cash"],
  ...over,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  m.devices = [{ kushkiDeviceId: "kd-1", label: "Caja", active: true, serialNumber: "PAX-1" }];
  m.platformCode = undefined;
  m.findMany.mockReset();
  m.findMany.mockImplementation(async ({ where }: { where: { restaurantId: string; active: boolean } }) =>
    where.restaurantId === "rest-1" ? m.devices.filter((d) => d.active === where.active) : [],
  );
});

describe("kushkiTerminalAvailability", () => {
  it("disponible: método habilitado, Business-Code y un datáfono activo con serial (con la lista para elegir)", async () => {
    expect(await kushkiTerminalAvailability(tenant())).toEqual({ available: true, devices: [{ id: "kd-1", label: "Caja" }] });
  });

  it("el caso de Son y Melona: método deshabilitado → no disponible, sin consultar equipos", async () => {
    expect(
      await kushkiTerminalAvailability(tenant({ enabledPaymentMethods: ["external_terminal", "cash", "kushki_card"] })),
    ).toEqual({ available: false, reason: "method_disabled" });
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("sin lista guardada (null) todos los métodos cuentan como habilitados", async () => {
    expect(await kushkiTerminalAvailability(tenant({ enabledPaymentMethods: null }))).toMatchObject({ available: true });
  });

  it("modo real sin Business-Code (ni del comercio ni de plataforma) → cloud_business_code_missing", async () => {
    expect(await kushkiTerminalAvailability(tenant({ cloudTerminalBusinessCode: null }))).toEqual({
      available: false,
      reason: "cloud_business_code_missing",
    });
  });

  it("el Business-Code de plataforma cubre al comercio que no cargó el suyo (como terminal/charge)", async () => {
    m.platformCode = "bc-platform";
    expect(await kushkiTerminalAvailability(tenant({ cloudTerminalBusinessCode: null }))).toMatchObject({ available: true });
  });

  it("0 datáfonos, sólo inactivos o reales sin serial → no_device", async () => {
    for (const devices of [[], [{ active: false, serialNumber: "PAX-1" }], [{ active: true, serialNumber: null }], [{ active: true, serialNumber: "" }]]) {
      m.devices = devices;
      expect(await kushkiTerminalAvailability(tenant()), JSON.stringify(devices)).toEqual({ available: false, reason: "no_device" });
    }
  });

  it("mock (sin Business-Code): basta un equipo activo, aunque no tenga serial", async () => {
    m.devices = [{ kushkiDeviceId: "kd-mock", label: "Demo", active: true, serialNumber: null }];
    expect(await kushkiTerminalAvailability(tenant({ kushkiMode: "mock", cloudTerminalBusinessCode: null }))).toEqual({
      available: true,
      devices: [{ id: "kd-mock", label: "Demo" }],
    });
  });

  it("el mock no cobra en producción → mock_payments_disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await kushkiTerminalAvailability(tenant({ kushkiMode: "mock", cloudTerminalBusinessCode: null }))).toEqual({
      available: false,
      reason: "mock_payments_disabled",
    });
  });
});

describe("kushkiTerminalSetup / terminalDeviceUsable (lo que usa terminal/charge)", () => {
  it("datáfono real si el modo no es mock o si el comercio cargó su Business-Code", async () => {
    expect(await kushkiTerminalSetup(tenant())).toEqual({ mode: "production", businessCode: "bc-1", useRealTerminal: true });
    expect(await kushkiTerminalSetup(tenant({ kushkiMode: "mock" }))).toMatchObject({ useRealTerminal: true });
    expect(await kushkiTerminalSetup(tenant({ kushkiMode: "mock", cloudTerminalBusinessCode: null }))).toEqual({
      mode: "mock",
      businessCode: null,
      useRealTerminal: false,
    });
  });

  it("un equipo sirve si está activo y, con datáfono real, tiene serial", () => {
    expect(terminalDeviceUsable({ active: true, serialNumber: "PAX-1" }, true)).toBe(true);
    expect(terminalDeviceUsable({ active: true, serialNumber: null }, true)).toBe(false);
    expect(terminalDeviceUsable({ active: true, serialNumber: null }, false)).toBe(true);
    expect(terminalDeviceUsable({ active: false, serialNumber: "PAX-1" }, false)).toBe(false);
  });
});

// Los datáfonos son del comercio y se elige al cobrar: la lista es la de los
// que `terminal/charge` aceptaría, no "el primero" ni el "asignado".
describe("usableTerminalDevices", () => {
  it("devuelve TODOS los datáfonos disponibles, en orden de registro, sin los que no sirven", async () => {
    m.devices = [
      { kushkiDeviceId: "kd-caja", label: "Caja", active: true, serialNumber: "P3F6P624J0139" },
      { kushkiDeviceId: "kd-sin-serial", label: "Sin serial", active: true, serialNumber: null },
      { kushkiDeviceId: "kd-terraza", label: "Terraza", active: true, serialNumber: "P3F6P624J0140" },
      { kushkiDeviceId: "kd-apagado", label: "Apagado", active: false, serialNumber: "P3F6P624J0141" },
    ];
    expect(await usableTerminalDevices(tenant())).toEqual({
      devices: [
        { id: "kd-caja", label: "Caja" },
        { id: "kd-terraza", label: "Terraza" },
      ],
      reason: null,
    });
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId: "rest-1", active: true }, orderBy: { createdAt: "asc" } }),
    );
  });

  it("sin Business-Code con datáfono real: ninguno, con el motivo", async () => {
    expect(await usableTerminalDevices(tenant({ cloudTerminalBusinessCode: null }))).toEqual({
      devices: [],
      reason: "cloud_business_code_missing",
    });
  });

  it("no depende de a quién estuviera asignado el datáfono (la columna ya no se lee)", async () => {
    await usableTerminalDevices(tenant());
    const args = m.findMany.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, unknown> };
    expect(args.where).not.toHaveProperty("assignedUserId");
    expect(args.select).not.toHaveProperty("assignedUserId");
  });
});
