/**
 * Chequeo de compatibilidad del CSS COMPILADO con el piso de soporte
 * (Firefox 107 del datáfono, Chrome/WebView 99, Safari iOS 15.4 — ver legacyCss.cjs).
 *
 * Lo corre `scripts/check-css-compat.mjs` sobre `.next/static/**\/*.css` en
 * CI (después de `npm run build`) y el test `cssCompat.test.ts` sobre el CSS
 * de la app compilado por el mismo camino. Falla si queda algo que un
 * navegador del piso pintaría mal:
 *
 *  - anidamiento CSS (`&`, reglas dentro de reglas);
 *  - media queries por rango (`width >= 40rem`);
 *  - color-mix()/oklch()/lab()… sin respaldo, o con un respaldo malo (el
 *    color sólido que deja Tailwind cuando no resuelve una variable);
 *  - dvh/svh/lvh sin respaldo en vh;
 *  - translate/rotate/scale sin el `transform` de `@supports not (translate: 0)`;
 *  - :has() sin `@supports selector(:has(...))`;
 *  - unidades de contenedor (cqi, cqw…) sin respaldo;
 *  - `@property` con valor inicial sin el respaldo de Tailwind para Firefox
 *    < 128 (el datáfono): las variables `--tw-*` puestas en `*` dentro del
 *    `@supports (… -moz-orient …)` de `@layer properties`. Sin eso, en
 *    Firefox 107 un `border` sale sin estilo y un `shadow` sin sombra.
 *
 * `@container` y `text-wrap` sólo dan aviso: son mejoras y el estilo base
 * tiene que funcionar sin eso.
 */
"use strict";

// CommonJS a propósito (ver legacyCss.cjs).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const postcss = require("postcss");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isBadColorMixFallback, normalizeSelector, findCalls } = require("./legacyCss.cjs");

const MODERN_COLOR = /(^|[^\w-])(color-mix|oklch|oklab|lab|lch|color|light-dark)\(/i;
const DYN_VIEWPORT = /[\d.][dsl]v(?:h|w|min|max|i|b)\b/i;
const CONTAINER_UNIT = /[\d.]cq(?:i|b|w|h|min|max)\b/i;
const INDIVIDUAL_TRANSFORMS = new Set(["translate", "rotate", "scale"]);

function ancestors(node) {
  const out = [];
  for (let p = node.parent; p && p.type !== "root"; p = p.parent) out.push(p);
  return out;
}

const supportsAncestors = (node) =>
  ancestors(node).filter((p) => p.type === "atrule" && p.name.toLowerCase() === "supports");

function inKeyframes(node) {
  return ancestors(node).some((p) => p.type === "atrule" && /keyframes$/i.test(p.name));
}

function describe(node) {
  const rule = node.parent && node.parent.type === "rule" ? node.parent.selector : node.parent && node.parent.name;
  const s = `${rule ?? "?"} { ${node.prop}: ${node.value} }`;
  return s.length > 220 ? s.slice(0, 217) + "…" : s;
}

/**
 * Busca hacia atrás, entre los hermanos del nodo `from`, la regla que cubre
 * ese selector (igual, o una lista que lo incluye: el minificador junta
 * reglas con las mismas declaraciones).
 */
function findPreviousRule(from, selector) {
  const want = normalizeSelector(selector).split(",");
  for (let p = from.prev(); p; p = p.prev()) {
    if (p.type !== "rule") continue;
    const have = new Set(normalizeSelector(p.selector).split(","));
    if (want.every((s) => have.has(s))) return p;
  }
  return null;
}

function lastDeclBefore(rule, prop, before) {
  let found = null;
  for (const n of rule.nodes) {
    if (n === before) break;
    if (n.type === "decl" && n.prop === prop) found = n;
  }
  return found;
}

function checkCss(css, { from = "css" } = {}) {
  const errors = [];
  const warnings = [];
  const root = postcss.parse(css, { from });
  const err = (kind, node, msg) => errors.push({ kind, where: describe(node), message: msg });

  // Reglas con el transform de respaldo de translate/rotate/scale.
  const transformFallbacks = new Set();
  root.walkAtRules("supports", (at) => {
    if (!/^\s*not\s*\(\s*(translate|rotate|scale)\s*:/i.test(at.params)) return;
    at.walkRules((r) => {
      if (r.some((d) => d.type === "decl" && d.prop === "transform")) transformFallbacks.add(normalizeSelector(r.selector));
    });
  });

  // @property (Firefox 128): cada variable registrada con valor inicial
  // tiene que tener su valor en el respaldo de Tailwind para Firefox viejo.
  const firefoxPropertyFallback = new Set();
  root.walkAtRules("supports", (at) => {
    if (!/-moz-orient/i.test(at.params)) return;
    at.walkRules((r) => {
      if (!/(^|,)\s*\*\s*(,|$)/.test(r.selector)) return;
      r.walkDecls((d) => {
        if (d.prop.startsWith("--")) firefoxPropertyFallback.add(d.prop);
      });
    });
  });
  root.walkAtRules("property", (at) => {
    const hasInitial = at.nodes && at.nodes.some((d) => d.type === "decl" && d.prop === "initial-value");
    if (!hasInitial) return;
    const name = at.params.trim();
    if (!firefoxPropertyFallback.has(name)) {
      errors.push({
        kind: "@property",
        where: `@property ${name}`,
        message: "valor inicial sin respaldo para navegadores sin @property (Firefox < 128, el datáfono)",
      });
    }
  });

  root.walkRules((rule) => {
    if (rule.parent && rule.parent.type === "rule") {
      errors.push({ kind: "anidamiento", where: rule.selector, message: "regla anidada (Chrome < 112 la descarta)" });
    }
    if (/(^|[^\\])&/.test(rule.selector)) {
      errors.push({ kind: "anidamiento", where: rule.selector, message: "selector con & sin aplanar" });
    }
    if (/:has\(/i.test(rule.selector) && !supportsAncestors(rule).some((s) => /selector\(\s*:has/i.test(s.params))) {
      errors.push({
        kind: ":has()",
        where: rule.selector,
        message: ":has() (Chrome 105) sin @supports selector(:has(*)): en el piso se cae la regla entera",
      });
    }
  });

  root.walkAtRules((at) => {
    const name = at.name.toLowerCase();
    if (name === "media" && /[<>]/.test(at.params)) {
      errors.push({ kind: "media por rango", where: `@media ${at.params}`, message: "sintaxis de rango (Chrome 104): usa min-width/max-width" });
    }
    if (name === "container") warnings.push({ kind: "@container", where: `@container ${at.params}`, message: "sin efecto antes de Chrome 105 (mejora progresiva)" });
  });

  root.walkDecls((decl) => {
    const value = decl.value;
    const isCustom = decl.prop.startsWith("--");
    const sups = supportsAncestors(decl);
    const rule = decl.parent && decl.parent.type === "rule" ? decl.parent : null;

    // ── colores modernos ─────────────────────────────────────────────────
    if (MODERN_COLOR.test(value)) {
      const gate = sups.find((s) => MODERN_COLOR.test(s.params) && !/^\s*not\b/i.test(s.params));
      if (inKeyframes(decl)) {
        if (/var\(|currentcolor/i.test(value)) err("color", decl, "color moderno con variables dentro de @keyframes: el piso lo descarta");
      } else if (gate) {
        if (/color-mix\(/i.test(value) && /var\(|currentcolor/i.test(value) && rule) {
          // El respaldo: la misma propiedad en la regla con el mismo selector
          // justo antes del @supports (así lo deja Tailwind/Lightning).
          const prevRule = findPreviousRule(gate, rule.selector);
          // Lightning agrega `-webkit-…` adentro del @supports; afuera basta la
          // propiedad sin prefijo (el piso la entiende).
          const unprefixed = decl.prop.replace(/^-(webkit|moz|ms)-/i, "");
          const fallback = prevRule
            ? lastDeclBefore(prevRule, decl.prop, null) || lastDeclBefore(prevRule, unprefixed, null)
            : null;
          const usesCurrentColor = findCalls(value, "color-mix").some((c) => /currentcolor/i.test(c.inner));
          if (!fallback) {
            if (usesCurrentColor) {
              warnings.push({ kind: "color", where: describe(decl), message: "color-mix() con currentColor: el piso no recibe este efecto" });
            } else {
              err("color", decl, "color-mix() con variables sin respaldo para el piso");
            }
          } else if (isBadColorMixFallback(fallback.value, value) || MODERN_COLOR.test(fallback.value)) {
            err("color", decl, `respaldo malo: \`${fallback.prop}: ${fallback.value}\` (color sólido en vez de la mezcla)`);
          }
        }
      } else if (isCustom) {
        err("color", decl, "variable con color moderno fuera de @supports: en el piso queda inválida y la propiedad que la usa cae a unset");
      } else if (/var\(/i.test(value)) {
        err("color", decl, "color moderno con var() fuera de @supports: en el piso cae a unset (el respaldo anterior no sirve)");
      } else {
        const prev = rule ? lastDeclBefore(rule, decl.prop, decl) : null;
        if (!prev || MODERN_COLOR.test(prev.value)) err("color", decl, "color moderno sin respaldo anterior en la misma regla");
      }
    }

    // ── dvh/svh/lvh ──────────────────────────────────────────────────────
    if (DYN_VIEWPORT.test(value) && !sups.some((s) => /[dsl]v[hw]/i.test(s.params))) {
      if (isCustom) err("viewport", decl, "variable con dvh/svh fuera de @supports (Chrome 108)");
      else {
        const prev = rule ? lastDeclBefore(rule, decl.prop, decl) : null;
        if (!prev || DYN_VIEWPORT.test(prev.value)) err("viewport", decl, "dvh/svh/lvh sin respaldo en vh antes (Chrome 108)");
      }
    }

    if (decl.prop === "text-wrap" && /balance|pretty/i.test(value)) {
      warnings.push({ kind: "text-wrap", where: describe(decl), message: "sin efecto antes de Firefox 121 / Chrome 114 (mejora)" });
    }

    // ── unidades de contenedor ───────────────────────────────────────────
    if (CONTAINER_UNIT.test(value) && !isCustom && !sups.some((s) => /cq[ibwh]|cqmin|cqmax/i.test(s.params))) {
      const prev = rule ? lastDeclBefore(rule, decl.prop, decl) : null;
      if (!prev || CONTAINER_UNIT.test(prev.value)) err("contenedor", decl, "unidad cqi/cqw sin respaldo antes (Chrome 105)");
    }

    // ── translate/rotate/scale ───────────────────────────────────────────
    if (INDIVIDUAL_TRANSFORMS.has(decl.prop.toLowerCase()) && rule && !inKeyframes(decl)) {
      const gated = sups.some((s) => /translate|rotate|scale/i.test(s.params));
      if (!gated && !/^none$/i.test(value.trim()) && !transformFallbacks.has(normalizeSelector(rule.selector))) {
        err("transform", decl, `\`${decl.prop}\` suelto (Chrome 104) sin transform de respaldo`);
      }
    }
  });

  return { errors, warnings };
}

module.exports = { checkCss };
