import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), upsert: vi.fn(), audit: vi.fn(), billing: vi.fn(), decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock("@/lib/db", () => { const tx = { $queryRaw: vi.fn(), platformConfig: { findUnique: m.get, upsert: m.upsert }, platformWalletAccount: { create: m.create }, auditEvent: { create: m.audit } }; return { db: { ...tx, $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } }; });
vi.mock("@/lib/crypto", () => ({ decrypt: m.decrypt, encrypt: m.encrypt }));
vi.mock("@/lib/platformConfig", () => ({ getBillingCredentials: m.billing }));
import { saveWalletConfig, readWalletConfig, activeAccount, credentials, webhookSecret } from "./config";
import type { PlatformWalletAccount } from "@prisma/client";
const actor = { id: "admin", email: "admin@example.test" };
const existing: PlatformWalletAccount = { id: "a1", label: "Account", mode: "production", publicKey: "public", privateKeyEnc: "enc-private", webhookSecretEnc: "enc-hook", createdById: "admin", createdByEmail: "admin@example.test", createdAt: new Date() };
beforeEach(() => {
  vi.resetAllMocks(); m.get.mockResolvedValue({ platformWalletAccount: existing }); m.billing.mockResolvedValue({ publicKey: "billing-public", privateKey: "billing-private" });
  m.encrypt.mockImplementation((value: string) => `encrypted:${value}`); m.decrypt.mockReturnValue("private");
  m.create.mockImplementation(async ({ data }) => ({ ...data, id: "new-account", createdAt: new Date() }));
});
describe("immutable platform wallet credentials", () => {
  it("returns only public state and whether billing is configured", async () => {
    const result = await readWalletConfig(); expect(result.billingConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("enc-private"); expect(JSON.stringify(result)).not.toContain("billing-private");
    expect(result.account?.hasPrivateKey).toBe(true);
  });
  it("does not fabricate an account from billing credentials", async () => {
    m.get.mockResolvedValue(null); expect((await readWalletConfig()).account).toBeNull();
    await expect(activeAccount()).rejects.toThrow("wallet_not_configured");
  });
  it("creates a new encrypted credential version without altering billing fields", async () => {
    await saveWalletConfig({ label: "New", mode: "sandbox", publicKey: "pub-new", privateKey: "priv-new" }, actor);
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ mode: "sandbox", publicKey: "pub-new", privateKeyEnc: "encrypted:priv-new" }) });
    expect(m.upsert).toHaveBeenCalledWith({ where: { id: "singleton" }, create: { id: "singleton", platformWalletAccountId: "new-account", updatedById: "admin" }, update: { platformWalletAccountId: "new-account", updatedById: "admin" } });
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain("priv-new");
  });
  it("preserves secret only with unchanged public key and mode", async () => {
    await saveWalletConfig({ label: "Rename", mode: "production", publicKey: "public", privateKey: "" }, actor);
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ privateKeyEnc: "enc-private" }) });
    await expect(saveWalletConfig({ label: "Rename", mode: "sandbox", publicKey: "public" }, actor)).rejects.toThrow("private_key_required");
    await expect(saveWalletConfig({ label: "Rename", mode: "production", publicKey: "another" }, actor)).rejects.toThrow("private_key_required");
  });
  it("fails closed on unreadable keys and never uses the billing key", async () => {
    m.decrypt.mockImplementation(() => { throw new Error("encryption error with secrets"); });
    expect(() => credentials(existing)).toThrow("credentials_unavailable");
    expect(() => webhookSecret(existing)).toThrow("credentials_unavailable");
    await expect(saveWalletConfig({ label: "Rename", mode: "production", publicKey: "public" }, actor)).rejects.toThrow("credentials_unavailable");
    expect(m.create).not.toHaveBeenCalled();
  });
  it("rejects unsupported data without creating a version", async () => {
    await expect(saveWalletConfig({ label: "New", mode: "mock", publicKey: "public" }, actor)).rejects.toThrow("invalid_payload");
    expect(m.create).not.toHaveBeenCalled();
  });
});
