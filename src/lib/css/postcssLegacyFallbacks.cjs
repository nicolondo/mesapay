/**
 * Plugin de PostCSS: respaldos para navegadores viejos (piso: Firefox 107 —
 * el datáfono Sunmi —, Chrome/WebView 99 y Safari iOS 15.4; ver legacyCss.cjs
 * y "browserslist" en package.json).
 *
 * Corre DESPUÉS de Tailwind (postcss.config.mjs). Lo demás que el piso no
 * entiende (anidamiento, media queries por rango, oklch(), prefijos) lo baja
 * Lightning CSS en Next/Turbopack según el browserslist; esto cubre lo que
 * Lightning NO sabe resolver:
 *
 * 1. color-mix() con variables. Tailwind deja `prop: RESPALDO` y la versión
 *    con color-mix() dentro de `@supports (color: color-mix(...))`, pero si la
 *    variable no está en su tema (los `--op-*`, `--rail-accent`) el respaldo es
 *    el PRIMER color sólido: `bg-op-text/10` pintaba la superficie negra plena
 *    y `.mp-btn--ghost:hover` un botón negro con texto negro. Acá el respaldo
 *    se calcula con los valores de `:root` (`#1a161319`, translúcido como el
 *    original). Si no se puede (currentColor, una variable local) se quita el
 *    respaldo malo — mejor sin efecto que un bloque de color equivocado — y se
 *    avisa. Un color-mix() con variables SIN gate (escrito a mano) se gatea.
 * 2. dvh/svh/lvh (Chrome 108; Firefox 101 ya los tiene): se antepone la
 *    misma declaración en `vh`.
 * 3. translate/rotate/scale sueltas (Chrome 104; Firefox 72 ya las tiene):
 *    dentro de `@supports not (translate: 0)` se arma el `transform`
 *    equivalente, así el interruptor se mueve y los íconos centrados con
 *    -translate-y-1/2 quedan en su lugar en un WebView viejo.
 *
 * Nada de esto cambia lo que pinta un navegador moderno: los respaldos quedan
 * antes de (o bajo un @supports que excluye a) la declaración moderna.
 */
"use strict";

// CommonJS a propósito (ver legacyCss.cjs).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacyCss = require("./legacyCss.cjs");

const {
  COLOR_MIX_GATE,
  collectTokens,
  staticizeColorMix,
  isBadColorMixFallback,
  equivalentCssValues,
  isColorMixGate,
  insideColorMixGate,
  hasAncestorAtRule,
  normalizeSelector,
  splitTop,
} = legacyCss;

const DYN_VIEWPORT = /([\d.])[dsl](v(?:h|w|min|max|i|b))\b/gi;
const hasDynViewport = (v) => /[\d.][dsl]v(?:h|w|min|max|i|b)\b/i.test(v);
const INDIVIDUAL_TRANSFORMS = new Set(["translate", "rotate", "scale"]);

function prevNonComment(node) {
  let p = node.prev();
  while (p && p.type === "comment") p = p.prev();
  return p;
}

function lastDecl(rule, prop) {
  let found = null;
  rule.each((n) => {
    if (n.type === "decl" && n.prop === prop) found = n;
  });
  return found;
}

/**
 * La regla de respaldo que precede al @supports, sólo para `selector`. Si el
 * minificador la juntó con otras en una lista (`.border-current,
 * .border-current\/25{…}`), la separa en el mismo lugar de la cascada para
 * poder tocar sólo la nuestra. null si `prev` no cubre el selector.
 */
function ownRuleFor(prev, selector) {
  const want = normalizeSelector(selector).split(",");
  const have = normalizeSelector(prev.selector).split(",");
  if (!want.every((x) => have.includes(x))) return null;
  if (want.length === have.length) return prev;
  const own = prev.clone({ selector });
  prev.selector = have.filter((x) => !want.includes(x)).join(",");
  prev.after(own);
  return own;
}

function removeAndPrune(node) {
  const parent = node.parent;
  node.remove();
  if (parent && parent.type === "rule" && parent.nodes.length === 0) parent.remove();
}

/**
 * Deja `decl` con `staticValue` y pone el valor original justo después, bajo
 * `@supports (params)`. Respeta el orden de la cascada: si la regla tiene más
 * declaraciones después, quedan en una copia de la regla tras el @supports.
 */
function gateDecl(decl, params, staticValue, { AtRule, Rule }) {
  const original = decl.clone();
  decl.value = staticValue;
  const rule = decl.parent;
  if (!rule || rule.type !== "rule" || (rule.parent && rule.parent.type === "rule")) {
    // Dentro de una regla anidada (salida sin optimizar de Tailwind): el
    // mismo patrón que usa Tailwind, que Lightning CSS aplana después.
    decl.after(new AtRule({ name: "supports", params, nodes: [original] }));
    return;
  }
  const rest = [];
  for (let n = decl.next(); n; n = n.next()) rest.push(n);
  const gate = new AtRule({ name: "supports", params });
  gate.append(new Rule({ selector: rule.selector, nodes: [original] }));
  rule.after(gate);
  if (rest.length) {
    const tail = new Rule({ selector: rule.selector });
    for (const n of rest) tail.append(n);
    gate.after(tail);
  }
}

function fixColorMix(root, helpers) {
  const { result, Declaration, Rule } = helpers;
  const tokens = collectTokens(root);
  const where = (node) => (node.source && node.source.start ? ` (línea ${node.source.start.line})` : "");

  // 1a. Declaraciones ya gateadas (las de Tailwind): corregir su respaldo.
  const gated = [];
  root.walkAtRules((at) => {
    if (!isColorMixGate(at)) return;
    at.each((child) => {
      if (child.type === "decl") gated.push({ at, decl: child, rule: null });
      else if (child.type === "rule") {
        child.each((d) => {
          if (d.type === "decl") gated.push({ at, decl: d, rule: child });
        });
      }
    });
  });
  for (const { at, decl, rule } of gated) {
    if (!/color-mix\(/i.test(decl.value)) continue;
    const prev = prevNonComment(at);
    let fallback = null;
    if (!rule) {
      if (prev && prev.type === "decl" && prev.prop === decl.prop) fallback = prev;
    } else if (prev && prev.type === "rule") {
      const own = ownRuleFor(prev, rule.selector);
      if (own) fallback = lastDecl(own, decl.prop);
    }
    const res = staticizeColorMix(decl.value, tokens);
    if (res.value != null) {
      if (fallback) {
        // Tailwind deja el primer color SÓLIDO cuando no resuelve todas las
        // variables (con o sin var() a la vista): si no pinta lo mismo que el
        // color-mix(), se reemplaza por el valor correcto.
        if (!equivalentCssValues(fallback.value, res.value)) fallback.value = res.value;
      } else {
        const fb = new Declaration({ prop: decl.prop, value: res.value, important: decl.important });
        if (rule) at.before(new Rule({ selector: rule.selector, nodes: [fb] }));
        else at.before(fb);
      }
      continue;
    }
    if (fallback && isBadColorMixFallback(fallback.value, decl.value)) removeAndPrune(fallback);
    // currentColor no se puede resolver a un color fijo; quitar el respaldo
    // sólido alcanza (el navegador viejo se queda sin ese efecto) y no hace
    // falta avisar. Una variable sin valor en :root sí se avisa.
    if (/^currentColor$/i.test(String(res.reason))) continue;
    const sel = rule ? rule.selector : at.parent && at.parent.type === "rule" ? at.parent.selector : "?";
    result.warn(
      `color-mix() sin respaldo para navegadores viejos en \`${sel}\` (${res.reason})${where(decl)}: ` +
        "se quitó el respaldo sólido. Define la variable en :root con un color fijo o evita currentColor.",
      { node: decl, plugin: "mesapay-legacy-fallbacks" },
    );
  }

  // 1b. color-mix() con variables SIN gate (CSS escrito a mano, keyframes).
  const loose = [];
  root.walkDecls((decl) => {
    // Sólo con var(): sin variables, un navegador viejo descarta la
    // declaración al parsear y se queda con la anterior (respaldo normal).
    if (!/color-mix\(/i.test(decl.value) || !/var\(/i.test(decl.value)) return;
    if (insideColorMixGate(decl)) return;
    loose.push(decl);
  });
  for (const decl of loose) {
    const res = staticizeColorMix(decl.value, tokens);
    if (res.value == null) {
      result.warn(`color-mix() sin respaldo para navegadores viejos: ${res.reason}${where(decl)}.`, {
        node: decl,
        plugin: "mesapay-legacy-fallbacks",
      });
      continue;
    }
    if (hasAncestorAtRule(decl, ["keyframes", "-webkit-keyframes"])) {
      // Dentro de @keyframes no se puede gatear: el valor estático es el mismo
      // color (las variables de :root no cambian), así que se usa directo.
      decl.value = res.value;
      continue;
    }
    gateDecl(decl, COLOR_MIX_GATE, res.value, helpers);
  }
}

function addViewportFallbacks(root, helpers) {
  const jobs = [];
  root.walkDecls((decl) => {
    if (!hasDynViewport(decl.value)) return;
    for (let p = decl.parent; p; p = p.parent) {
      if (p.type === "atrule" && p.name.toLowerCase() === "supports" && /[dsl]v[hw]/i.test(p.params)) return;
    }
    const prev = prevNonComment(decl);
    if (prev && prev.type === "decl" && prev.prop === decl.prop && !hasDynViewport(prev.value)) return;
    jobs.push(decl);
  });
  for (const decl of jobs) {
    const fallback = decl.value.replace(DYN_VIEWPORT, "$1$2");
    if (decl.prop.startsWith("--")) gateDecl(decl, "(height: 1dvh)", fallback, helpers);
    else decl.cloneBefore({ value: fallback });
  }
}

function transformFunction(prop, value) {
  const v = value.trim();
  if (!v || /^none$/i.test(v)) return null;
  const parts = splitTop(v, " ");
  if (prop === "translate") {
    if (parts.length === 1) return `translate(${parts[0]})`;
    if (parts.length === 2) return `translate(${parts[0]}, ${parts[1]})`;
    if (parts.length === 3) return `translate3d(${parts.join(", ")})`;
    return null;
  }
  if (prop === "scale") {
    if (parts.length === 1) return `scale(${parts[0]})`;
    if (parts.length === 2) return `scale(${parts[0]}, ${parts[1]})`;
    if (parts.length === 3) return `scale3d(${parts.join(", ")})`;
    return null;
  }
  if (prop === "rotate") {
    if (parts.length === 1) return `rotate(${parts[0]})`;
    if (parts.length === 2 && /^[xyz]$/i.test(parts[0])) return `rotate${parts[0].toUpperCase()}(${parts[1]})`;
    return null;
  }
  return null;
}

function addTransformFallbacks(root, { AtRule, Rule, Declaration }) {
  const byContainer = new Map();
  root.walkDecls((decl) => {
    if (!INDIVIDUAL_TRANSFORMS.has(decl.prop.toLowerCase())) return;
    const container = decl.parent;
    if (!container || container.type === "root") return;
    if (hasAncestorAtRule(decl, ["keyframes", "-webkit-keyframes"])) return;
    for (let p = container; p; p = p.parent) {
      if (p.type === "atrule" && p.name.toLowerCase() === "supports" && /translate|rotate|scale/i.test(p.params)) return;
    }
    if (!byContainer.has(container)) byContainer.set(container, []);
    byContainer.get(container).push(decl);
  });
  if (!byContainer.size) return;
  for (const [container, decls] of byContainer) {
    const nodes = [];
    let important = false;
    for (const d of decls) {
      const fn = transformFunction(d.prop.toLowerCase(), d.value);
      if (!fn) continue;
      nodes.push(new Declaration({ prop: `--mp-fb-${d.prop.toLowerCase()}`, value: fn }));
      important = important || d.important;
    }
    if (!nodes.length) continue;
    nodes.push(
      new Declaration({
        prop: "transform",
        value: "var(--mp-fb-translate, translate(0)) var(--mp-fb-rotate, rotate(0)) var(--mp-fb-scale, scale(1))",
        important,
      }),
    );
    const gate = new AtRule({ name: "supports", params: "not (translate: 0)" });
    const nested = container.type !== "rule" || (container.parent && container.parent.type === "rule");
    if (nested) {
      // Salida sin aplanar (desarrollo): @supports anidado con las
      // declaraciones, igual que hace Tailwind; Lightning CSS lo aplana.
      gate.append(nodes);
      decls[decls.length - 1].after(gate);
    } else {
      gate.append(new Rule({ selector: container.selector, nodes }));
      container.after(gate);
    }
  }
  // Que no se hereden: un hijo con su propio translate no debe girar con el padre.
  for (const name of ["translate", "rotate", "scale"]) {
    root.append(
      new AtRule({
        name: "property",
        params: `--mp-fb-${name}`,
        nodes: [
          new Declaration({ prop: "syntax", value: '"*"' }),
          new Declaration({ prop: "inherits", value: "false" }),
        ],
      }),
    );
  }
}

/** @type {import("postcss").PluginCreator<Record<string, never>>} */
function legacyFallbacks() {
  return {
    postcssPlugin: "mesapay-legacy-fallbacks",
    OnceExit(root, helpers) {
      fixColorMix(root, helpers);
      addViewportFallbacks(root, helpers);
      addTransformFallbacks(root, helpers);
    },
  };
}
legacyFallbacks.postcss = true;

module.exports = legacyFallbacks;
