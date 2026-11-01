import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Salón ya no usa `devices[0]` a ciegas: con dos o más datáfonos, el cobro
 * podía ir al equipo equivocado. Ahora la tarjeta recibe TODOS los
 * disponibles (activos y, si son reales, con serial y Business-Code) para
 * que quien cobra elija, y nada depende de a quién estuviera "asignado".
 */

const m = vi.hoisted(() => ({
  devices: [] as Array<{ kushkiDeviceId: string; label: string; active: boolean; serialNumber: string | null; assignedUserId?: string | null }>,
  deviceQuery: vi.fn(),
  session: { user: { id: "mesero-2", role: "mesero" } },
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  serviceMode: "table",
  adminOnlyCharge: false,
  kushkiMode: "production",
  cloudTerminalBusinessCode: "bc-test",
};

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => TENANT) },
    round: { findMany: vi.fn(async () => []) },
    payment: { findMany: vi.fn(async () => []) },
    order: { findMany: vi.fn(async () => []) },
    table: { findMany: vi.fn(async () => []) },
    terminalDevice: {
      findMany: async (args: { where: { active?: boolean } }) => {
        m.deviceQuery(args);
        return m.devices.filter((d) => args.where.active === undefined || d.active === args.where.active);
      },
    },
    financialOperation: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "rest-1" }));
vi.mock("@/lib/meseroScope", () => ({ getMeseroScope: async () => null, meseroTableWhere: () => null }));
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async (r: { kushkiMode?: string | null }) => r.kushkiMode ?? "mock",
}));
vi.mock("@/lib/env", () => ({ env: { KUSHKI_BP_BUSINESS_CODE: undefined } }));
vi.mock("./ServeBoard", () => ({ ServeBoard: () => null }));

import ServePage from "./page";

type Props = { devices: Array<{ id: string; label: string }>; device?: unknown };
const props = async () => ((await ServePage()) as unknown as { props: Props }).props;

beforeEach(() => {
  vi.clearAllMocks();
  m.session = { user: { id: "mesero-2", role: "mesero" } };
});

describe("Salón: a qué datáfonos se puede mandar el cobro", () => {
  it("con dos datáfonos disponibles, la tarjeta recibe los dos (no sólo el primero)", async () => {
    m.devices = [
      // Asignado a OTRO mesero: da igual, el datáfono es del comercio.
      { kushkiDeviceId: "kd-caja", label: "Caja", active: true, serialNumber: "P3F6P624J0139", assignedUserId: "mesero-1" },
      { kushkiDeviceId: "kd-terraza", label: "Terraza", active: true, serialNumber: "P3F6P624J0140", assignedUserId: null },
    ];
    const p = await props();
    expect(p.devices).toEqual([
      { id: "kd-caja", label: "Caja" },
      { id: "kd-terraza", label: "Terraza" },
    ]);
    expect(p).not.toHaveProperty("device");
  });

  it("deja afuera los que terminal/charge rechazaría (inactivo o real sin serial)", async () => {
    m.devices = [
      { kushkiDeviceId: "kd-sin-serial", label: "Sin serial", active: true, serialNumber: null },
      { kushkiDeviceId: "kd-apagado", label: "Apagado", active: false, serialNumber: "P3F6P624J0141" },
      { kushkiDeviceId: "kd-terraza", label: "Terraza", active: true, serialNumber: "P3F6P624J0140" },
    ];
    expect((await props()).devices).toEqual([{ id: "kd-terraza", label: "Terraza" }]);
  });

  it("la consulta de datáfonos no filtra ni lee a quién está asignado", async () => {
    m.devices = [{ kushkiDeviceId: "kd-caja", label: "Caja", active: true, serialNumber: "P3F6P624J0139" }];
    await props();
    const args = m.deviceQuery.mock.calls[0][0] as { where: Record<string, unknown>; select?: Record<string, unknown> };
    expect(args.where).not.toHaveProperty("assignedUserId");
    expect(args.select ?? {}).not.toHaveProperty("assignedUserId");
  });
});
