/**
 * Árbol del PUC para los reportes jerárquicos (balance de prueba y, más
 * adelante, los estados financieros). Portado de zenith
 * (`statement-tree-model.ts` + `balance-prueba/trial-balance-model.ts`),
 * generalizado a N columnas de valor para que el MISMO árbol sirva a un
 * estado de una cifra y a un balance de cuatro.
 *
 * ── LA REGLA QUE NO SE PUEDE ROMPER ─────────────────────────────────────
 * Esto es PRESENTACIÓN. Las hojas son las cuentas con saldo tal como las
 * devuelve la consulta; cada nodo agregado vale, por construcción, la SUMA
 * EXACTA de sus hojas (columna a columna). Se prueba en `pucTree.test.ts`.
 *
 * Jerarquía por longitud de código (Decreto 2650): clase 1 dígito, grupo 2,
 * cuenta 4, subcuenta 6; MESAPAY además usa auxiliares de 8 (IVA por
 * tarifa) que se agregan en su subcuenta cuando el nivel máximo es 6.
 * Una cuenta con movimiento cuyo código coincide con un nivel (p. ej. una
 * hoja de 4 dígitos) ES ese nodo: su nombre viene de la cuenta y su valor
 * incluye el suyo propio más el de las hojas más profundas, si las hay.
 */

/** Nombres de respaldo de las clases del PUC si el plan no las trae. */
export const CLASE_FALLBACK: Record<string, string> = {
  "1": "Activo",
  "2": "Pasivo",
  "3": "Patrimonio",
  "4": "Ingresos",
  "5": "Gastos",
  "6": "Costos de ventas",
  "7": "Costos de producción o de operación",
  "8": "Cuentas de orden deudoras",
  "9": "Cuentas de orden acreedoras",
};

/** Longitudes de código que forman nivel: clase, grupo, cuenta, subcuenta. */
export const PUC_LEVELS = [1, 2, 4, 6] as const;

export type PucLeaf = {
  code: string;
  name: string;
  /** Una cifra por columna (en centavos, firmadas). */
  values: number[];
};

export type PucNode = {
  /** Llave estable para el plegado (= el código del prefijo). */
  key: string;
  code: string;
  name: string;
  /** 0 = clase, 1 = grupo, 2 = cuenta, 3 = subcuenta… (índice del nivel). */
  depth: number;
  values: number[];
  children: PucNode[];
};

/** Renglón ya aplanado, listo para pintar. */
export type FlatRow = Omit<PucNode, "children"> & {
  /** Llaves de los ancestros, de la raíz hacia dentro. */
  ancestors: string[];
  hasChildren: boolean;
};

export function fallbackName(prefix: string): string {
  return prefix.length === 1 ? (CLASE_FALLBACK[prefix] ?? "") : "";
}

function addInto(target: number[], values: number[]): void {
  for (let i = 0; i < values.length; i++) {
    target[i] = (target[i] ?? 0) + (values[i] ?? 0);
  }
}

/**
 * Prefijos de código que el árbol necesita rotular, dado el juego de hojas
 * (para pedir solo esos nombres al plan de cuentas).
 */
export function pucParentCodes(
  codes: readonly string[],
  levels: readonly number[] = PUC_LEVELS,
): string[] {
  const out = new Set<string>();
  for (const code of codes) {
    for (const len of levels) {
      if (code.length >= len) out.add(code.slice(0, len));
    }
  }
  return [...out].sort();
}

/**
 * Árbol PUC de un juego de hojas. Las hojas se ordenan por código; los
 * nodos se crean por prefijo en cada nivel de `levels` (ascendente) y una
 * hoja más larga que el último nivel se AGREGA en su último prefijo (no se
 * muestra por debajo del nivel máximo pedido).
 */
export function buildPucTree(
  leaves: readonly PucLeaf[],
  {
    levels = PUC_LEVELS,
    names = {},
  }: {
    /** Longitudes de código que forman nivel (p. ej. `[1, 2, 4]` para ver hasta cuenta). */
    levels?: readonly number[];
    /** Nombres del plan de cuentas por código (prefijos incluidos). */
    names?: Record<string, string>;
  } = {},
): PucNode[] {
  const sortedLevels = [...levels].sort((a, b) => a - b);
  const sortedLeaves = [...leaves].sort((a, b) => a.code.localeCompare(b.code));
  const roots: PucNode[] = [];
  const byCode = new Map<string, PucNode>();

  for (const leaf of sortedLeaves) {
    let bucket = roots;
    let depth = 0;
    for (const len of sortedLevels) {
      if (leaf.code.length < len) break;
      const prefix = leaf.code.slice(0, len);
      let node = byCode.get(prefix);
      if (!node) {
        node = {
          key: prefix,
          code: prefix,
          name: names[prefix] ?? (leaf.code === prefix ? leaf.name : fallbackName(prefix)),
          depth,
          values: [],
          children: [],
        };
        byCode.set(prefix, node);
        bucket.push(node);
      } else if (!node.name && leaf.code === prefix) {
        node.name = leaf.name;
      }
      addInto(node.values, leaf.values);
      bucket = node.children;
      depth++;
    }
  }
  return roots;
}

/** Aplana el árbol en orden de lectura, con profundidad y ancestros. */
export function flattenTree(nodes: readonly PucNode[]): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: readonly PucNode[], ancestors: string[]) => {
    for (const n of list) {
      const { children, ...rest } = n;
      out.push({ ...rest, ancestors, hasChildren: children.length > 0 });
      if (children.length > 0) walk(children, [...ancestors, n.key]);
    }
  };
  walk(nodes, []);
  return out;
}

/** Suma de las hojas de un árbol, columna a columna (= Σ raíces). */
export function treeTotals(nodes: readonly PucNode[], columns: number): number[] {
  const totals = Array<number>(columns).fill(0);
  for (const n of nodes) addInto(totals, n.values);
  return totals;
}

/** Llaves de todos los nodos que se pueden desplegar. */
export function expandableKeys(rows: readonly FlatRow[]): string[] {
  return rows.filter((r) => r.hasChildren).map((r) => r.key);
}

/** Estado de plegado: conjunto de llaves abiertas, o TODO abierto. */
export type Expansion = "all" | ReadonlySet<string>;

export const ALL_EXPANDED = "*";
export const DEFAULT_EXPANSION: ReadonlySet<string> = new Set<string>();

/** `?abrir=`: `*` = todo; lista separada por comas = esas ramas; vacío = default. */
export function parseExpansion(raw: string | undefined | null): Expansion {
  if (!raw) return DEFAULT_EXPANSION;
  if (raw === ALL_EXPANDED) return "all";
  return new Set(raw.split(",").filter(Boolean));
}

/** Estado de plegado para la URL (null = el estado por defecto). */
export function serializeExpansion(expanded: Expansion): string | null {
  if (expanded === "all") return ALL_EXPANDED;
  const keys = [...expanded].filter(Boolean).sort();
  return keys.length ? keys.join(",") : null;
}

/** ¿Se ve el renglón? Solo si TODOS sus ancestros están desplegados. */
export function isRowVisible(row: FlatRow, expanded: Expansion): boolean {
  if (expanded === "all") return true;
  return row.ancestors.every((k) => expanded.has(k));
}
