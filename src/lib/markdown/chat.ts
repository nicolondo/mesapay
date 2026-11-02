/**
 * Markdown de las respuestas de un modelo de lenguaje (Pulso) → árbol de
 * bloques, lógica pura. Primo del parser del centro de ayuda
 * (`src/lib/help/markdown.ts`), pero más permisivo: un LLM escribe títulos
 * `#`…`####`, viñetas con `-`, `*` o `+`, listas numeradas `1.`/`1)`,
 * listas anidadas por sangría, separadores `---`, tablas `| a | b |`,
 * citas `>`, negrita `**`/`__`, cursiva `*`/`_`, negrita cursiva `***`,
 * tachado `~~` y código. Lo que no cierra queda como texto: nunca falla ni
 * esconde contenido.
 *
 * Seguridad: el renderizador (`ChatMarkdown`) pinta con elementos de React,
 * sin HTML crudo; los enlaces sólo se activan si son rutas internas
 * (`/…`) o `http(s)://` (estos abren aparte). `javascript:` y demás quedan
 * como texto.
 */

export type ChatInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: ChatInline[] }
  | { type: "em"; children: ChatInline[] }
  | { type: "del"; children: ChatInline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; external: boolean; children: ChatInline[] }
  | { type: "br" };

export type ChatList = {
  type: "list";
  ordered: boolean;
  start: number;
  items: ChatListItem[];
};

export type ChatListItem = { children: ChatInline[]; sub: ChatList | null };

export type ChatAlign = "left" | "center" | "right" | null;

export type ChatBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; children: ChatInline[] }
  | { type: "paragraph"; children: ChatInline[] }
  | ChatList
  | { type: "code"; lang: string | null; value: string }
  | { type: "quote"; children: ChatInline[] }
  | { type: "hr" }
  | { type: "table"; align: ChatAlign[]; header: ChatInline[][]; rows: ChatInline[][][] };

/* ───────────────────────────── En línea ───────────────────────────── */

const INTERNAL_HREF = /^\/(?!\/)[^\s"'<>\\]*$/;
const EXTERNAL_HREF = /^https?:\/\/[^\s"'<>\\]+$/i;

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);

/**
 * Cierre de `marker` desde `from` en la misma línea, saltando los
 * `código` intermedios. Exige que el carácter anterior al cierre no sea
 * espacio («** hola **» no es negrita).
 */
function findClosing(text: string, marker: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "\n") return -1;
    if (text.startsWith(marker, i) && !isSpace(text[i - 1])) return i;
    i += 1;
  }
  return -1;
}

/**
 * Cierre de un énfasis de UN carácter (`*` o `_`): no puede ir doblado
 * (sería otro delimitador) ni precedido de espacio; con `_`, el carácter
 * siguiente no puede ser letra (así `snake_case_largo` no se vuelve
 * cursiva).
 */
function findClosingEmphasis(text: string, marker: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "\n") return -1;
    if (
      text[i] === marker &&
      text[i + 1] !== marker &&
      !isSpace(text[i - 1]) &&
      !(marker === "_" && isWordChar(text[i + 1]))
    ) {
      return i;
    }
    i += 1;
  }
  return -1;
}

type Wrapped = { type: "strong" | "em" | "del"; inner: string; end: number; nested?: "em" };

/** `***x***`, `**x**`, `__x__`, `~~x~~` en la posición `i`, o null. */
function matchDouble(text: string, i: number): Wrapped | null {
  if (text.startsWith("***", i) && !isSpace(text[i + 3])) {
    const end = findClosing(text, "***", i + 3);
    if (end > i + 3) return { type: "strong", nested: "em", inner: text.slice(i + 3, end), end: end + 3 };
  }
  for (const [marker, type] of [
    ["**", "strong"],
    ["__", "strong"],
    ["~~", "del"],
  ] as const) {
    if (!text.startsWith(marker, i)) continue;
    if (isSpace(text[i + 2])) return null;
    const end = findClosing(text, marker, i + 2);
    return end > i + 2 ? { type, inner: text.slice(i + 2, end), end: end + 2 } : null;
  }
  return null;
}

/** `*x*` o `_x_` en la posición `i` (sólo al inicio de palabra para `_`), o null. */
function matchSingle(text: string, i: number): Wrapped | null {
  const ch = text[i];
  if (ch !== "*" && ch !== "_") return null;
  if (text[i + 1] === ch || isSpace(text[i + 1])) return null;
  if (ch === "_" && isWordChar(text[i - 1])) return null;
  const end = findClosingEmphasis(text, ch, i + 1);
  return end > i + 1 ? { type: "em", inner: text.slice(i + 1, end), end: end + 1 } : null;
}

function matchLink(text: string, start: number): { label: string; href: string; end: number } | null {
  const close = text.indexOf("](", start + 1);
  if (close < 0) return null;
  const label = text.slice(start + 1, close);
  if (!label || label.includes("[") || label.includes("\n")) return null;
  // El destino puede traer paréntesis balanceados (`/x?f=(a)`,
  // `javascript:alert(1)`): se cierra con el `)` que deja la cuenta en cero.
  let depth = 0;
  let hrefEnd = -1;
  for (let i = close + 2; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) {
        hrefEnd = i;
        break;
      }
      depth -= 1;
    }
  }
  if (hrefEnd < 0) return null;
  const href = text.slice(close + 2, hrefEnd).trim();
  if (!href) return null;
  return { label, href, end: hrefEnd + 1 };
}

function mergeText(nodes: ChatInline[]): ChatInline[] {
  const out: ChatInline[] = [];
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

/** Texto en línea → nodos. Los saltos de línea simples se conservan (`br`). */
export function parseChatInline(text: string, opts: { allowLinks?: boolean } = {}): ChatInline[] {
  const allowLinks = opts.allowLinks ?? true;
  const out: ChatInline[] = [];
  let buf = "";
  const push = (node: ChatInline) => {
    if (buf) out.push({ type: "text", value: buf });
    buf = "";
    out.push(node);
  };
  const wrapped = (w: Wrapped) => {
    const inner = parseChatInline(w.inner, { allowLinks });
    push({ type: w.type, children: w.nested ? [{ type: w.nested, children: inner }] : inner });
    return w.end;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\n") {
      push({ type: "br" });
      i += 1;
      continue;
    }

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    const dbl = matchDouble(text, i);
    if (dbl) {
      i = wrapped(dbl);
      continue;
    }

    const single = matchSingle(text, i);
    if (single) {
      i = wrapped(single);
      continue;
    }

    if (ch === "[") {
      const link = matchLink(text, i);
      if (link) {
        const children = parseChatInline(link.label, { allowLinks: false });
        if (allowLinks && INTERNAL_HREF.test(link.href)) {
          push({ type: "link", href: link.href, external: false, children });
        } else if (allowLinks && EXTERNAL_HREF.test(link.href)) {
          push({ type: "link", href: link.href, external: true, children });
        } else {
          // Enlace no permitido (javascript:, mailto:, anidado…): sólo el texto.
          if (buf) out.push({ type: "text", value: buf });
          buf = "";
          out.push(...children);
        }
        i = link.end;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  if (buf) out.push({ type: "text", value: buf });
  return mergeText(out);
}

/* ───────────────────────────── Bloques ───────────────────────────── */

const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function tableAlign(sep: string): ChatAlign[] {
  return splitTableRow(sep).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

export function parseChatMarkdown(source: string): ChatBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ChatBlock[] = [];

  let paragraph: string[] = [];
  let list: ChatList | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", children: parseChatInline(paragraph.join("\n")) });
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ type: "quote", children: parseChatInline(quote.join("\n")) });
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();

    // Bloque de código: tal cual hasta el cierre (o el final del texto).
    if (line.startsWith("```")) {
      flushAll();
      const lang = line.slice(3).trim() || null;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        body.push(lines[i]!);
        i += 1;
      }
      blocks.push({ type: "code", lang, value: body.join("\n") });
      continue;
    }

    if (!line) {
      flushAll();
      continue;
    }

    if (HR_RE.test(line)) {
      flushAll();
      blocks.push({ type: "hr" });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        type: "heading",
        level: Math.min(heading[1]!.length, 4) as 1 | 2 | 3 | 4,
        children: parseChatInline(heading[2]!.trim()),
      });
      continue;
    }

    // Tabla: una fila con `|` seguida de la línea separadora `|---|---|`.
    const next = lines[i + 1]?.trim() ?? "";
    if (line.includes("|") && next.includes("-") && TABLE_SEP_RE.test(next)) {
      flushAll();
      const header = splitTableRow(line).map((c) => parseChatInline(c));
      const align = tableAlign(next);
      const rows: ChatInline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        rows.push(splitTableRow(lines[i]!).map((c) => parseChatInline(c)));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();

    const item = LIST_RE.exec(raw);
    if (item) {
      flushParagraph();
      const indent = item[1]!.length;
      const ordered = item[3] !== undefined;
      const start = ordered ? Number(item[3]) : 1;
      const children = parseChatInline(item[4]!.trim());
      // Sangría ≥ 2 con una lista abierta: punto de la sublista del último
      // ítem (un solo nivel; más sangría cae en la misma sublista).
      if (indent >= 2 && list && list.items.length > 0) {
        const parent = list.items[list.items.length - 1]!;
        if (!parent.sub || parent.sub.ordered !== ordered) {
          parent.sub = { type: "list", ordered, start, items: [] };
        }
        parent.sub.items.push({ children, sub: null });
        continue;
      }
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: "list", ordered, start, items: [] };
      }
      list.items.push({ children, sub: null });
      continue;
    }

    // Continuación con sangría de un punto de la lista.
    if (list && /^\s{2,}\S/.test(raw)) {
      const last = list.items[list.items.length - 1]!;
      const target = last.sub ? last.sub.items[last.sub.items.length - 1]! : last;
      target.children = mergeText([...target.children, { type: "text", value: " " }, ...parseChatInline(line)]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushAll();
  return blocks;
}

/** Texto plano de un conjunto de nodos (para tests y previsualizaciones). */
export function chatInlineText(nodes: ChatInline[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text" || n.type === "code") return n.value;
      if (n.type === "br") return "\n";
      return chatInlineText(n.children);
    })
    .join("");
}
