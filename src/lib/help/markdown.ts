/**
 * Markdown reducido de los artículos de ayuda.
 *
 * El contenido lo escribimos nosotros, pero igual se trata como texto no
 * confiable: este módulo lo convierte en un árbol de datos (sin HTML) y el
 * renderizador (`src/components/help/HelpMarkdown.tsx`) lo pinta con
 * elementos de React, que escapan todo el texto. Nunca hay
 * `dangerouslySetInnerHTML`: un `<script>` en un artículo sale como texto.
 *
 * Lo que se entiende (y nada más):
 *
 *   párrafos              líneas seguidas, separadas por una línea en blanco
 *   ## Subtítulo          nivel 2 (entra en el índice del artículo)
 *   ### Subtítulo         nivel 3
 *   - punto               lista con viñetas
 *   1. paso               pasos numerados
 *   **negrita**           nombres de botones y menús
 *   `código`              texto para escribir tal cual
 *   ```                   bloque de comandos (p. ej. de Windows), sin formato
 *   [texto](/ruta)        enlace, SÓLO a rutas internas que empiezan con "/"
 *   > texto               aviso de consejo
 *   > ⚠ texto             aviso de advertencia
 *
 * Una línea con dos o más espacios al principio, justo después de un punto
 * de una lista, continúa ese punto.
 *
 * Es puro (sin React ni DB) para poder testearlo y para que lo usen igual el
 * renderizador, el índice del buscador y los tests de contenido.
 */

export type HelpInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: HelpInline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: HelpInline[] };

export type HelpBlock =
  | {
      type: "heading";
      level: 2 | 3;
      id: string;
      text: string;
      children: HelpInline[];
    }
  | { type: "paragraph"; children: HelpInline[] }
  | { type: "list"; ordered: boolean; start: number; items: HelpInline[][] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "callout"; tone: "tip" | "warning"; children: HelpInline[] };

export type HelpHeading = { id: string; text: string; level: 2 | 3 };

/**
 * ¿Es un enlace a una pantalla de MESAPAY? Tiene que empezar con una sola
 * "/" (así "//otro-sitio.com" no pasa) y no puede traer espacios, comillas
 * ni barras invertidas. Todo lo demás (http:, mailto:, javascript:…) se
 * pinta como texto.
 */
export function isInternalHref(href: string): boolean {
  return /^\/(?!\/)[^\s"'<>\\]*$/.test(href);
}

/* ───────────────────────────── En línea ───────────────────────────── */

type InlineOptions = { allowLinks: boolean };

/** Texto en línea → nodos. Nunca falla: lo que no cierra queda como texto. */
export function parseInline(
  text: string,
  opts: InlineOptions = { allowLinks: true },
): HelpInline[] {
  const out: HelpInline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ type: "text", value: buf });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    if (rest.startsWith("`")) {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (rest.startsWith("**")) {
      const end = findClosingBold(text, i + 2);
      if (end > i + 2) {
        flush();
        out.push({
          type: "strong",
          children: parseInline(text.slice(i + 2, end), opts),
        });
        i = end + 2;
        continue;
      }
    }

    if (rest.startsWith("[")) {
      const link = matchLink(text, i);
      if (link) {
        flush();
        const children = parseInline(link.label, { allowLinks: false });
        if (opts.allowLinks && isInternalHref(link.href)) {
          out.push({ type: "link", href: link.href, children });
        } else {
          // Enlace externo (o anidado): se conserva el texto, sin enlace.
          out.push(...children);
        }
        i = link.end;
        continue;
      }
    }

    buf += text[i];
    i += 1;
  }
  flush();
  return mergeText(out);
}

/** Cierre de `**`, saltando los `código` que haya en el medio. */
function findClosingBold(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("**", i)) return i;
    i += 1;
  }
  return -1;
}

function matchLink(
  text: string,
  start: number,
): { label: string; href: string; end: number } | null {
  const close = text.indexOf("](", start + 1);
  if (close < 0) return null;
  const label = text.slice(start + 1, close);
  if (!label || label.includes("[")) return null;
  const hrefEnd = text.indexOf(")", close + 2);
  if (hrefEnd < 0) return null;
  const href = text.slice(close + 2, hrefEnd).trim();
  if (!href) return null;
  return { label, href, end: hrefEnd + 1 };
}

function mergeText(nodes: HelpInline[]): HelpInline[] {
  const out: HelpInline[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text") {
      out[out.length - 1] = { type: "text", value: last.value + n.value };
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Texto plano de una lista de nodos en línea. */
export function inlineText(nodes: HelpInline[]): string {
  return nodes
    .map((n) =>
      n.type === "text" || n.type === "code" ? n.value : inlineText(n.children),
    )
    .join("");
}

/* ───────────────────────────── Bloques ───────────────────────────── */

const ORDERED_RE = /^(\d{1,3})\.\s+(.*)$/;
const WARNING_RE = /^⚠️?\s*/;

/** Id estable para el ancla de un subtítulo: "Cómo cobrar" → "como-cobrar". */
export function slugifyHeading(text: string): string {
  const s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "seccion";
}

export function parseHelpMarkdown(source: string): HelpBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: HelpBlock[] = [];
  const usedIds = new Map<string, number>();

  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let callout: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map((it) => parseInline(it)),
      });
    }
    list = null;
  };
  const flushCallout = () => {
    if (callout.length) {
      const first = callout[0];
      const tone = WARNING_RE.test(first) ? "warning" : "tip";
      const text = [first.replace(WARNING_RE, ""), ...callout.slice(1)].join(" ");
      blocks.push({ type: "callout", tone, children: parseInline(text.trim()) });
    }
    callout = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushCallout();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Bloque de código: se copia tal cual hasta el cierre.
    if (line.startsWith("```")) {
      flushAll();
      const lang = line.slice(3).trim() || null;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "```") {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", lang, value: body.join("\n") });
      continue;
    }

    if (!line) {
      flushAll();
      continue;
    }

    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const text = heading[2].trim();
      const children = parseInline(text);
      const plain = inlineText(children);
      const base = slugifyHeading(plain);
      const n = (usedIds.get(base) ?? 0) + 1;
      usedIds.set(base, n);
      blocks.push({
        type: "heading",
        level: heading[1].length as 2 | 3,
        id: n === 1 ? base : `${base}-${n}`,
        text: plain,
        children,
      });
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      callout.push(line.replace(/^>\s?/, ""));
      continue;
    }
    flushCallout();

    if (line.startsWith("- ")) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, start: 1, items: [] };
      }
      list.items.push(line.slice(2).trim());
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, start: Number(ordered[1]), items: [] };
      }
      list.items.push(ordered[2].trim());
      continue;
    }

    // Continuación de un punto de la lista (línea con sangría).
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += " " + line;
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushAll();
  return blocks;
}

/* ───────────────────────────── Derivados ───────────────────────────── */

/** Subtítulos del artículo, para su índice. */
export function helpHeadings(blocks: HelpBlock[]): HelpHeading[] {
  return blocks.flatMap((b) =>
    b.type === "heading" ? [{ id: b.id, text: b.text, level: b.level }] : [],
  );
}

/**
 * Texto plano del cuerpo, para el buscador. Los subtítulos van aparte (pesan
 * más en el ranking), así que por defecto no se incluyen.
 */
export function helpPlainText(
  blocks: HelpBlock[],
  opts: { includeHeadings?: boolean } = {},
): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading") {
      if (opts.includeHeadings) parts.push(b.text);
    } else if (b.type === "list") {
      for (const it of b.items) parts.push(inlineText(it));
    } else if (b.type === "code") {
      parts.push(b.value);
    } else {
      parts.push(inlineText(b.children));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Todos los enlaces internos del cuerpo (los que se pintan como enlace). */
export function helpLinks(blocks: HelpBlock[]): string[] {
  const out: string[] = [];
  const walk = (nodes: HelpInline[]) => {
    for (const n of nodes) {
      if (n.type === "link") out.push(n.href);
      if (n.type === "strong" || n.type === "link") walk(n.children);
    }
  };
  for (const b of blocks) {
    if (b.type === "list") b.items.forEach(walk);
    else if (b.type !== "code") walk(b.children);
  }
  return out;
}

/**
 * Problemas de formato de un cuerpo de artículo. Vacío = está bien. Lo usan
 * los tests de contenido para que un artículo mal escrito rompa la CI en vez
 * de verse raro en producción.
 */
export function validateHelpMarkdown(source: string): string[] {
  const problems: string[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let inCode = false;
  let firstBlock: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inCode = !inCode;
      firstBlock ??= "code";
      continue;
    }
    if (inCode || !line) continue;

    if (firstBlock === null) {
      firstBlock = /^#{1,6}\s/.test(line)
        ? "heading"
        : line.startsWith(">")
          ? "callout"
          : /^(- |\d{1,3}\.\s)/.test(line)
            ? "list"
            : "paragraph";
    }

    if (/^#\s/.test(line)) problems.push(`título de nivel 1 no permitido: "${line}"`);
    if (/^#{4,}\s/.test(line)) problems.push(`subtítulo de nivel 4+ no permitido: "${line}"`);
    if (/^[*+]\s/.test(line)) problems.push(`usa "- " para las viñetas: "${line}"`);

    const withoutCode = line.replace(/`[^`]*`/g, "");
    if (/<\/?[a-zA-Z][^>]*>/.test(withoutCode)) {
      problems.push(`HTML no permitido: "${line}"`);
    }
    if ((withoutCode.match(/\*\*/g) ?? []).length % 2 !== 0) {
      problems.push(`negrita sin cerrar: "${line}"`);
    }
    for (const m of withoutCode.matchAll(/\[([^\]]+)\]\(([^)]*)\)/g)) {
      if (!isInternalHref(m[2].trim())) {
        problems.push(`enlace no interno (debe empezar con "/"): "${m[0]}"`);
      }
    }
  }
  if (inCode) problems.push("bloque de código sin cerrar (```)");
  if (firstBlock === null) problems.push("el cuerpo está vacío");
  else if (firstBlock !== "paragraph") {
    problems.push("el artículo tiene que arrancar con un párrafo que diga para qué sirve");
  }
  return problems;
}
