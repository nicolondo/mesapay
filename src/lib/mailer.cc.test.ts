import { afterEach, expect, it, vi } from "vitest";
import { sendEmail } from "./mailer";

// Varios correos por factura: la copia viaja en el mismo mensaje y, sin
// copia, el body sale exactamente igual que antes (la clave ni se serializa).
// Transporte simulado: `fetch` es un doble; nunca sale un correo real.
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("sends the extra invoice emails as cc in the same message", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-only");
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher);
  await sendEmail({ to: "main@example.test", cc: ["a@example.test", "b@example.test"], subject: "s", text: "t", html: "<p>t</p>" });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.to).toBe("main@example.test");
  expect(body.cc).toEqual(["a@example.test", "b@example.test"]);
});

it("keeps the body unchanged when there is no copy", async () => {
  vi.stubEnv("RESEND_API_KEY", "test-only");
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher);
  await sendEmail({ to: "main@example.test", cc: [], subject: "s", text: "t", html: "<p>t</p>" });
  await sendEmail({ to: "main@example.test", subject: "s", text: "t", html: "<p>t</p>" });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty("cc");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).not.toHaveProperty("cc");
});
