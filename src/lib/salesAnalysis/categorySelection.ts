type Category = { id: string; parentId: string | null };

// La carta admite dos niveles. Guardamos las elecciones explícitas en la URL
// y expandimos los padres antes de consultar ventas o filtrar platos.
export function categorySelection(categories: Category[], ids: readonly string[] = []) {
  const selected = new Set(ids);
  const explicit: string[] = [];
  const included = new Set<string>();
  for (const { id, parentId } of categories) {
    const inherited = parentId !== null && selected.has(parentId);
    if (inherited || selected.has(id)) included.add(id);
    if (!inherited && selected.has(id)) explicit.push(id);
  }
  return { explicit, included };
}
