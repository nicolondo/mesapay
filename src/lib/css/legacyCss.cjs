/**
 * Utilidades compartidas por el plugin de respaldos CSS (postcssLegacyFallbacks)
 * y por el chequeo de compatibilidad (cssCompatCheck).
 *
 * PISO DE SOPORTE (mantener en sync con "browserslist" de package.json):
 *   Chrome / Android WebView 99+ y Safari iOS 15.4+.
 * Es el navegador de los datáfonos Android (Sunmi y similares) y de celulares
 * baratos que no se actualizan. Lo que el CSS usa y ese piso NO entiende:
 *   - color-mix()              Chrome 111 / Safari 16.2
 *   - oklch()/oklab()/lab()    Chrome 111 / Safari 15.4
 *   - anidamiento con `&`      Chrome 112 / Safari 16.5
 *   - media queries por rango  Chrome 104 / Safari 16.4   (`width >= 40rem`)
 *   - translate/rotate/scale   Chrome 104 / Safari 14.1   (propiedades sueltas)
 *   - dvh/svh/lvh              Chrome 108 / Safari 15.4
 *   - :has()                   Chrome 105 / Safari 15.4
 *   - @container / cqi         Chrome 105 / Safari 16
 *
 * CommonJS a propósito: lo cargan postcss.config.mjs (Turbopack lo evalúa en
 * un worker de Node), el chequeo de CI (scripts/check-css-compat.mjs) y
 * vitest, todos sin transpilar.
 */
"use strict";

const FLOOR = Object.freeze({ chrome: 99, safari: "15.4" });

/** Gate que usa Tailwind para lo moderno: `@supports (color: color-mix(in lab, red, red))`. */
const COLOR_MIX_GATE = "(color: color-mix(in lab, red, red))";

// ── utilidades de texto ──────────────────────────────────────────────────────

/** Separa por un carácter al primer nivel (fuera de paréntesis y comillas). */
function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === quote && str[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    const isSep = sep === " " ? /\s/.test(ch) : ch === sep;
    if (isSep && depth === 0) {
      if (sep !== " " || cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (sep !== " " || cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Encuentra cada llamada `name(...)` (sin distinguir mayúsculas) con su
 * paréntesis balanceado. Devuelve [{ start, end, inner }] (end exclusivo).
 */
function findCalls(value, name) {
  const calls = [];
  const lower = value.toLowerCase();
  const needle = name.toLowerCase() + "(";
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) break;
    const prev = idx > 0 ? lower[idx - 1] : "";
    if (/[a-z0-9-]/.test(prev)) {
      from = idx + needle.length;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = idx + needle.length - 1; i < value.length; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    calls.push({ start: idx, end, inner: value.slice(idx + needle.length, end - 1) });
    from = end;
  }
  return calls;
}

// ── colores ──────────────────────────────────────────────────────────────────
// Un color es [r, g, b, a] en sRGB con componentes 0..1 (sin premultiplicar).

const NAMED = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  green: [0, 128 / 255, 0, 1],
  blue: [0, 0, 1, 1],
};

function num(token, scaleForPercent) {
  const t = token.trim();
  if (t === "none") return 0;
  if (t.endsWith("%")) return (parseFloat(t) / 100) * scaleForPercent;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

function alphaOf(token) {
  if (token == null) return 1;
  const t = token.trim();
  if (t.endsWith("%")) return parseFloat(t) / 100;
  return parseFloat(t);
}

/** Argumentos de rgb()/oklch()…: acepta comas o espacios con `/ alfa`. */
function colorArgs(inner) {
  if (inner.includes(",")) {
    const parts = inner.split(",").map((s) => s.trim());
    return { parts: parts.slice(0, 3), alpha: parts[3] };
  }
  const [main, alpha] = inner.split("/");
  return { parts: main.trim().split(/\s+/), alpha: alpha && alpha.trim() };
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function oklabToSrgb(lab, alpha) {
  const lin = oklabToLinear(lab);
  return [clamp01(toGamma(lin[0])), clamp01(toGamma(lin[1])), clamp01(toGamma(lin[2])), alpha];
}

/** Parsea un color literal (sin var()). Devuelve null si no lo entiende. */
function parseColor(input) {
  const v = input.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v].slice();
  if (v.startsWith("#")) {
    const h = v.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    const exp = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
    if (exp.length !== 6 && exp.length !== 8) return null;
    const n = (i) => parseInt(exp.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), exp.length === 8 ? n(6) : 1];
  }
  const fn = /^([a-z-]+)\((.*)\)$/s.exec(v);
  if (!fn) return null;
  const [, name, inner] = fn;
  const { parts, alpha } = colorArgs(inner);
  if (name === "rgb" || name === "rgba") {
    if (parts.length < 3) return null;
    const c = parts.map((p) => num(p, 255) / 255);
    if (c.some((x) => !Number.isFinite(x))) return null;
    return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(alphaOf(alpha))];
  }
  if (name === "oklab") {
    if (parts.length < 3) return null;
    return oklabToSrgb([num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)], clamp01(alphaOf(alpha)));
  }
  if (name === "oklch") {
    if (parts.length < 3) return null;
    const L = num(parts[0], 1);
    const C = num(parts[1], 0.4);
    const H = (parseFloat(parts[2]) * Math.PI) / 180;
    return oklabToSrgb([L, C * Math.cos(H), C * Math.sin(H)], clamp01(alphaOf(alpha)));
  }
  return null;
}

/** Mezcla dos colores con premultiplicación de alfa (CSS Color 5 §2). */
function mixColors(space, c1, p1, c2, p2) {
  let w1 = p1;
  let w2 = p2;
  if (w1 == null && w2 == null) w1 = w2 = 0.5;
  else if (w1 == null) w1 = 1 - w2;
  else if (w2 == null) w2 = 1 - w1;
  const sum = w1 + w2;
  if (!(sum > 0)) return null;
  const alphaMult = sum < 1 ? sum : 1;
  w1 /= sum;
  w2 /= sum;
  const toSpace = (c) => {
    if (space === "srgb") return c.slice(0, 3);
    const lin = c.slice(0, 3).map(toLinear);
    if (space === "srgb-linear") return lin;
    return linearToOklab(lin); // oklab (y aproximación para lab/oklch/hsl)
  };
  const fromSpace = (v, a) => {
    if (space === "srgb") return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2]), a];
    if (space === "srgb-linear") return [clamp01(toGamma(v[0])), clamp01(toGamma(v[1])), clamp01(toGamma(v[2])), a];
    return oklabToSrgb(v, a);
  };
  const a1 = c1[3];
  const a2 = c2[3];
  const alpha = a1 * w1 + a2 * w2;
  if (alpha === 0) return [0, 0, 0, 0];
  const v1 = toSpace(c1);
  const v2 = toSpace(c2);
  const mixed = [0, 1, 2].map((i) => (v1[i] * a1 * w1 + v2[i] * a2 * w2) / alpha);
  return fromSpace(mixed, alpha * alphaMult);
}

function toHex(c) {
  const h = (x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0");
  const base = "#" + h(c[0]) + h(c[1]) + h(c[2]);
  return c[3] >= 0.999 ? base : base + h(c[3]);
}

// ── variables (tokens) ───────────────────────────────────────────────────────

const ROOT_SELECTORS = new Set([":root", ":host", "html"]);

function isRootSelector(selector) {
  return splitTop(selector, ",").every((s) => ROOT_SELECTORS.has(s.trim()));
}

function hasAncestorAtRule(node, names) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule" && names.includes(p.name.toLowerCase())) return true;
  }
  return false;
}

/**
 * Variables de color para calcular respaldos estáticos.
 *
 * 1. Las definidas en `:root`/`:host`/`html` sin condición (@media,
 *    @supports): es el valor que ve un navegador viejo. La última gana.
 * 2. Las que sólo existen en un componente (p. ej. `--fp-ink` en
 *    `.fp-canvas`): se toma su PRIMERA definición sin condición, que por
 *    convención es la base y lo que sigue son variantes (comensal, tema
 *    oscuro). Es una aproximación: en una variante que cambie el color, el
 *    navegador viejo ve el tono de la base (los modernos, el correcto).
 *    Las `--tw-*` de Tailwind quedan fuera: son internas de cada utilidad.
 */
function collectTokens(root) {
  const tokens = new Map();
  const scoped = new Map();
  root.walkDecls((decl) => {
    if (!decl.prop.startsWith("--")) return;
    const rule = decl.parent;
    if (!rule || rule.type !== "rule") return;
    if (hasAncestorAtRule(rule, ["media", "supports", "container"])) return;
    if (isRootSelector(rule.selector)) tokens.set(decl.prop, decl.value.trim());
    else if (!decl.prop.startsWith("--tw-") && !scoped.has(decl.prop)) scoped.set(decl.prop, decl.value.trim());
  });
  for (const [name, value] of scoped) if (!tokens.has(name)) tokens.set(name, value);
  return tokens;
}

/**
 * Resuelve un valor de color: literal, var(--x[, respaldo]) o color-mix(...).
 * Devuelve { color } o { reason } si no se puede saber de forma estática.
 */
function resolveColor(value, tokens, seen = new Set()) {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === "currentcolor") return { reason: "currentColor" };
  if (lower.startsWith("var(")) {
    const calls = findCalls(v, "var");
    if (calls.length !== 1 || calls[0].start !== 0 || calls[0].end !== v.length) return { reason: v };
    const [name, ...fb] = splitTop(calls[0].inner, ",");
    const n = name.trim();
    if (seen.has(n)) return { reason: `ciclo en ${n}` };
    if (tokens.has(n)) {
      const next = new Set(seen);
      next.add(n);
      return resolveColor(tokens.get(n), tokens, next);
    }
    if (fb.length) return resolveColor(fb.join(","), tokens, seen);
    return { reason: `${n} no está definida en :root` };
  }
  if (lower.startsWith("color-mix(")) return resolveColorMix(v, tokens, seen);
  const c = parseColor(v);
  return c ? { color: c } : { reason: v };
}

/** Resuelve una llamada color-mix(...) completa a un color estático. */
function resolveColorMix(call, tokens, seen = new Set()) {
  const calls = findCalls(call, "color-mix");
  if (!calls.length) return { reason: call };
  const args = splitTop(calls[0].inner, ",");
  if (args.length !== 3) return { reason: call };
  const interp = args[0].trim().toLowerCase().split(/\s+/);
  if (interp[0] !== "in") return { reason: call };
  const space = interp[1];
  const parsed = [];
  for (const spec of args.slice(1)) {
    const tokensOf = splitTop(spec, " ");
    let pct = null;
    const colorParts = [];
    for (const t of tokensOf) {
      if (/^-?[\d.]+%$/.test(t)) pct = parseFloat(t) / 100;
      else colorParts.push(t);
    }
    const res = resolveColor(colorParts.join(" "), tokens, seen);
    if (!res.color) return res;
    parsed.push({ color: res.color, pct });
  }
  const mixed = mixColors(space, parsed[0].color, parsed[0].pct, parsed[1].color, parsed[1].pct);
  return mixed ? { color: mixed } : { reason: call };
}

/**
 * Cambia cada color-mix(...) de un valor por su color estático (hex).
 * Devuelve { value } o { reason } con lo que no se pudo resolver.
 */
function staticizeColorMix(value, tokens) {
  const calls = findCalls(value, "color-mix");
  let out = "";
  let last = 0;
  for (const c of calls) {
    const res = resolveColorMix(value.slice(c.start, c.end), tokens);
    if (!res.color) return { reason: res.reason };
    out += value.slice(last, c.start) + toHex(res.color);
    last = c.end;
  }
  return { value: out + value.slice(last) };
}

/** Nombres de variables usadas dentro de los color-mix() de un valor. */
function varsInsideColorMix(value) {
  const names = new Set();
  for (const c of findCalls(value, "color-mix")) {
    for (const v of findCalls(c.inner, "var")) names.add(splitTop(v.inner, ",")[0].trim());
  }
  return names;
}

/**
 * ¿El respaldo que dejó Tailwind es malo? Tailwind arma el respaldo de un
 * color-mix(var(--x) N%, …) cambiando cada variable por su valor del tema; si
 * la variable no está en el tema (los --op-*, currentColor), deja el PRIMER
 * color sólido: `bg-op-text/10` → `background: var(--op-text)` (negro pleno).
 */
function isBadColorMixFallback(fallbackValue, modernValue) {
  const fb = fallbackValue.toLowerCase();
  if (/color-mix\(/.test(fb) && /var\(|currentcolor/.test(fb)) return true;
  for (const name of varsInsideColorMix(modernValue)) {
    if (fb.includes(`var(${name.toLowerCase()}`)) return true;
  }
  const modern = modernValue.toLowerCase();
  if (findCalls(modern, "color-mix").some((c) => c.inner.includes("currentcolor")) && fb.includes("currentcolor")) {
    return true;
  }
  return false;
}

/**
 * ¿Dos valores CSS pintan lo mismo? Compara token a token; los colores con
 * tolerancia de redondeo (2/255 por canal) — así no se reescriben respaldos
 * correctos que Lightning CSS calculó con otro redondeo.
 */
function equivalentCssValues(a, b) {
  const tokenize = (v) => splitTop(v, ",").flatMap((part, i) => (i ? [","] : []).concat(splitTop(part, " ")));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length !== tb.length) return false;
  return ta.every((x, i) => {
    const y = tb[i];
    if (x.toLowerCase() === y.toLowerCase()) return true;
    const cx = parseColor(x);
    const cy = parseColor(y);
    if (!cx || !cy) return false;
    return cx.every((ch, k) => Math.abs(ch - cy[k]) <= 2 / 255 + 1e-9);
  });
}

function isColorMixGate(atRule) {
  return (
    atRule.type === "atrule" &&
    atRule.name.toLowerCase() === "supports" &&
    /color-mix/i.test(atRule.params) &&
    !/^\s*not\b/i.test(atRule.params)
  );
}

/** ¿El nodo está dentro de un @supports que pide color-mix()? */
function insideColorMixGate(node) {
  for (let p = node.parent; p; p = p.parent) if (isColorMixGate(p)) return true;
  return false;
}

const normalizeSelector = (s) => splitTop(s, ",").map((x) => x.replace(/\s+/g, " ").trim()).join(",");

module.exports = {
  FLOOR,
  COLOR_MIX_GATE,
  splitTop,
  findCalls,
  parseColor,
  mixColors,
  toHex,
  collectTokens,
  resolveColor,
  resolveColorMix,
  staticizeColorMix,
  varsInsideColorMix,
  isBadColorMixFallback,
  equivalentCssValues,
  isColorMixGate,
  insideColorMixGate,
  hasAncestorAtRule,
  normalizeSelector,
};
