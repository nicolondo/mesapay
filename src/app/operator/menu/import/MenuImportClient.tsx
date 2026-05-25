"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";
import type { MenuTag } from "@/lib/menuTags";

type CategoryKind = "starter" | "main" | "side" | "drink" | "dessert" | "other";
// Tag slugs are now per-restaurant. We treat the extracted/edited value
// as a plain string and filter against the registry at render time.
type Tag = string;

type ExistingCategory = {
  id: string;
  slug: string;
  label: string;
  kind: CategoryKind;
};

type ExtractedItem = {
  name: string;
  description: string | null;
  priceCents: number;
  categorySlug: string;
  tags: Tag[];
  // Local /uploads/menu-import/... path (already downloaded server-side
  // when extracting). null when the AI didn't find an image or it
  // failed to download.
  photoUrl: string | null;
  confidence: number;
};

type ExtractedCategory = {
  slug: string;
  label: string;
  kind: CategoryKind;
  sortOrder: number;
};

// Per-item local state — extends the extracted shape with edit + selection.
type EditableItem = ExtractedItem & {
  // Local id so React keys are stable through edits.
  localId: string;
  // Whether the operator will import this item. They can toggle off
  // dishes the AI mis-extracted instead of having to delete them.
  selected: boolean;
};

const KIND_LABELS: Record<CategoryKind, string> = {
  starter: "Entradas",
  main: "Principales",
  side: "Acompañamientos",
  drink: "Bebidas",
  dessert: "Postres",
  other: "Otro",
};

export function MenuImportClient({
  tenantName,
  initialCategories,
  menus,
  initialMenuId,
  menuTags,
}: {
  tenantName: string;
  initialCategories: ExistingCategory[];
  // Available top-level menus. Picker only shown when >1 exists.
  menus: { id: string; label: string; slug: string }[];
  // Pre-selected target menu id (from ?menu=… in the URL). The button
  // on the editor passes whichever carta tab was active so the import
  // lands there by default. Falls back to the first menu when unset
  // or stale.
  initialMenuId: string | null;
  // Tag registry of this restaurant — drives the chips shown in the
  // review step. Unknown slugs returned by the AI are dropped silently.
  menuTags: MenuTag[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  // Stage of the wizard:
  // upload → extracting → review → done
  const [stage, setStage] = useState<
    "upload" | "extracting" | "review" | "done"
  >("upload");
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  // Which menu new categories from this import should land in. Defaults
  // to the first menu (Carta). Only matters when the restaurant has more
  // than one menu configured.
  const [targetMenuId, setTargetMenuId] = useState<string>(
    initialMenuId ?? menus[0]?.id ?? "",
  );
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [extractedCats, setExtractedCats] = useState<ExtractedCategory[]>([]);
  const [items, setItems] = useState<EditableItem[]>([]);
  const [extractionNotes, setExtractionNotes] = useState<string | null>(null);
  const [busyConfirm, setBusyConfirm] = useState(false);
  const [createdCount, setCreatedCount] = useState(0);

  // Build the union of categories the user can pick from when reviewing.
  // Existing categories (real DB rows) keep their id; extracted ones are
  // referenced by slug and created on confirm.
  const allCategoryChoices = useMemo(() => {
    const fromExisting = initialCategories.map((c) => ({
      key: `existing:${c.id}`,
      label: c.label,
      slug: c.slug,
      kind: c.kind,
      isNew: false,
    }));
    const existingSlugs = new Set(initialCategories.map((c) => c.slug));
    const fromExtracted = extractedCats
      .filter((c) => !existingSlugs.has(c.slug))
      .map((c) => ({
        key: `new:${c.slug}`,
        label: c.label + " · nueva",
        slug: c.slug,
        kind: c.kind,
        isNew: true,
      }));
    return [...fromExisting, ...fromExtracted];
  }, [initialCategories, extractedCats]);

  // Source URL state: when the operator imports from a URL we hide the
  // file preview and show the URL instead in the sidebar.
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);

  function applyExtraction(payload: {
    extraction: {
      categories: ExtractedCategory[];
      items: ExtractedItem[];
      notes?: string;
    };
  }): boolean {
    const ext = payload.extraction;
    if (ext.items.length === 0) {
      // The extractor returns a `notes` blurb on failure — e.g.
      // "model returned non-JSON: …" when the response got truncated,
      // or "schema mismatch: …" when a field is wrong. Surfacing it
      // helps debug instead of silently telling the operator to "try
      // again". Cap length so a runaway model dump doesn't break the
      // banner layout.
      const reason = ext.notes ? ` — ${ext.notes.slice(0, 240)}` : "";
      setError(
        `No detectamos platos. Prueba con una imagen más clara, otra URL, o sube un PDF.${reason}`,
      );
      setStage("upload");
      return false;
    }
    setExtractedCats(ext.categories);
    setExtractionNotes(ext.notes ?? null);
    setItems(
      ext.items.map((it, i) => ({
        ...it,
        localId: `item-${i}-${Math.random().toString(36).slice(2, 6)}`,
        selected: true,
      })),
    );
    setStage("review");
    return true;
  }

  async function onFileChosen(f: File) {
    setError(null);
    setFile(f);
    setFilePreviewUrl(URL.createObjectURL(f));
    setSourceUrl(null);
    setStage("extracting");
    const fd = new FormData();
    fd.append("file", f);
    const startedAt = Date.now();
    let res: Response | null = null;
    try {
      res = await fetch("/api/operator/menu/import", {
        method: "POST",
        body: fd,
      });
    } catch (err) {
      // True network drop: fetch() rejected before getting any response
      // (DNS failure, connection reset, offline). We DON'T fall here on
      // nginx returning 413/502/504 — those resolve fetch() with a non-OK
      // status, handled below.
      const secs = Math.round((Date.now() - startedAt) / 1000);
      setError(
        `No se pudo conectar al servidor (${secs}s). ${err instanceof Error ? err.message : ""}`,
      );
      setStage("upload");
      return;
    }
    // Parse the body once, tolerantly — nginx error pages aren't JSON,
    // and surfacing the raw text is the only way the diagnosis is
    // possible without browser devtools.
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const ct = res.headers.get("content-type") ?? "";
    let body: { message?: string; error?: string } | string;
    try {
      body = ct.includes("application/json")
        ? ((await res.json()) as { message?: string; error?: string })
        : ((await res.text()) as string).slice(0, 240);
    } catch {
      body = "(respuesta vacía o inválida)";
    }
    if (!res.ok) {
      // Surface the actual HTTP status + body so the operator (and us)
      // can tell apart "PDF too big" (413), "model timed out" (504),
      // "service is restarting" (502), "bad request" (400+).
      const reason =
        typeof body === "string"
          ? body || res.statusText
          : (body.message ?? body.error ?? res.statusText);
      setError(`Error ${res.status} tras ${elapsed}s — ${reason}`);
      setStage("upload");
      return;
    }
    if (typeof body === "string") {
      setError(`Respuesta inesperada del servidor (${elapsed}s).`);
      setStage("upload");
      return;
    }
    applyExtraction(body as never);
  }

  async function onUrlSubmitted(url: string) {
    setError(null);
    setFile(null);
    setFilePreviewUrl(null);
    setSourceUrl(url);
    setStage("extracting");
    try {
      const res = await fetch("/api/operator/menu/import/from-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.message ?? j.error ?? "No pudimos leer el sitio.");
        setStage("upload");
        return;
      }
      setSourceUrl(j.sourceUrl ?? url);
      applyExtraction(j);
    } catch {
      setError("Falla de red al consultar el sitio.");
      setStage("upload");
    }
  }

  function patchItem(localId: string, patch: Partial<EditableItem>) {
    setItems((prev) =>
      prev.map((i) => (i.localId === localId ? { ...i, ...patch } : i)),
    );
  }

  function toggleTag(localId: string, tag: Tag) {
    setItems((prev) =>
      prev.map((i) => {
        if (i.localId !== localId) return i;
        const has = i.tags.includes(tag);
        return {
          ...i,
          tags: has ? i.tags.filter((t) => t !== tag) : [...i.tags, tag],
        };
      }),
    );
  }

  function selectAll(value: boolean) {
    setItems((prev) => prev.map((i) => ({ ...i, selected: value })));
  }

  async function confirmImport() {
    setBusyConfirm(true);
    setError(null);
    const selected = items.filter((i) => i.selected);
    if (selected.length === 0) {
      setError("Selecciona al menos un plato para importar.");
      setBusyConfirm(false);
      return;
    }
    const payload = {
      items: selected.map((it) => {
        const existing = initialCategories.find(
          (c) => c.slug === it.categorySlug,
        );
        const extractedCat = extractedCats.find(
          (c) => c.slug === it.categorySlug,
        );
        const categoryRef = existing
          ? { kind: "existing" as const, categoryId: existing.id }
          : {
              kind: "new" as const,
              slug: it.categorySlug,
              label: extractedCat?.label ?? it.categorySlug,
              categoryKind: extractedCat?.kind ?? "other",
            };
        return {
          name: it.name.trim(),
          description: it.description?.trim() || null,
          priceCents: it.priceCents,
          categoryRef,
          tags: it.tags,
          photoUrl: it.photoUrl ?? null,
        };
      }),
      // Tell the server which menu the new categories should land in.
      // Server validates ownership; when omitted it falls back to Carta.
      ...(targetMenuId ? { menuId: targetMenuId } : {}),
    };
    const res = await fetch("/api/operator/menu/import/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusyConfirm(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "No pudimos importar los platos.");
      return;
    }
    const j = await res.json();
    setCreatedCount(j.createdCount);
    setStage("done");
    startTx(() => router.refresh());
  }

  if (stage === "done") {
    return (
      <div className="p-6 max-w-2xl mx-auto w-full">
        <div className="rounded-2xl border border-ok/30 bg-ok/10 p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto inline-flex items-center justify-center font-display text-3xl">
            ✓
          </div>
          <h1 className="font-display text-3xl mt-4">
            {createdCount} platos importados
          </h1>
          <p className="text-sm text-op-muted mt-2">
            Ya están en tu menú. Puedes ajustar fotos, modificadores y orden
            desde la edición normal.
          </p>
          <div className="mt-6 flex gap-2 justify-center">
            <Link
              href="/operator/menu"
              className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center"
            >
              Ver mi menú
            </Link>
            <button
              type="button"
              onClick={() => {
                setStage("upload");
                setFile(null);
                setFilePreviewUrl(null);
                setItems([]);
                setExtractedCats([]);
                setCreatedCount(0);
              }}
              className="h-10 px-5 rounded-full border border-op-border text-sm font-medium"
            >
              Importar otra carta
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto w-full">
      <div className="flex items-baseline justify-between mb-1">
        <div className="font-display text-3xl">Importar carta con AI</div>
        <Link
          href="/operator/menu"
          className="text-sm text-op-muted hover:text-op-text"
        >
          ← Volver al menú
        </Link>
      </div>
      <p className="text-sm text-op-muted mb-6">
        Sube la carta de <strong>{tenantName}</strong> (PDF, JPG o foto desde
        el celular) y la AI extrae los platos. Después los revisas, ajustas
        y los importas todos de un solo tap.
      </p>

      <Stepper stage={stage} />

      {error && (
        <div className="mt-4 p-3 rounded-xl bg-danger/10 text-danger text-sm">
          {error}
        </div>
      )}

      {stage === "upload" && (
        <>
          {/* Destination menu picker. Only relevant when the restaurant
              has split its menu into multiple books (Carta + Vinos +
              ...). For everyone else the value is fixed to Carta and
              the picker is hidden to keep the import dead-simple. */}
          {menus.length > 1 && (
            <div className="mb-5 bg-op-surface border border-op-border rounded-2xl p-4">
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
                Importar a
              </div>
              <select
                value={targetMenuId}
                onChange={(e) => setTargetMenuId(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              >
                {menus.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-op-muted mt-2">
                Las categorías nuevas se crearán en este menú. Las que
                existan se actualizan donde estén.
              </p>
            </div>
          )}
          <UploadDrop onFile={onFileChosen} onUrl={onUrlSubmitted} />
        </>
      )}

      {stage === "extracting" && (
        <ExtractingState fileName={file?.name ?? sourceUrl ?? null} />
      )}

      {stage === "review" && (
        <ReviewState
          fileName={file?.name ?? null}
          filePreviewUrl={filePreviewUrl}
          sourceUrl={sourceUrl}
          items={items}
          extractionNotes={extractionNotes}
          categoryChoices={allCategoryChoices}
          menuTags={menuTags}
          onPatch={patchItem}
          onToggleTag={toggleTag}
          onSelectAll={selectAll}
          onConfirm={confirmImport}
          busy={busyConfirm}
        />
      )}
    </div>
  );
}

// ---------- Stepper ----------

function Stepper({
  stage,
}: {
  stage: "upload" | "extracting" | "review" | "done";
}) {
  const steps = [
    { id: "upload", label: "Subir carta" },
    { id: "extracting", label: "Leer con AI" },
    { id: "review", label: "Revisar y editar" },
  ];
  const activeIdx = steps.findIndex((s) => s.id === stage);
  return (
    <ol className="flex items-center gap-1.5 mb-6 text-xs">
      {steps.map((s, i) => {
        const active = i === activeIdx;
        const done = i < activeIdx;
        return (
          <li key={s.id} className="flex items-center gap-1.5">
            <span
              className={
                "inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-medium " +
                (done
                  ? "bg-ok text-bone"
                  : active
                    ? "bg-ink text-bone"
                    : "bg-op-bg text-op-muted border border-op-border")
              }
            >
              {done ? "✓" : i + 1}
            </span>
            <span
              className={
                active
                  ? "text-ink font-medium"
                  : done
                    ? "text-op-text"
                    : "text-op-muted"
              }
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span className="text-op-muted mx-1">→</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Upload ----------

function UploadDrop({
  onFile,
  onUrl,
}: {
  onFile: (f: File) => void;
  onUrl: (url: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  const urlValid =
    trimmed.length > 4 &&
    (/^https?:\/\//i.test(trimmed) ||
      /^[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed));

  return (
    <div className="space-y-4">
      <label
        htmlFor="menu-import-file"
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className={
          "block rounded-3xl border-2 border-dashed p-12 text-center cursor-pointer transition-colors " +
          (dragOver
            ? "border-terracotta bg-terracotta/10"
            : "border-op-border bg-op-surface hover:bg-op-bg")
        }
      >
        <div className="text-5xl mb-4">📄</div>
        <div className="font-display text-2xl mb-1">
          {dragOver ? "Suelta aquí" : "Arrastra tu carta o haz click"}
        </div>
        <div className="text-sm text-op-muted">
          PDF, JPG, PNG o WebP · máx 45 MB
        </div>
        <div className="text-[11px] text-op-muted mt-3">
          Funciona con cartas escaneadas, fotos del menú impreso, o PDFs hechos
          en Word/Canva. La AI lee todo y arma los platos por ti.
        </div>
        <input
          id="menu-import-file"
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.currentTarget.value = "";
          }}
        />
      </label>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-op-border" />
        <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          O pega un enlace
        </span>
        <div className="flex-1 h-px bg-op-border" />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (urlValid) onUrl(trimmed);
        }}
        className="rounded-2xl border border-op-border bg-op-surface p-4"
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl">🔗</span>
          <div>
            <div className="font-display text-base leading-tight">
              ¿La carta está en una página web?
            </div>
            <div className="text-[11px] text-op-muted mt-0.5">
              Pega el link a la página de la carta o un PDF público.
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://restaurante.com/carta"
            className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
            autoComplete="url"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={!urlValid}
            className="h-11 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
          >
            Leer
          </button>
        </div>
        <div className="text-[11px] text-op-muted mt-2">
          También funciona con links directos a PDFs (ej.{" "}
          <span className="font-mono">restaurante.com/menu.pdf</span>).
        </div>
      </form>
    </div>
  );
}

// ---------- Extracting ----------

function ExtractingState({ fileName }: { fileName: string | null }) {
  return (
    <div className="rounded-3xl border border-op-border bg-op-surface p-16 text-center">
      <div className="relative w-16 h-16 mx-auto mb-6">
        <div className="absolute inset-0 rounded-full bg-terracotta/15 animate-ping" />
        <div className="absolute inset-2 rounded-full bg-terracotta/25" />
        <div className="absolute inset-0 flex items-center justify-center text-2xl">
          🧠
        </div>
      </div>
      <div className="font-display text-2xl mb-1">Leyendo tu carta…</div>
      <div className="text-sm text-op-muted">
        {fileName && (
          <>
            <span className="font-mono">{fileName}</span> ·{" "}
          </>
        )}
        Esto toma unos 10-30 segundos. La AI está identificando categorías,
        platos, precios y descripciones.
      </div>
    </div>
  );
}

// ---------- Review ----------

function ReviewState({
  fileName,
  filePreviewUrl,
  sourceUrl,
  items,
  extractionNotes,
  categoryChoices,
  menuTags,
  onPatch,
  onToggleTag,
  onSelectAll,
  onConfirm,
  busy,
}: {
  fileName: string | null;
  filePreviewUrl: string | null;
  sourceUrl: string | null;
  items: EditableItem[];
  extractionNotes: string | null;
  categoryChoices: {
    key: string;
    slug: string;
    label: string;
    kind: CategoryKind;
    isNew: boolean;
  }[];
  menuTags: MenuTag[];
  onPatch: (id: string, patch: Partial<EditableItem>) => void;
  onToggleTag: (id: string, tag: Tag) => void;
  onSelectAll: (value: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const selectedCount = items.filter((i) => i.selected).length;
  const totalValue = items
    .filter((i) => i.selected)
    .reduce((s, i) => s + i.priceCents, 0);
  const withPhotoCount = items.filter((i) => i.selected && i.photoUrl).length;
  // Group items by category for visual breathing room. Categories are
  // shown in the order they first appear in the items list (matches the
  // order the AI returned them, which mirrors the PDF).
  const grouped = useMemo(() => {
    const map = new Map<string, EditableItem[]>();
    for (const it of items) {
      const arr = map.get(it.categorySlug) ?? [];
      arr.push(it);
      map.set(it.categorySlug, arr);
    }
    return Array.from(map.entries());
  }, [items]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      <div>
        <div className="rounded-2xl bg-op-surface border border-op-border p-4 mb-4 flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Platos detectados
            </div>
            <div className="font-display text-3xl tabular">{items.length}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectAll(true)}
              className="h-8 px-3 rounded-full border border-op-border text-xs hover:bg-op-bg"
            >
              Seleccionar todos
            </button>
            <button
              type="button"
              onClick={() => onSelectAll(false)}
              className="h-8 px-3 rounded-full border border-op-border text-xs hover:bg-op-bg"
            >
              Quitar selección
            </button>
          </div>
        </div>

        {extractionNotes && (
          <div className="mb-4 p-3 rounded-xl bg-[#C98A2E]/10 text-[#7F5A1F] text-xs">
            Nota de la AI: {extractionNotes}
          </div>
        )}

        <div className="space-y-6">
          {grouped.map(([catSlug, catItems]) => {
            const cat = categoryChoices.find((c) => c.slug === catSlug);
            return (
              <section key={catSlug}>
                <div className="flex items-baseline justify-between mb-2">
                  <div>
                    <div className="font-display text-xl">
                      {cat?.label ?? catSlug}
                    </div>
                    {cat?.isNew && (
                      <span className="inline-block mt-0.5 text-[10px] font-mono tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
                        Nueva categoría
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] text-op-muted tabular">
                    {catItems.length}
                  </div>
                </div>
                <ul className="space-y-3">
                  {catItems.map((item) => (
                    <ReviewCard
                      key={item.localId}
                      item={item}
                      categoryChoices={categoryChoices}
                      menuTags={menuTags}
                      onPatch={(patch) => onPatch(item.localId, patch)}
                      onToggleTag={(t) => onToggleTag(item.localId, t)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>

      <aside className="lg:sticky lg:top-6 lg:self-start space-y-4">
        {filePreviewUrl && fileName && (
          <div className="rounded-2xl border border-op-border bg-op-surface p-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
              Archivo original
            </div>
            <a
              href={filePreviewUrl}
              target="_blank"
              rel="noreferrer"
              className="block bg-op-bg rounded-lg overflow-hidden border border-op-border"
            >
              {fileName.toLowerCase().endsWith(".pdf") ? (
                <div className="aspect-[3/4] flex items-center justify-center text-op-muted">
                  <div className="text-center">
                    <div className="text-5xl mb-2">📄</div>
                    <div className="text-xs truncate px-2">{fileName}</div>
                    <div className="text-[10px] mt-1">Click para abrir</div>
                  </div>
                </div>
              ) : (
                <img
                  src={filePreviewUrl}
                  alt="Carta"
                  className="w-full h-auto"
                />
              )}
            </a>
          </div>
        )}
        {!filePreviewUrl && sourceUrl && (
          <div className="rounded-2xl border border-op-border bg-op-surface p-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
              Fuente
            </div>
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 bg-op-bg rounded-lg border border-op-border p-3 hover:border-terracotta"
            >
              <span className="text-2xl shrink-0">🔗</span>
              <div className="min-w-0">
                <div className="text-[11px] text-op-muted">URL</div>
                <div className="text-xs font-mono truncate text-terracotta">
                  {sourceUrl}
                </div>
              </div>
            </a>
          </div>
        )}

        <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Vas a importar
            </div>
            <div className="font-display text-2xl">{selectedCount}</div>
          </div>
          <div className="flex items-baseline justify-between text-xs text-op-muted">
            <span>Valor sumado</span>
            <span className="font-mono tabular">{fmtCOP(totalValue)}</span>
          </div>
          {withPhotoCount > 0 && (
            <div className="flex items-baseline justify-between text-xs text-op-muted">
              <span>📸 Con foto</span>
              <span className="font-mono tabular">{withPhotoCount}</span>
            </div>
          )}
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || selectedCount === 0}
            className="w-full h-12 mt-2 rounded-full bg-terracotta text-bone font-medium disabled:opacity-50"
          >
            {busy
              ? "Importando…"
              : `Importar ${selectedCount} plato${selectedCount === 1 ? "" : "s"}`}
          </button>
          <p className="text-[11px] text-op-muted-2 text-center">
            Después podrás agregar fotos y modificadores desde el menú normal.
          </p>
        </div>
      </aside>
    </div>
  );
}

function ReviewCard({
  item,
  categoryChoices,
  menuTags,
  onPatch,
  onToggleTag,
}: {
  item: EditableItem;
  categoryChoices: {
    key: string;
    slug: string;
    label: string;
    kind: CategoryKind;
    isNew: boolean;
  }[];
  menuTags: MenuTag[];
  onPatch: (patch: Partial<EditableItem>) => void;
  onToggleTag: (t: Tag) => void;
}) {
  const lowConfidence = item.confidence < 0.6;
  const priceCop = Math.round(item.priceCents / 100);
  return (
    <li
      className={
        "rounded-xl border bg-op-surface p-4 transition-opacity " +
        (item.selected ? "border-op-border" : "border-dashed border-op-border opacity-50")
      }
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={item.selected}
          onChange={(e) => onPatch({ selected: e.target.checked })}
          className="mt-1 accent-terracotta w-4 h-4 shrink-0"
        />
        {item.photoUrl && (
          <div className="relative shrink-0">
            <img
              src={item.photoUrl}
              alt={item.name}
              className="w-16 h-16 rounded-lg object-cover border border-op-border"
            />
            <button
              type="button"
              onClick={() => onPatch({ photoUrl: null })}
              title="Quitar foto"
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-ink text-bone text-[10px] inline-flex items-center justify-center shadow"
              aria-label="Quitar foto"
            >
              ×
            </button>
          </div>
        )}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-start gap-2">
            <input
              value={item.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              placeholder="Nombre del plato"
              className="flex-1 min-w-0 h-9 px-2 -mx-2 rounded-md font-display text-lg leading-tight bg-transparent focus:bg-op-bg focus:outline-none border border-transparent focus:border-op-border"
            />
            <div className="shrink-0 flex items-center gap-1">
              <span className="text-op-muted text-sm">$</span>
              <input
                type="number"
                inputMode="numeric"
                value={priceCop}
                onChange={(e) =>
                  onPatch({
                    priceCents: Math.max(0, parseInt(e.target.value, 10) || 0) * 100,
                  })
                }
                className="w-28 h-9 px-2 rounded-md font-mono tabular text-right bg-op-bg border border-op-border focus:outline-none focus:border-terracotta"
              />
            </div>
          </div>

          <textarea
            value={item.description ?? ""}
            onChange={(e) =>
              onPatch({
                description: e.target.value.length === 0 ? null : e.target.value,
              })
            }
            placeholder="Descripción (opcional)"
            rows={1}
            className="w-full text-sm px-2 py-1.5 rounded-md bg-transparent focus:bg-op-bg focus:outline-none border border-transparent focus:border-op-border resize-y"
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5">
              <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                Categoría
              </span>
              <select
                value={item.categorySlug}
                onChange={(e) => onPatch({ categorySlug: e.target.value })}
                className="h-7 px-2 rounded-md border border-op-border bg-op-bg text-xs"
              >
                {categoryChoices.map((c) => (
                  <option key={c.key} value={c.slug}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-1">
              {menuTags.map((mt) => {
                const active = item.tags.includes(mt.slug);
                return (
                  <button
                    key={mt.slug}
                    type="button"
                    onClick={() => onToggleTag(mt.slug)}
                    className={
                      "h-6 px-2 rounded-full text-[10px] font-medium border inline-flex items-center gap-1 " +
                      (active
                        ? "bg-terracotta text-bone border-terracotta"
                        : "bg-op-bg text-op-muted border-op-border hover:border-terracotta")
                    }
                  >
                    {mt.emoji && <span aria-hidden>{mt.emoji}</span>}
                    {mt.label}
                  </button>
                );
              })}
            </div>
            {lowConfidence && (
              <span className="ml-auto text-[10px] text-[#7F5A1F] bg-[#C98A2E]/15 px-2 py-0.5 rounded-full">
                Revisar (confianza {(item.confidence * 100).toFixed(0)}%)
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
