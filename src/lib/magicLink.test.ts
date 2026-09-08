import { describe, it, expect } from "vitest";
import {
  generateMagicLinkToken,
  hashMagicLinkToken,
  isMagicLinkUsable,
  MAGIC_LINK_TTL_MS,
} from "./magicLink";

describe("token del magic link", () => {
  it("genera tokens de 64 hex chars, distintos cada vez", () => {
    const a = generateMagicLinkToken();
    const b = generateMagicLinkToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("hashea de forma estable y sin devolver el token en claro", () => {
    // Lo que se guarda en DB no puede servir para entrar: si alguien lee la
    // tabla, tiene hashes, no llaves.
    const token = generateMagicLinkToken();
    const hash = hashMagicLinkToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hashMagicLinkToken(token)).toBe(hash);
  });
});

describe("isMagicLinkUsable", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("acepta un token nuevo sin usar", () => {
    expect(
      isMagicLinkUsable(
        { usedAt: null, expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS) },
        now,
      ),
    ).toBe(true);
  });

  it("rechaza un token ya canjeado (un solo uso)", () => {
    expect(
      isMagicLinkUsable(
        { usedAt: now, expiresAt: new Date(now.getTime() + 60_000) },
        now,
      ),
    ).toBe(false);
  });

  it("rechaza un token vencido", () => {
    expect(
      isMagicLinkUsable(
        { usedAt: null, expiresAt: new Date(now.getTime() - 1) },
        now,
      ),
    ).toBe(false);
  });

  it("rechaza un token inexistente", () => {
    expect(isMagicLinkUsable(null, now)).toBe(false);
    expect(isMagicLinkUsable(undefined, now)).toBe(false);
  });
});
