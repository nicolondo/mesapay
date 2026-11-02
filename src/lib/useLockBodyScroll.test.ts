import { beforeEach, describe, expect, it, vi } from "vitest";
import { bodyLockCount, lockBody, resetBodyLockForTests, unlockBody, type BodySurface } from "./useLockBodyScroll";

function surface(scrollY = 120): BodySurface & { scrollTo: ReturnType<typeof vi.fn> } {
  return {
    style: { position: "", top: "", left: "", right: "", width: "" },
    scrollY,
    scrollTo: vi.fn(),
  };
}

describe("bloqueo del scroll del body (contado)", () => {
  beforeEach(() => resetBodyLockForTests());

  it("un overlay: fija el body y lo restaura con su scroll", () => {
    const s = surface(120);
    lockBody(s);
    expect(s.style.position).toBe("fixed");
    expect(s.style.top).toBe("-120px");
    expect(bodyLockCount()).toBe(1);
    unlockBody(s);
    expect(s.style.position).toBe("");
    expect(s.style.top).toBe("");
    expect(s.scrollTo).toHaveBeenCalledWith(0, 120);
    expect(bodyLockCount()).toBe(0);
  });

  it("dos overlays anidados cerrados de padre a hijo (el caso que dejaba el body pegado)", () => {
    const s = surface(80);
    lockBody(s); // hoja
    lockBody(s); // confirmación encima
    expect(s.style.position).toBe("fixed");
    // React limpia primero el padre y luego el hijo en el mismo commit.
    unlockBody(s);
    expect(s.style.position).toBe("fixed");
    unlockBody(s);
    expect(s.style.position).toBe("");
    expect(s.scrollTo).toHaveBeenCalledTimes(1);
    expect(s.scrollTo).toHaveBeenCalledWith(0, 80);
  });

  it("cerrar el hijo antes que el padre también restaura una sola vez", () => {
    const s = surface(0);
    lockBody(s);
    lockBody(s);
    unlockBody(s);
    unlockBody(s);
    expect(s.style.position).toBe("");
    expect(bodyLockCount()).toBe(0);
  });

  it("soltar de más no rompe ni deja el contador en negativo", () => {
    const s = surface(0);
    unlockBody(s);
    expect(bodyLockCount()).toBe(0);
    lockBody(s);
    unlockBody(s);
    unlockBody(s);
    expect(s.style.position).toBe("");
    expect(bodyLockCount()).toBe(0);
  });
});
