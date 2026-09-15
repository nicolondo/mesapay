// La ruta del cron: el secreto es la única puerta, y lo demás es el barrido.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ sweep: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/dian/sweep", () => ({ sweepDianEmissions: m.sweep }));

import { POST } from "./route";

const req = (secret?: string) =>
  new Request("http://localhost/api/cron/dian-emit", {
    method: "POST",
    headers: secret ? { "x-cron-secret": secret } : {},
  });

const original = process.env.CRON_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = "s3cr3t";
  m.sweep.mockResolvedValue({ scanned: 2, accepted: 2, blocked: 0 });
});

afterEach(() => {
  process.env.CRON_SECRET = original;
});

describe("POST /api/cron/dian-emit", () => {
  it("401 sin secreto o con el secreto equivocado", async () => {
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req("otro"))).status).toBe(401);
    expect(m.sweep).not.toHaveBeenCalled();
  });

  it("401 si el servidor no tiene CRON_SECRET configurado (nunca abierto por defecto)", async () => {
    process.env.CRON_SECRET = "";
    expect((await POST(req(""))).status).toBe(401);
    expect(m.sweep).not.toHaveBeenCalled();
  });

  it("con el secreto corre el barrido y devuelve el resumen", async () => {
    const res = await POST(req("s3cr3t"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scanned: 2, accepted: 2, blocked: 0 });
    expect(m.sweep).toHaveBeenCalledTimes(1);
  });
});
