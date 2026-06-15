// Tipos compartidos del editor de carta. Viven acá para que MenuEditor y los
// componentes de acciones masivas (BulkActions) usen UNA sola definición y no
// se desincronicen.

export type CategoryKind =
  | "starter"
  | "main"
  | "side"
  | "drink"
  | "dessert"
  | "other";

export type PrepStation = "kitchen" | "bar" | "counter";

export type Cat = {
  id: string;
  label: string;
  slug: string;
  kind: CategoryKind;
  prepStation: PrepStation;
  menuId: string;
  // Subcategoría: id de la categoría padre (top-level) o null si es de nivel
  // superior. Un solo nivel de anidamiento.
  parentId: string | null;
};

export type MenuRef = { id: string; label: string; slug: string };

export type ModOpt = { label: string; priceDeltaCents?: number };

export type ModifierDef = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: ModOpt[];
  default?: string;
};

export type Item = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  available: boolean;
  photoUrl: string | null;
  tags: string[];
  modifiers: ModifierDef[];
  prepMinutes: number;
  prepStation: PrepStation | null;
};
