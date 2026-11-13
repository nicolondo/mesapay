// GET /salir — cerrar sesión con solo abrir la dirección.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@/auth", () => ({ signOut: m.signOut }));

import { GET } from "./route";

const NAVIGATION = {
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

const call = (headers: Record<string, string> = {}, method = "GET") =>
  GET(new Request("http://localhost/salir", { method, headers }));

const expectSignedOut = (res: Response) => {
  expect(m.signOut).toHaveBeenCalledTimes(1);
  // Sin redirect de Auth.js: el Location lo pone el handler, relativo.
  expect(m.signOut).toHaveBeenCalledWith({ redirect: false, redirectTo: "/signin" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/signin");
  expect(res.headers.get("cache-control")).toBe("no-store");
};

const expectIgnored = (res: Response) => {
  expect(m.signOut).not.toHaveBeenCalled();
  expect(res.status).toBe(204);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
};

beforeEach(() => {
  vi.resetAllMocks();
  m.signOut.mockResolvedValue({ redirect: "http://localhost/signin", cookies: [] });
});

describe("GET /salir", () => {
  it("navegación de primer nivel: cierra la sesión y redirige a /signin", async () => {
    expectSignedOut(await call(NAVIGATION));
  });

  it("navegador viejo sin Sec-Fetch-*: también cierra la sesión", async () => {
    expectSignedOut(await call());
  });

  it("llegar desde un enlace en otro sitio (WhatsApp Web, correo) sigue siendo una navegación", async () => {
    expectSignedOut(await call({ ...NAVIGATION, "sec-fetch-site": "cross-site" }));
  });

  it.each([
    ["prefetch del router de Next", { "next-router-prefetch": "1" }],
    ["petición RSC", { rsc: "1" }],
    ["Purpose: prefetch", { purpose: "prefetch" }],
    ["Sec-Purpose: prefetch", { "sec-purpose": "prefetch" }],
    ["Sec-Purpose: prefetch;prerender", { "sec-purpose": "prefetch;prerender" }],
    ["X-Purpose: preview", { "x-purpose": "preview" }],
    ["X-Moz: prefetch", { "x-moz": "prefetch" }],
  ])("precarga con encabezados de navegación (%s): no cierra la sesión", async (_name, extra) => {
    expectIgnored(await call({ ...NAVIGATION, ...extra }));
  });

  it.each([
    ["<img>", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }],
    ["<iframe>", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }],
    ["<script>", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }],
    ["fetch()", { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }],
    ["solo Sec-Fetch-Dest: image", { "sec-fetch-dest": "image" }],
    ["solo Sec-Fetch-Mode: no-cors", { "sec-fetch-mode": "no-cors" }],
  ])("petición embebida o por script (%s): no cierra la sesión", async (_name, headers) => {
    expectIgnored(await call(headers));
  });

  it("HEAD (Next lo atiende con el handler de GET): no cierra la sesión", async () => {
    expectIgnored(await call(NAVIGATION, "HEAD"));
  });
});
