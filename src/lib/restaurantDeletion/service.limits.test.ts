import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/test/fakeDeletionClient";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (holder.client as Record<string | symbol, unknown>)[prop] }),
}));
// Tope ridículo para no tener que armar 200 MB en un test.
vi.mock("./archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./archive")>()),
  MAX_ARCHIVE_BYTES: 16,
}));

import { deleteRestaurant } from "./service";

describe("tope del archivo final", () => {
  it("si el ZIP supera el tope, aborta sin borrar ni guardar nada", async () => {
    const fake = fakeClient({ restaurant: { id: "r1", slug: "sym", name: "SYM" } });
    holder.client = fake.client;
    const removeFile = vi.fn();
    await expect(
      deleteRestaurant({ restaurantId: "r1", confirmSlug: "sym", actor: { id: "a", email: "a@b.co", role: "platform_admin" }, removeFile }),
    ).rejects.toMatchObject({ code: "archive_too_large" });
    expect(fake.events).not.toContain("tx:commit");
    expect(fake.events.filter((e) => /^(deleteMany|delete|create):/.test(e))).toEqual([]);
    expect(removeFile).not.toHaveBeenCalled();
  });
});
