import { describe, it, expect } from "vitest";
import {
  checkMoveAllowed,
  destinationRoundState,
  syncedTargetOrderStatus,
} from "./moveOrderItem";

const base = {
  itemCancelled: false,
  sourceStatus: "placed" as const,
  sourceTableId: "mesa-3",
  targetTableId: "mesa-7",
  targetStatus: null,
};

describe("checkMoveAllowed", () => {
  it("permite mover a una mesa sin cuenta abierta", () => {
    expect(checkMoveAllowed(base)).toEqual({ ok: true });
  });

  it("permite mover a una mesa que ya tiene cuenta abierta", () => {
    expect(checkMoveAllowed({ ...base, targetStatus: "in_kitchen" })).toEqual({
      ok: true,
    });
  });

  it("rechaza un plato ya cancelado", () => {
    expect(checkMoveAllowed({ ...base, itemCancelled: true })).toEqual({
      ok: false,
      reason: "item_cancelled",
    });
  });

  it("rechaza mover a la misma mesa", () => {
    expect(
      checkMoveAllowed({ ...base, targetTableId: base.sourceTableId }),
    ).toEqual({ ok: false, reason: "same_table" });
  });

  // El corazón del feature: si cualquiera de las dos cuentas está en cobro,
  // syncOrderSubtotalFromLiveItems se niega a recalcular y los totales quedan
  // mal. Hay que rebotar el movimiento, no dejarlo pasar a medias.
  it("rechaza cuando la cuenta ORIGEN se está cobrando", () => {
    expect(checkMoveAllowed({ ...base, sourceStatus: "paying" })).toEqual({
      ok: false,
      reason: "order_paying",
    });
  });

  it("rechaza cuando la cuenta DESTINO se está cobrando", () => {
    expect(checkMoveAllowed({ ...base, targetStatus: "paying" })).toEqual({
      ok: false,
      reason: "target_order_paying",
    });
  });

  it("rechaza cuando la cuenta origen ya está pagada o anulada", () => {
    for (const s of ["paid", "cancelled"] as const) {
      expect(checkMoveAllowed({ ...base, sourceStatus: s })).toEqual({
        ok: false,
        reason: "order_closed",
      });
    }
  });

  it("rechaza cuando la cuenta destino ya está pagada o anulada", () => {
    for (const s of ["paid", "cancelled"] as const) {
      expect(checkMoveAllowed({ ...base, targetStatus: s })).toEqual({
        ok: false,
        reason: "target_order_closed",
      });
    }
  });

  it("prioriza el motivo del plato sobre el de la cuenta", () => {
    expect(
      checkMoveAllowed({
        ...base,
        itemCancelled: true,
        sourceStatus: "paying",
      }),
    ).toEqual({ ok: false, reason: "item_cancelled" });
  });
});

describe("destinationRoundState", () => {
  const now = new Date("2026-09-08T20:00:00.000Z");
  const started = new Date("2026-09-08T19:30:00.000Z");
  const served = new Date("2026-09-08T19:50:00.000Z");

  it("un plato sin mandar aterriza en una ronda placed", () => {
    expect(
      destinationRoundState(
        { kitchenStatus: "placed", servedAt: null, preparationStartedAt: null },
        now,
      ),
    ).toEqual({ status: "placed", kitchenStartedAt: null, readyAt: null });
  });

  it("un plato en cocina conserva el arranque real (no reinicia el countdown)", () => {
    expect(
      destinationRoundState(
        {
          kitchenStatus: "in_kitchen",
          servedAt: null,
          preparationStartedAt: started,
        },
        now,
      ),
    ).toEqual({
      status: "in_kitchen",
      kitchenStartedAt: started,
      readyAt: null,
    });
  });

  // Éste es el requisito duro: un plato ya preparado NO puede volver a
  // dispararse en la comanda de la mesa destino.
  it("un plato listo aterriza en una ronda ready, nunca en placed", () => {
    const r = destinationRoundState(
      {
        kitchenStatus: "ready",
        servedAt: null,
        preparationStartedAt: started,
      },
      now,
    );
    expect(r.status).toBe("ready");
    expect(r.readyAt).toEqual(now);
    expect(r.kitchenStartedAt).toEqual(started);
  });

  it("un plato ya entregado aterriza en una ronda served y conserva su hora", () => {
    expect(
      destinationRoundState(
        {
          kitchenStatus: "ready",
          servedAt: served,
          preparationStartedAt: started,
        },
        now,
      ),
    ).toEqual({
      status: "served",
      kitchenStartedAt: started,
      readyAt: served,
    });
  });

  it("servedAt gana sobre un kitchenStatus rezagado", () => {
    // Defensivo: si el item quedó servido pero su kitchenStatus nunca subió
    // a ready, igual no debe re-entrar a cocina.
    expect(
      destinationRoundState(
        {
          kitchenStatus: "placed",
          servedAt: served,
          preparationStartedAt: null,
        },
        now,
      ).status,
    ).toBe("served");
  });
});

describe("syncedTargetOrderStatus", () => {
  it("trae la orden destino para atrás cuando le cae un plato menos avanzado", () => {
    expect(syncedTargetOrderStatus("served", "placed")).toBe("placed");
    expect(syncedTargetOrderStatus("ready", "in_kitchen")).toBe("in_kitchen");
  });

  it("no toca la orden cuando el plato entrante va más adelante", () => {
    expect(syncedTargetOrderStatus("placed", "served")).toBeNull();
    expect(syncedTargetOrderStatus("in_kitchen", "ready")).toBeNull();
  });

  it("no toca la orden cuando ya coinciden", () => {
    expect(syncedTargetOrderStatus("placed", "placed")).toBeNull();
  });

  it("una orden abierta se alinea con la ronda entrante", () => {
    expect(syncedTargetOrderStatus("open", "ready")).toBe("ready");
  });

  it("nunca pisa el status de una cuenta en cobro o cerrada", () => {
    for (const s of ["paying", "paid", "cancelled"] as const) {
      expect(syncedTargetOrderStatus(s, "placed")).toBeNull();
    }
  });
});
