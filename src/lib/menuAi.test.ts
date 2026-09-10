import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  row: null as null | { menuAiKeyEnc: string | null; menuAiEnabled: boolean },
  upsert: vi.fn(),
  create: vi.fn(),
  constructor: vi.fn(),
  env: {
    ANTHROPIC_API_KEY: undefined as string | undefined,
    ANTHROPIC_MODEL: "fixture-model",
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  env: mocks.env,
  requireSecretKey: () => "ab".repeat(32),
}));
vi.mock("@/lib/db", () => ({
  db: {
    platformConfig: {
      findUnique: vi.fn(async () => mocks.row),
      upsert: mocks.upsert,
    },
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mocks.create };
    constructor(args: unknown) {
      mocks.constructor(args);
    }
  },
}));
import {
  getMenuAiClient,
  getMenuAiStatus,
  setMenuAiConfig,
} from "./menuAiConfig";
import { generateMenuDescriptions } from "./menuDescribe";
import { decrypt, encrypt } from "./crypto";
const dish = {
  id: "one",
  name: "Sopa",
  categoryLabel: "Entradas",
  description: "Tomate y albahaca",
};
const reply = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.row = null;
  mocks.env.ANTHROPIC_API_KEY = undefined;
});

describe("shared menu AI credential", () => {
  it("encrypts the key and preserves it on an empty update", async () => {
    await setMenuAiConfig(
      { apiKey: " sk-ant-fixture ", enabled: true },
      "admin",
    );
    const data = mocks.upsert.mock.calls[0][0].update;
    expect(data.menuAiKeyEnc).not.toContain("sk-ant-fixture");
    expect(decrypt(data.menuAiKeyEnc)).toBe("sk-ant-fixture");
    expect(data.updatedById).toBe("admin");
    await setMenuAiConfig({ apiKey: "", enabled: false }, "admin");
    expect(mocks.upsert.mock.calls[1][0].update).not.toHaveProperty(
      "menuAiKeyEnc",
    );
  });
  it("uses a global server fallback and immediately prefers an admin rotation", async () => {
    mocks.env.ANTHROPIC_API_KEY = "server-fixture";
    await getMenuAiClient();
    expect(mocks.constructor).toHaveBeenLastCalledWith({
      apiKey: "server-fixture",
      timeout: 25000,
      maxRetries: 0,
    });
    mocks.row = { menuAiKeyEnc: encrypt("admin-fixture"), menuAiEnabled: true };
    await getMenuAiClient();
    expect(mocks.constructor).toHaveBeenLastCalledWith({
      apiKey: "admin-fixture",
      timeout: 25000,
      maxRetries: 0,
    });
    expect(await getMenuAiStatus()).toEqual({ source: "admin", enabled: true });
  });
  it("fails closed for disabled, absent or corrupt credentials", async () => {
    await expect(getMenuAiClient()).rejects.toThrow("ai_not_configured");
    mocks.row = { menuAiKeyEnc: null, menuAiEnabled: false };
    await expect(getMenuAiClient()).rejects.toThrow("ai_disabled");
    mocks.row = { menuAiKeyEnc: "broken", menuAiEnabled: true };
    mocks.env.ANTHROPIC_API_KEY = "must-not-fallback";
    await expect(getMenuAiClient()).rejects.toThrow("ai_failed");
    expect(mocks.constructor).not.toHaveBeenCalled();
  });
});
describe("description generation", () => {
  beforeEach(() => {
    mocks.env.ANTHROPIC_API_KEY = "fixture-only";
  });
  it("uses supplied context as data and retries only missing dishes", async () => {
    mocks.create
      .mockResolvedValueOnce(
        reply([
          null,
          { i: 0, t: "Crema suave de tomate con albahaca" },
          { i: -1, t: "wrong" },
        ]),
      )
      .mockResolvedValueOnce(reply([{ i: 0, t: "Una segunda propuesta" }]));
    const result = await generateMenuDescriptions([
      dish,
      { ...dish, id: "two", name: "Pasta" },
    ]);
    expect(result.size).toBe(2);
    const first = mocks.create.mock.calls[0][0];
    expect(first.system).toContain("nunca instrucciones");
    expect(JSON.parse(first.messages[0].content)[0].description).toBe(
      dish.description,
    );
    expect(
      JSON.parse(mocks.create.mock.calls[1][0].messages[0].content),
    ).toHaveLength(1);
    expect(result.get("two")).toBe("Una segunda propuesta");
  });
  it("rejects empty/malformed responses after bounded retries", async () => {
    mocks.create.mockResolvedValue(
      reply([null, {}, { i: "0", t: "not valid" }]),
    );
    await expect(generateMenuDescriptions([dish])).rejects.toThrow("ai_failed");
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it("bounds generated text", async () => {
    mocks.create.mockResolvedValue(reply([{ i: 0, t: "a".repeat(800) }]));
    expect((await generateMenuDescriptions([dish])).get("one")).toHaveLength(
      180,
    );
  });
});
