#!/usr/bin/env node
/**
 * Auditoría i18n: encuentra claves referenciadas en el código (t("clave")
 * / tr("clave") / etc.) que NO existen en messages/es.json.
 *
 * - Detecta el namespace de cada hook: const X = useTranslations("ns")
 *   o const X = await getTranslations("ns").
 * - Resuelve cada llamada X("clave") contra la declaración del mismo
 *   nombre de variable MÁS CERCANA hacia arriba (scope-aware aproximado),
 *   lo que maneja archivos que redeclaran el hook por componente o que
 *   usan el mismo nombre para namespaces distintos.
 * - Soporta .rich/.markup/.has.
 * - Las llamadas dinámicas X(variable) / X(`...${}`) se listan aparte.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const es = JSON.parse(fs.readFileSync(path.join(ROOT, "messages", "es.json"), "utf8"));

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".next") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

function hasKey(obj, ns, key) {
  let cur = obj[ns];
  if (cur === undefined) return { nsExists: false, exists: false };
  const parts = key.split(".");
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in cur) {
      cur = cur[part];
    } else {
      return { nsExists: true, exists: false };
    }
  }
  return { nsExists: true, exists: true };
}

const DECL_RE =
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\s*\(\s*(["'`])([^"'`]+)\2\s*\)/g;

// Email/invoice helpers bind a namespace via getEmailTranslator(locale, "ns"),
// destructured as `const { t, locale } = await getEmailTranslator(...)`.
// Multiline-safe; supports rename `{ t: alias }`.
const EMAIL_DECL_RE =
  /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+getEmailTranslator\(\s*[^,()]*,\s*(["'`])([^"'`]+)\2/g;

const files = walk(SRC);
const missing = new Map(); // "ns.key" -> [{file,line}]
const dynamic = []; // {file,line,var,text}

const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");

  // 1) declarations: var -> [{idx, ns}]
  const decls = new Map();
  let m;
  DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(text))) {
    const v = m[1];
    if (!decls.has(v)) decls.set(v, []);
    decls.get(v).push({ idx: m.index, ns: m[3] });
  }
  // getEmailTranslator destructuring bindings
  EMAIL_DECL_RE.lastIndex = 0;
  while ((m = EMAIL_DECL_RE.exec(text))) {
    const ns = m[3];
    // figure out the translator var name from the destructured props
    const props = m[1];
    const tm = props.match(/(?:^|,)\s*t\s*(?::\s*(\w+))?/);
    if (!tm) continue;
    const v = tm[1] || "t";
    if (!decls.has(v)) decls.set(v, []);
    decls.get(v).push({ idx: m.index, ns });
  }
  if (decls.size === 0) continue;

  const varNames = [...decls.keys()];
  const varAlt = varNames
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  // Static call:  VAR("lit"  | VAR.rich("lit" | VAR.markup/.has, where the
  // char right after the closing quote is , or ) (NOT + → that's concat).
  // (?<![.\w]) avoids matching obj.VAR(  and longerVAR(.
  const staticRe = new RegExp(
    `(?<![.\\w])(${varAlt})\\s*(?:\\.(?:rich|markup|has))?\\s*\\(\\s*(["'\`])((?:\\\\.|(?!\\2).)*)\\2\\s*([,)])`,
    "g",
  );
  let cm;
  const consumed = new Set();
  while ((cm = staticRe.exec(text))) {
    const v = cm[1];
    const quote = cm[2];
    const key = cm[3];
    consumed.add(cm.index);
    if (quote === "`" && key.includes("${")) continue; // template w/ interp → dynamic
    const ds = decls.get(v);
    let ns = ds[0].ns;
    for (const d of ds) if (d.idx <= cm.index) ns = d.ns;
    const { exists } = hasKey(es, ns, key);
    if (!exists) {
      const full = `${ns}.${key}`;
      if (!missing.has(full)) missing.set(full, []);
      missing.get(full).push({ file: path.relative(ROOT, file), line: lineOf(text, cm.index) });
    }
  }

  // Dynamic calls: VAR( <not a string-literal-then-close>  — i.e. concat,
  // variable, ternary, template-with-interp. Exclude the hook declarations.
  const dynRe = new RegExp(`(?<![.\\w])(${varAlt})\\s*\\(\\s*([^)\\n]{0,60})`, "g");
  let dm;
  while ((dm = dynRe.exec(text))) {
    const v = dm[1];
    const arg = dm[2];
    // skip if it's actually the hook declaration (preceded by = useTranslations)
    const before = text.slice(Math.max(0, dm.index - 25), dm.index);
    if (/(?:use|get)Translations\s*$/.test(before)) continue;
    // skip pure static (already handled): a plain-quote literal not concatenated.
    // (capture excludes ")", so allow end-of-arg too). Backticks are NOT skipped
    // so template-with-interp keys still surface in the dynamic list.
    if (/^(["'])(?:\\.|(?!\1).)*\1\s*(?:$|[,)])/.test(arg)) continue;
    // skip empty / immediate close
    if (/^\s*[)]/.test(arg)) continue;
    dynamic.push({
      file: path.relative(ROOT, file),
      line: lineOf(text, dm.index),
      var: v,
      text: `${v}(${arg.trim().slice(0, 45)}`,
    });
  }
}

console.log("=== MISSING STATIC KEYS (referenced but not in es.json) ===");
const sortedMissing = [...missing.keys()].sort();
for (const k of sortedMissing) {
  const refs = missing.get(k);
  console.log(`\n${k}`);
  for (const r of refs.slice(0, 4)) console.log(`    ${r.file}:${r.line}`);
  if (refs.length > 4) console.log(`    … +${refs.length - 4} more`);
}
console.log(`\nTOTAL missing static keys: ${sortedMissing.length}`);

if (dynamic.length) {
  console.log("\n\n=== DYNAMIC CALLS (cannot audit statically) ===");
  for (const d of dynamic) console.log(`  ${d.file}:${d.line}  ${d.var}(${d.text})`);
}
