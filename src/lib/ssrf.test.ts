import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
const h = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: h.lookup }));
vi.mock("node:http", () => ({ request: h.request }));
vi.mock("node:https", () => ({ request: h.request }));
import { fetchPublicUrl } from "./ssrf";
function reply(status: number, headers: Record<string, string>, data = Buffer.from("ok")) {
  return (_url: URL, _opts: unknown, done: (r: IncomingMessage) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: status, headers });
      done(response as unknown as IncomingMessage);
      queueMicrotask(() => response.end(data));
    };
    return request;
  };
}
beforeEach(() => { vi.clearAllMocks(); h.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]); });
describe("public import transport", () => {
  it("validates a redirect before connecting to its private target", async () => {
    h.request.mockImplementationOnce(reply(302, { location: "http://127.0.0.1/private" }));
    await expect(fetchPublicUrl("https://public.test/menu")).rejects.toThrow("private_address");
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("pins DNS and strips authentication from the outgoing connection", async () => {
    h.request.mockImplementationOnce(reply(200, {}));
    const response = await fetchPublicUrl("https://public.test/menu", { headers: { authorization: "secret", cookie: "private", host: "injected" } });
    expect(await response.text()).toBe("ok");
    const options = h.request.mock.calls[0][1];
    const callback = vi.fn(); options.lookup("public.test", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(options.headers).not.toHaveProperty("authorization"); expect(options.headers).not.toHaveProperty("cookie"); expect(options.headers).not.toHaveProperty("host");
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });
  it("rejects a response larger than the import budget", async () => {
    h.request.mockImplementationOnce(reply(200, {}, Buffer.alloc(20 * 1024 * 1024 + 1)));
    const response = await fetchPublicUrl("https://public.test/menu");
    await expect(response.arrayBuffer()).rejects.toThrow("response_too_large");
  });
});
