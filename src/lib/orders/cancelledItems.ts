/**
 * Platos cancelados de UNA cuenta, para el desplegable «Platos cancelados»
 * de la ficha de la mesa y del detalle de la orden en el historial.
 *
 * Un plato sale de la cuenta por dos caminos, y los dos cuentan aquí:
 *
 *  - Uno a uno (`OrderItem.cancelledAt`): «Cancelar» o «No cobrar» desde la
 *    ficha (`cancellationKind` "cancel" | "comp"; null es "cancel" por
 *    compatibilidad), cancelar la cuenta completa o la cortesía de toda la
 *    cuenta.
 *  - Por su ronda (`Round.status = "cancelled"`): cancelar una ronda entera
 *    NO estampa sus platos, así que la hora, quién y el motivo salen de la
 *    ronda.
 *
 * Si un plato tiene las dos marcas (p. ej. se canceló su ronda y después se
 * canceló la cuenta completa, que estampa TODOS los platos), vale la que pasó
 * primero — el mismo criterio que el reporte de productos no cobrados
 * (`ITEM_IS_FIRST` en src/lib/reports/serviceAdjustmentsQuery.ts).
 *
 * Es informativo: nada de esto se suma a ningún total. Módulo puro (sin
 * base de datos) para poder usarlo desde el cliente y probarlo; la consulta
 * vive en `cancelledItemsQuery.ts`.
 */

/** «cancel» y «comp» son del plato; «round» = se canceló su ronda entera. */
export type CancelledItemKind = "cancel" | "comp" | "round";

/**
 * Quién lo canceló:
 *  - `staff`: el correo es de un usuario del personal de ESTE comercio y
 *    tiene nombre.
 *  - `email`: no se pudo resolver a un nombre (otro rol, usuario sin nombre o
 *    borrado): se muestra el correo tal cual quedó registrado.
 *  - `unknown`: no quedó registrado ningún usuario (filas viejas o cambios
 *    que hizo el sistema). El comensal nunca aparece: lo que él quita antes
 *    de que la cocina lo toque se borra, no se cancela.
 */
export type CancelledItemActor =
  | { type: "staff"; name: string; email: string }
  | { type: "email"; email: string }
  | { type: "unknown" };

export type CancelledItemView = {
  id: string;
  name: string;
  qty: number;
  /** Precio × cantidad al momento del pedido. Informativo: no suma a nada. */
  amountCents: number;
  /** ISO. null sólo en rondas viejas canceladas sin hora registrada. */
  cancelledAt: string | null;
  kind: CancelledItemKind;
  /** Ronda del plato; null en los cargos o servicios (no van en rondas). */
  roundSeq: number | null;
  reason: string | null;
  actor: CancelledItemActor;
};

export type CancelledItemSourceItem = {
  id: string;
  roundId: string | null;
  nameSnapshot: string;
  qty: number;
  priceCentsSnapshot: number;
  cancelledAt: Date | null;
  cancelledByEmail: string | null;
  cancellationReason: string | null;
  cancellationKind: string | null;
};

export type CancelledItemSourceRound = {
  id: string;
  seq: number;
  status: string;
  cancelledAt: Date | null;
  cancelledByEmail: string | null;
  cancellationReason: string | null;
};

/** Usuario del personal del comercio, para pasar de correo a nombre. */
export type StaffDirectoryEntry = { email: string; name: string | null };

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * ¿El plato ya no cuenta en la cuenta? Cancelado uno a uno o porque se
 * canceló su ronda. Es la misma regla que usan el subtotal, la cocina y el
 * cobro, y la que separa «platos de la cuenta» de «platos cancelados».
 */
export function isCancelledLine(
  item: Pick<CancelledItemSourceItem, "cancelledAt" | "roundId">,
  round: Pick<CancelledItemSourceRound, "status"> | null | undefined,
): boolean {
  return item.cancelledAt !== null || round?.status === "cancelled";
}

/**
 * Correos que hay que resolver a nombre: los de los platos cancelados y los
 * de las rondas canceladas, sin repetir (sin distinguir mayúsculas) y tal
 * como quedaron guardados, para buscarlos por igualdad exacta.
 */
export function cancellationEmails(
  items: Pick<CancelledItemSourceItem, "cancelledByEmail">[],
  rounds: Pick<CancelledItemSourceRound, "status" | "cancelledByEmail">[],
): string[] {
  const byKey = new Map<string, string>();
  const add = (email: string | null) => {
    const value = clean(email);
    if (value && !byKey.has(value.toLowerCase())) byKey.set(value.toLowerCase(), value);
  };
  for (const item of items) add(item.cancelledByEmail);
  for (const round of rounds) if (round.status === "cancelled") add(round.cancelledByEmail);
  return [...byKey.values()];
}

function resolveActor(
  email: string | null,
  namesByEmail: Map<string, string | null>,
): CancelledItemActor {
  const value = clean(email);
  if (!value) return { type: "unknown" };
  const name = clean(namesByEmail.get(value.toLowerCase()));
  return name ? { type: "staff", name, email: value } : { type: "email", email: value };
}

/**
 * Arma la lista del desplegable: un renglón por plato cancelado (suelto o de
 * una ronda cancelada), ordenados por la hora de la cancelación — los de la
 * misma hora, por ronda y en el orden en que llegaron. `staff` debe venir ya
 * filtrado al comercio de la cuenta: un correo que no esté ahí se muestra
 * como correo.
 */
export function buildCancelledItems({
  items,
  rounds,
  staff,
}: {
  items: CancelledItemSourceItem[];
  rounds: CancelledItemSourceRound[];
  staff: StaffDirectoryEntry[];
}): CancelledItemView[] {
  const roundsById = new Map(rounds.map((round) => [round.id, round]));
  const namesByEmail = new Map<string, string | null>();
  for (const entry of staff) {
    const key = clean(entry.email)?.toLowerCase();
    // Nunca pisar un nombre con un vacío si llegara repetido.
    if (key && !clean(namesByEmail.get(key))) namesByEmail.set(key, entry.name);
  }

  const rows: { view: CancelledItemView; at: number | null; index: number }[] = [];
  items.forEach((item, index) => {
    const round = item.roundId ? roundsById.get(item.roundId) : undefined;
    if (!isCancelledLine(item, round)) return;
    const roundCancelledAt = round?.status === "cancelled" ? round.cancelledAt : null;
    // Lo que pasó primero: el plato suelto o su ronda entera.
    const byRound =
      round?.status === "cancelled" &&
      (item.cancelledAt === null ||
        (roundCancelledAt !== null && roundCancelledAt.getTime() < item.cancelledAt.getTime()));
    const at = byRound ? roundCancelledAt : item.cancelledAt;
    const view: CancelledItemView = {
      id: item.id,
      name: item.nameSnapshot,
      qty: item.qty,
      amountCents: item.priceCentsSnapshot * item.qty,
      cancelledAt: at ? at.toISOString() : null,
      kind: byRound ? "round" : item.cancellationKind === "comp" ? "comp" : "cancel",
      roundSeq: round?.seq ?? null,
      reason: clean(byRound ? round?.cancellationReason : item.cancellationReason),
      actor: resolveActor(byRound ? round?.cancelledByEmail ?? null : item.cancelledByEmail, namesByEmail),
    };
    rows.push({ view, at: at ? at.getTime() : null, index });
  });

  rows.sort((a, b) => {
    // Sin hora registrada, al final.
    if (a.at !== b.at) {
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return a.at - b.at;
    }
    const seqA = a.view.roundSeq ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.view.roundSeq ?? Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
    return a.index - b.index;
  });
  return rows.map((row) => row.view);
}

/**
 * Huella de lo que la ficha muestra vivo (rondas con su estado y sus platos,
 * y los cargos). Un plato sólo puede pasar a cancelado saliendo de ahí, así
 * que la ficha vuelve a pedir la lista de cancelados cuando la huella cambia
 * — al cancelar desde este equipo o cuando el refresco trae un cambio de otro.
 */
export function liveLinesSignature(
  rounds: { id: string; status: string; items: { id: string }[] }[],
  freeLines: { id: string }[],
): string {
  const roundsPart = rounds
    .map((round) => `${round.id}:${round.status}:${round.items.map((item) => item.id).join(",")}`)
    .join("|");
  return `${roundsPart}#${freeLines.map((line) => line.id).join(",")}`;
}
