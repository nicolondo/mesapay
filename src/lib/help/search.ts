/**
 * Buscador del centro de ayuda: puro, sin dependencias, corre en el cliente.
 *
 * El índice lo arma el servidor (`buildHelpSearchIndex`) sólo para el idioma
 * activo y lo manda a la portada de la ayuda. Acá se normaliza, se rankea y
 * se arman los fragmentos resaltados.
 *
 * Reglas:
 *  - Sin tildes, mayúsculas ni eñe: "factura electronica" encuentra
 *    "Factura electrónica"; "contrasena" encuentra "contraseña".
 *  - Peso por campo: título > palabras clave > subtítulos > resumen > cuerpo.
 *  - Una palabra de la búsqueda coincide con una del texto si es igual, si es
 *    el comienzo ("fact" → "factura") o, con 5 letras o más, si difiere en una
 *    sola letra (falta, sobra, cambia o están dos al revés).
 *  - Primero salen los artículos que tienen TODAS las palabras. Si ninguno
 *    las tiene, salen los que tienen la mayoría, marcados como parciales.
 */

/** Lo que manda el servidor por artículo. Claves cortas: viaja al cliente. */
export type HelpIndexEntry = {
  /** id de la categoría */
  c: string;
  /** slug */
  s: string;
  /** título */
  t: string;
  /** resumen */
  m: string;
  /** palabras clave, separadas por " · " */
  k: string;
  /** subtítulos, separados por " · " */
  h: string;
  /** cuerpo en texto plano */
  b: string;
};

export type HighlightRange = [start: number, end: number];

export type HelpSearchResult = {
  entry: HelpIndexEntry;
  score: number;
  /** No tiene todas las palabras de la búsqueda. */
  partial: boolean;
  titleRanges: HighlightRange[];
  snippet: { text: string; ranges: HighlightRange[] };
};

/* ─────────────────────────── Normalización ─────────────────────────── */

/**
 * Normaliza carácter por carácter (minúsculas, sin tildes ni eñe) y guarda
 * de qué posición del original salió cada carácter, para poder resaltar
 * sobre el texto original lo que coincidió en el normalizado.
 */
export function normalizeWithMap(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const n = text[i]
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
    for (let j = 0; j < n.length; j++) {
      out += n[j];
      map.push(i);
    }
  }
  return { text: out, map };
}

export function normalizeForSearch(text: string): string {
  return normalizeWithMap(text).text;
}

type Word = { w: string; start: number; end: number };

const WORD_RE = /[a-z0-9]+/g;

function words(normalized: string): Word[] {
  const out: Word[] = [];
  for (const m of normalized.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    out.push({ w: m[0], start, end: start + m[0].length });
  }
  return out;
}

/**
 * Palabras que no ayudan a encontrar nada ("cómo hago para cerrar el turno"
 * busca "cerrar" y "turno"). Ya normalizadas. Si la búsqueda es sólo de
 * estas palabras, se usan igual.
 */
const STOPWORDS = new Set([
  // es
  "de", "del", "la", "las", "el", "los", "un", "una", "unos", "unas", "y",
  "o", "a", "al", "en", "con", "por", "para", "que", "como", "se", "mi",
  "mis", "tu", "tus", "su", "sus", "lo", "le", "les", "es", "me", "hay",
  "cual", "donde", "cuando", "hago", "hacer", "puedo", "quiero",
  // en
  "the", "an", "of", "to", "in", "on", "for", "and", "or", "how", "do",
  "i", "my", "is", "can", "what", "where", "with", "does",
  // pt
  "da", "do", "das", "dos", "os", "as", "um", "uma", "e", "em", "no",
  "na", "com", "meu", "minha", "eu", "posso", "fazer", "onde",
]);

/** Palabras de la búsqueda, normalizadas, sin repetir y sin relleno. */
export function queryTokens(query: string): string[] {
  const all = [...new Set(words(normalizeForSearch(query)).map((w) => w.w))];
  const useful = all.filter((w) => !STOPWORDS.has(w));
  return useful.length > 0 ? useful : all;
}

/* ─────────────────────────── Coincidencias ─────────────────────────── */

/**
 * Distancia de edición con transposiciones (dos letras al revés cuentan
 * como un solo error). Corta apenas supera `max`: devuelve `max + 1`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const EXACT = 1;
const PREFIX = 0.75;
const FUZZY = 0.55;
const FUZZY_PREFIX = 0.45;

/**
 * Qué tan bien coincide una palabra de la búsqueda con una del texto
 * (0 = nada) y cuántas letras del texto resaltar.
 */
function matchWord(token: string, word: string): { q: number; len: number } {
  if (word === token) return { q: EXACT, len: word.length };
  if (token.length >= 2 && word.startsWith(token)) {
    return { q: PREFIX, len: token.length };
  }
  if (token.length >= 5 && word.length >= 4) {
    if (editDistance(token, word, 1) <= 1) return { q: FUZZY, len: word.length };
    if (word.length > token.length) {
      for (const len of [token.length - 1, token.length, token.length + 1]) {
        if (len >= 4 && len < word.length && editDistance(token, word.slice(0, len), 1) <= 1) {
          return { q: FUZZY_PREFIX, len };
        }
      }
    }
  }
  return { q: 0, len: 0 };
}

/* ───────────────────────────── Índice ───────────────────────────── */

const FIELDS = ["t", "k", "h", "m", "b"] as const;
type Field = (typeof FIELDS)[number];

/** Peso de cada campo en el ranking. */
export const FIELD_WEIGHTS: Record<Field, number> = { t: 10, k: 7, h: 5, m: 3, b: 1 };

/** Bonus cuando la frase entera aparece tal cual en el campo. */
const PHRASE_BONUS: Record<Field, number> = { t: 8, k: 5, h: 4, m: 3, b: 1.5 };

type PreparedField = { text: string; unique: string[] };

export type PreparedHelpEntry = {
  entry: HelpIndexEntry;
  fields: Record<Field, PreparedField>;
};

/** Normaliza el índice una sola vez (no en cada tecla). */
export function prepareHelpIndex(entries: HelpIndexEntry[]): PreparedHelpEntry[] {
  return entries.map((entry) => {
    const fields = {} as Record<Field, PreparedField>;
    for (const f of FIELDS) {
      const text = normalizeForSearch(entry[f]);
      fields[f] = { text, unique: [...new Set(words(text).map((w) => w.w))] };
    }
    return { entry, fields };
  });
}

/** Cuánto suman, además del mejor, los otros campos donde aparece la palabra. */
const OTHER_FIELDS_FACTOR = 0.2;

/**
 * Puntaje de una palabra de la búsqueda en un artículo: el del mejor campo
 * más una parte de los demás, así un artículo que la tiene en el título Y en
 * las palabras clave gana a uno que sólo la tiene en el título.
 */
function tokenScore(p: PreparedHelpEntry, token: string): number {
  let best = 0;
  let sum = 0;
  for (const f of FIELDS) {
    let fieldBest = 0;
    for (const w of p.fields[f].unique) {
      const { q } = matchWord(token, w);
      if (q > fieldBest) {
        fieldBest = q;
        if (q === EXACT) break;
      }
    }
    const s = FIELD_WEIGHTS[f] * fieldBest;
    sum += s;
    best = Math.max(best, s);
  }
  return best + OTHER_FIELDS_FACTOR * (sum - best);
}

export function searchHelp(
  prepared: PreparedHelpEntry[],
  query: string,
  opts: { limit?: number } = {},
): HelpSearchResult[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const phrase = tokens.length > 1 ? tokens.join(" ") : null;

  const scored = prepared.map((p) => {
    let score = 0;
    let matched = 0;
    for (const token of tokens) {
      const s = tokenScore(p, token);
      if (s > 0) {
        matched += 1;
        score += s;
      }
    }
    if (phrase) {
      for (const f of FIELDS) {
        if (p.fields[f].text.includes(phrase)) score += PHRASE_BONUS[f];
      }
    }
    return { p, score, matched };
  });

  let hits = scored.filter((r) => r.matched === tokens.length);
  let partial = false;
  if (hits.length === 0 && tokens.length > 1) {
    const min = Math.max(1, Math.ceil(tokens.length / 2));
    hits = scored.filter((r) => r.matched >= min);
    partial = true;
  }

  hits.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      a.p.entry.t.localeCompare(b.p.entry.t),
  );

  return hits.slice(0, opts.limit ?? 50).map(({ p, score }) => ({
    entry: p.entry,
    score,
    partial,
    titleRanges: highlightRanges(p.entry.t, tokens),
    snippet: makeSnippet(p, tokens),
  }));
}

/* ───────────────────────── Resaltado y fragmento ───────────────────────── */

/** Tramos del texto ORIGINAL que coinciden con alguna palabra de la búsqueda. */
export function highlightRanges(text: string, tokens: string[]): HighlightRange[] {
  const { text: norm, map } = normalizeWithMap(text);
  const ranges: HighlightRange[] = [];
  for (const w of words(norm)) {
    let len = 0;
    for (const t of tokens) len = Math.max(len, matchWord(t, w.w).len);
    if (len > 0) {
      const start = map[w.start];
      const lastNorm = w.start + len - 1;
      const end = map[lastNorm] + 1;
      ranges.push([start, end]);
    }
  }
  return ranges;
}

const SNIPPET_LEN = 170;
const SNIPPET_LEAD = 50;

/**
 * Fragmento del cuerpo alrededor de la primera coincidencia, o el resumen si
 * la coincidencia está sólo en el título o en las palabras clave.
 */
function makeSnippet(
  p: PreparedHelpEntry,
  tokens: string[],
): { text: string; ranges: HighlightRange[] } {
  const body = p.entry.b;
  const bodyRanges = highlightRanges(body, tokens);
  if (bodyRanges.length === 0) {
    const summary = p.entry.m;
    return { text: summary, ranges: highlightRanges(summary, tokens) };
  }

  const first = bodyRanges[0][0];
  let start = Math.max(0, first - SNIPPET_LEAD);
  if (start > 0) {
    const space = body.indexOf(" ", start);
    start = space >= 0 && space < first ? space + 1 : start;
  }
  let end = Math.min(body.length, start + SNIPPET_LEN);
  if (end < body.length) {
    const space = body.lastIndexOf(" ", end);
    if (space > first) end = space;
  }

  const prefix = start > 0 ? "… " : "";
  const suffix = end < body.length ? " …" : "";
  const text = prefix + body.slice(start, end) + suffix;
  const shift = prefix.length - start;
  const ranges = bodyRanges
    .filter(([s, e]) => s >= start && e <= end)
    .map(([s, e]) => [s + shift, e + shift] as HighlightRange);
  return { text, ranges };
}

/** Parte un texto en tramos normales y resaltados, para pintarlo. */
export function splitHighlights(
  text: string,
  ranges: HighlightRange[],
): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s < pos) continue;
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/* ───────────────────────────── Agrupado ───────────────────────────── */

export type HelpResultGroup = { category: string; results: HelpSearchResult[] };

/**
 * Agrupa por categoría. Los grupos salen en el orden de su mejor resultado,
 * así lo más relevante queda arriba aunque sea de la última categoría.
 */
export function groupResults(results: HelpSearchResult[]): HelpResultGroup[] {
  const groups = new Map<string, HelpSearchResult[]>();
  for (const r of results) {
    const list = groups.get(r.entry.c) ?? [];
    list.push(r);
    groups.set(r.entry.c, list);
  }
  return [...groups.entries()].map(([category, list]) => ({ category, results: list }));
}

/* ───────────────────────────── Sugerencias ───────────────────────────── */

/**
 * "¿Quisiste decir…?": cambia cada palabra que no aparece en ningún lado por
 * la más parecida del vocabulario de títulos, palabras clave y subtítulos
 * (hasta dos letras de diferencia). Devuelve la búsqueda corregida sólo si
 * encuentra algo; si no, null.
 */
export function suggestQuery(prepared: PreparedHelpEntry[], query: string): string | null {
  if (queryTokens(query).length === 0) return null;

  // Vocabulario normalizado → cómo se escribe de verdad ("electronica" →
  // "electrónica"), para sugerir la palabra con sus tildes.
  const vocabulary = new Map<string, string>();
  for (const p of prepared) {
    for (const f of ["t", "k", "h"] as const) {
      const original = p.entry[f];
      const { text, map } = normalizeWithMap(original);
      for (const w of words(text)) {
        if (w.w.length < 4 || vocabulary.has(w.w)) continue;
        vocabulary.set(w.w, original.slice(map[w.start], map[w.end - 1] + 1).toLowerCase());
      }
    }
  }

  // Se corrige sobre lo que escribió la persona, palabra por palabra: lo que
  // ya se encuentra queda igual (con sus tildes o sin ellas).
  const { text: norm, map } = normalizeWithMap(query);
  let out = "";
  let pos = 0;
  let changed = false;
  for (const w of words(norm)) {
    if (w.w.length < 4 || STOPWORDS.has(w.w)) continue;
    if (prepared.some((p) => tokenScore(p, w.w) > 0)) continue;
    const max = w.w.length >= 6 ? 2 : 1;
    let best: string | null = null;
    let bestDist = max + 1;
    for (const v of vocabulary.keys()) {
      const d = editDistance(w.w, v, max);
      if (d < bestDist || (d === bestDist && best !== null && v < best)) {
        best = v;
        bestDist = d;
      }
    }
    if (best === null || bestDist > max) continue;
    const start = map[w.start];
    const end = map[w.end - 1] + 1;
    out += query.slice(pos, start) + vocabulary.get(best);
    pos = end;
    changed = true;
  }
  if (!changed) return null;
  const suggestion = (out + query.slice(pos)).trim();
  return searchHelp(prepared, suggestion, { limit: 1 }).length > 0 ? suggestion : null;
}
