import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({ requireSecretKey: () => "11".repeat(32) }));
import { ownDestinationFingerprint, readOwnDestination } from "./ownDestination";
const bank = { bankName: "Bank", accountType: "ahorros", accountNumber: "123456789", holderName: "Test Person", holderDocType: "NIT", holderDocNumber: "901234567" };
describe("own destination review binding", () => {
  it("binds the complete normalized bank destination without exposing PII", () => {
    const fingerprint = ownDestinationFingerprint(bank); expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(ownDestinationFingerprint({ ...bank, holderName: " Test Person " }));
    for (const patch of [{ bankName: "Other bank" }, { accountNumber: "123456788" }, { accountType: "corriente" }, { holderDocNumber: "901234568" }, { holderName: "Other Person" }]) expect(ownDestinationFingerprint({ ...bank, ...patch })).not.toBe(fingerprint);
    expect(fingerprint).not.toContain(bank.accountNumber); expect(fingerprint).not.toContain(bank.holderDocNumber);
  });
  it("never issues a usable binding for missing or invalid bank information", () => {
    expect(ownDestinationFingerprint(null)).toBeNull(); expect(ownDestinationFingerprint({ ...bank, accountNumber: "x" })).toBeNull();
    expect(() => readOwnDestination(null)).toThrow("bank_info_invalid");
  });
});
