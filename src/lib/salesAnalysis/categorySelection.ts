type Category = { id: string; parentId: string | null };

// La carta admite dos niveles. Guardamos las elecciones explícitas en la URL
// y expandimos los padres antes de consultar ventas o filtrar platos.
export function categorySelection(categories: Category[], ids: readonly string[] = []) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const selected = new Set(ids.filter((id) => byId.has(id)));
  // Conserva el orden de la URL al descartar las hijas cubiertas por su padre.
  const explicit = [...selected].filter((id) => !selected.has(byId.get(id)!.parentId ?? ""));
  const included = new Set<string>();
  for (const { id, parentId } of categories) {
    const inherited = parentId !== null && selected.has(parentId);
    if (inherited || selected.has(id)) included.add(id);
  }
  return { explicit, included };
}
