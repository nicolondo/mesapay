import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import {
  CLIENT_NAMESPACES,
  FULL_CATALOG_AREAS,
  GLOBAL_NAMESPACES,
  pickMessages,
  surfaceNamespaces,
  type Surface,
} from "./clientMessages";

/*
 * Guardarraíl de src/i18n/clientMessages.ts.
 *
 * Por qué un grafo de imports y no "todos los archivos de la carpeta": las
 * pantallas públicas usan muchísimos componentes compartidos de
 * src/components/** (carta, pago, factura…) y, al revés, las carpetas
 * públicas no contienen todo lo que montan. Recorrer los imports reales desde
 * los archivos especiales de Next (page/layout/loading/error…) es la única
 * forma de saber qué Client Components acaban en el navegador de cada
 * superficie. El recorrido distingue el contexto: un archivo sin directiva
 * importado desde un Server Component corre en el server (lee el catálogo
 * del request config y no necesita nada del provider); el mismo archivo
 * importado desde un "use client" corre en el cliente. El análisis es por
 * archivo (si un archivo "use client" exporta varios componentes, cuenta
 * todos), así que sobra un poco pero nunca falta.
 */

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");
const APP = path.join(SRC, "app");

const CODE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];
/** Imports que no son código (no pueden llamar a useTranslations). */
const ASSET_EXT = /\.(css|scss|json|svg|png|jpe?g|webp|gif|ico|md|txt|woff2?)$/i;
/** Archivos especiales de Next que son puntos de entrada de una ruta. */
const SPECIAL_FILE =
  /^(page|layout|template|loading|error|not-found|default|global-error|forbidden|unauthorized)\.(tsx|ts|jsx|js)$/;
const INTL_MODULES = new Set(["next-intl", "use-intl", "use-intl/react"]);

type FileInfo = {
  directive: "client" | "server" | null;
  imports: string[];
  namespaces: { ns: string; line: number }[];
  problems: { line: number; msg: string }[];
};

const rel = (file: string) => path.relative(ROOT, file);

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../"))
    base = path.resolve(path.dirname(from), spec);
  else return null; // paquete de node_modules
  if (ASSET_EXT.test(base)) return null;
  const candidates = [
    base,
    ...CODE_EXTS.map((e) => base + e),
    ...CODE_EXTS.map((e) => path.join(base, "index" + e)),
  ];
  for (const c of candidates) {
    if (CODE_EXTS.includes(path.extname(c)) && fs.existsSync(c) && fs.statSync(c).isFile()) {
      return c;
    }
  }
  // Mejor fallar que dejar un hueco silencioso en el grafo.
  throw new Error(`No se pudo resolver el import "${spec}" desde ${rel(from)}`);
}

const infoCache = new Map<string, FileInfo>();

function fileInfo(file: string): FileInfo {
  const cached = infoCache.get(file);
  if (cached) return cached;
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const info: FileInfo = { directive: null, imports: [], namespaces: [], problems: [] };
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  // Directivas del prólogo ("use client" / "use server").
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === "use client") info.directive = "client";
    if (st.expression.text === "use server") info.directive = "server";
  }

  const translationHooks = new Set<string>();
  const addImport = (spec: string) => {
    const resolved = resolveImport(spec, file);
    if (resolved) info.imports.push(resolved);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const spec = node.moduleSpecifier.text;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements
        : undefined;
      const onlyTypes =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name && !!named && named.length > 0 && named.every((el) => el.isTypeOnly)));
      if (!onlyTypes) addImport(spec);
      if (INTL_MODULES.has(spec) && named) {
        for (const el of named) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === "useTranslations") translationHooks.add(el.name.text);
          if (imported === "useMessages") {
            info.problems.push({
              line: line(el),
              msg: "usa useMessages(): necesita el catálogo entero y no se puede recortar",
            });
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      addImport(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg)) {
        addImport(arg.text);
      }
      if (ts.isIdentifier(node.expression) && translationHooks.has(node.expression.text)) {
        if (!arg) {
          info.problems.push({
            line: line(node),
            msg: "useTranslations() sin namespace: pásale uno para poder recortar el catálogo",
          });
        } else if (ts.isStringLiteralLike(arg)) {
          info.namespaces.push({ ns: arg.text.split(".")[0], line: line(node) });
        } else {
          info.problems.push({
            line: line(node),
            msg: "useTranslations con namespace dinámico: usa un literal",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  infoCache.set(file, info);
  return info;
}

type Usage = { ns: string; file: string; line: number };

/**
 * Recorre el grafo desde los puntos de entrada y devuelve los namespaces que
 * usan los archivos que terminan en el cliente.
 */
function clientUsages(entries: string[]) {
  const usages: Usage[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, inClient: boolean) => {
    const info = fileInfo(file);
    // Una server action importada desde el cliente es sólo una referencia.
    if (info.directive === "server") return;
    const client = inClient || info.directive === "client";
    const key = `${client ? "c" : "s"}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (client) {
      for (const n of info.namespaces) usages.push({ ns: n.ns, file: rel(file), line: n.line });
      for (const p of info.problems) problems.push(`${rel(file)}:${p.line} ${p.msg}`);
    }
    for (const imp of info.imports) walk(imp, client);
  };
  for (const e of entries) walk(e, false);
  return { usages, problems };
}

function specialFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...specialFiles(full, true));
    } else if (SPECIAL_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Carpetas de primer nivel con páginas (las de sólo route handlers no pintan nada). */
const topLevelDirs = fs
  .readdirSync(APP, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "api")
  .map((d) => d.name)
  .filter((name) => specialFiles(path.join(APP, name), true).length > 0)
  .sort();

const fullAreas = new Set<string>(FULL_CATALOG_AREAS);
const surfaces = Object.keys(CLIENT_NAMESPACES) as Surface[];
const catalog = es as Record<string, unknown>;

/** Puntos de entrada y archivo que monta el provider de cada superficie. */
function surfaceEntries(surface: Surface) {
  if (surface === "portada") {
    const page = path.join(APP, "page.tsx");
    return { entries: [page], providerFile: page };
  }
  const dir = path.join(APP, surface);
  return { entries: specialFiles(dir, true), providerFile: path.join(dir, "layout.tsx") };
}

function missingReport(surface: Surface, usages: Usage[], allowed: Set<string>) {
  const byNs = new Map<string, Usage[]>();
  for (const u of usages) {
    if (allowed.has(u.ns)) continue;
    byNs.set(u.ns, [...(byNs.get(u.ns) ?? []), u]);
  }
  return [...byNs.entries()].map(
    ([ns, us]) =>
      `Falta el namespace "${ns}" en CLIENT_NAMESPACES.${surface} (src/i18n/clientMessages.ts). ` +
      `Lo usa: ${[...new Set(us.map((u) => `${u.file}:${u.line}`))].join(", ")}`,
  );
}

describe("clientMessages: clasificación de src/app", () => {
  it("toda carpeta de primer nivel es área con sesión o superficie pública (no ambas)", () => {
    const problems: string[] = [];
    for (const dir of topLevelDirs) {
      const isFull = fullAreas.has(dir);
      const isPublic = (surfaces as string[]).includes(dir);
      if (!isFull && !isPublic) {
        problems.push(
          `src/app/${dir} no está clasificada: si es del equipo con sesión añádela a ` +
            `FULL_CATALOG_AREAS; si es pública, a CLIENT_NAMESPACES (src/i18n/clientMessages.ts) ` +
            `y monta <SurfaceIntlProvider surface="${dir}"> en src/app/${dir}/layout.tsx`,
        );
      }
      if (isFull && isPublic) problems.push(`src/app/${dir} está en FULL_CATALOG_AREAS y en CLIENT_NAMESPACES`);
    }
    for (const area of FULL_CATALOG_AREAS) {
      if (!topLevelDirs.includes(area)) problems.push(`FULL_CATALOG_AREAS tiene "${area}", que ya no existe en src/app`);
    }
    for (const s of surfaces) {
      if (s !== "portada" && !topLevelDirs.includes(s)) {
        problems.push(`CLIENT_NAMESPACES tiene "${s}", que ya no existe en src/app`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("no hay archivos especiales sueltos en src/app aparte del layout raíz y la portada", () => {
    const loose = specialFiles(APP, false).map(rel);
    expect(loose).toEqual(["src/app/layout.tsx", "src/app/page.tsx"]);
  });

  it("cada área con sesión monta <FullIntlProvider> en su layout.tsx", () => {
    const problems: string[] = [];
    for (const area of FULL_CATALOG_AREAS) {
      const layout = path.join(APP, area, "layout.tsx");
      if (!fs.existsSync(layout)) problems.push(`Falta src/app/${area}/layout.tsx con <FullIntlProvider>`);
      else if (!/<FullIntlProvider>/.test(fs.readFileSync(layout, "utf8")))
        problems.push(`src/app/${area}/layout.tsx no envuelve su contenido con <FullIntlProvider>`);
    }
    expect(problems).toEqual([]);
  });

  it("cada superficie pública con namespaces propios monta su <SurfaceIntlProvider>", () => {
    // Una superficie con lista vacía no necesita provider propio: hereda el
    // del layout raíz (locale + GLOBAL_NAMESPACES), que es justo lo que pide.
    const problems: string[] = [];
    for (const s of surfaces) {
      if (CLIENT_NAMESPACES[s].length === 0) continue;
      const { providerFile } = surfaceEntries(s);
      const tag = `<SurfaceIntlProvider surface="${s}">`;
      if (!fs.existsSync(providerFile)) problems.push(`Falta ${rel(providerFile)} con ${tag}`);
      else if (!fs.readFileSync(providerFile, "utf8").includes(tag))
        problems.push(`${rel(providerFile)} no envuelve su contenido con ${tag}`);
    }
    expect(problems).toEqual([]);
  });

  it("el layout raíz sólo envía GLOBAL_NAMESPACES", () => {
    const src = fs.readFileSync(path.join(APP, "layout.tsx"), "utf8");
    expect(src).toContain("pickMessages(messages, GLOBAL_NAMESPACES)");
  });
});

describe("clientMessages: listas de namespaces", () => {
  it("todos los namespaces listados existen en es/en/pt", () => {
    const listed = new Set([...GLOBAL_NAMESPACES, ...surfaces.flatMap((s) => CLIENT_NAMESPACES[s])]);
    const problems: string[] = [];
    for (const [lang, msgs] of Object.entries({ es, en, pt })) {
      for (const ns of listed) {
        if (!(ns in (msgs as Record<string, unknown>))) problems.push(`"${ns}" no existe en messages/${lang}.json`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("el layout raíz cubre lo que usan sus Client Components", () => {
    const { usages, problems } = clientUsages([path.join(APP, "layout.tsx")]);
    expect(problems).toEqual([]);
    const missing = usages
      .filter((u) => !GLOBAL_NAMESPACES.includes(u.ns))
      .map((u) => `Falta "${u.ns}" en GLOBAL_NAMESPACES. Lo usa: ${u.file}:${u.line}`);
    expect(missing).toEqual([]);
  });

  it.each(surfaces)("superficie %s: envía todo lo que usan sus Client Components", (surface) => {
    const { entries } = surfaceEntries(surface);
    const { usages, problems } = clientUsages(entries);
    expect(problems).toEqual([]);
    expect(missingReport(surface, usages, new Set(surfaceNamespaces(surface)))).toEqual([]);
  });

  it.each(surfaces)("superficie %s: no envía namespaces que nadie usa", (surface) => {
    const { entries } = surfaceEntries(surface);
    const used = new Set(clientUsages(entries).usages.map((u) => u.ns));
    const unused = CLIENT_NAMESPACES[surface].filter(
      (ns: string) => !used.has(ns) && !GLOBAL_NAMESPACES.includes(ns),
    );
    expect(
      unused.map(
        (ns: string) =>
          `CLIENT_NAMESPACES.${surface} incluye "${ns}" pero ningún Client Component de la superficie lo usa: quítalo`,
      ),
    ).toEqual([]);
  });

  it("las listas están en orden alfabético y sin repetidos", () => {
    for (const s of surfaces) {
      const list = [...CLIENT_NAMESPACES[s]] as string[];
      expect(list, `CLIENT_NAMESPACES.${s}`).toEqual([...new Set(list)].sort());
    }
  });
});

describe("pickMessages", () => {
  it("devuelve sólo los namespaces pedidos, con las mismas referencias", () => {
    const picked = pickMessages(catalog, ["pay", "menu", "noExiste"]);
    expect(Object.keys(picked)).toEqual(["pay", "menu"]);
    expect(picked.pay).toBe(catalog.pay);
  });

  it("una superficie pública pesa mucho menos que el catálogo entero", () => {
    const full = JSON.stringify(catalog).length;
    for (const s of surfaces) {
      const size = JSON.stringify(pickMessages(catalog, surfaceNamespaces(s))).length;
      expect(size, `superficie ${s}`).toBeLessThan(full / 2);
    }
  });
});
