"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  MARKER_KIND_LIST,
  MARKER_SIZE_MAX,
  MARKER_SIZE_MIN,
  TABLE_SIZE_MAX,
  TABLE_SIZE_MIN,
  ZONE_KINDS,
  ZONE_KIND_LIST,
  type Marker,
  type MarkerKind,
  type TablePlacement,
  type TableShape,
  type Zone,
  type ZoneKind,
} from "@/lib/floorPlan";
import type { AlignMode } from "@/lib/floorPlanSnap";
import { Glyph, type UiGlyph } from "@/components/floorplan/glyphs";
import { isRectilinear, splitKey, type Doc, type DocTable, type TableMeta } from "./editorModel";

export type InspectorActions = {
  patchTable: (id: string, patch: Partial<DocTable>, tag: string) => void;
  patchPlacement: (id: string, patch: Partial<TablePlacement>, tag: string) => void;
  setTableShape: (id: string, shape: TableShape) => void;
  patchMarker: (id: string, patch: Partial<Marker>, tag: string) => void;
  patchZone: (id: string, patch: Partial<Zone>, tag: string) => void;
  rotate: (delta: number) => void;
  duplicate: () => void;
  remove: () => void;
  align: (mode: AlignMode) => void;
  distribute: (axis: "x" | "y") => void;
  zoneBool: (op: "add" | "cut") => void;
  addVertex: () => void;
  removeVertex: () => void;
  deselect: () => void;
};

const ALIGNS: { mode: AlignMode; icon: UiGlyph; label: string }[] = [
  { mode: "left", icon: "alignLeft", label: "alignLeft" },
  { mode: "centerX", icon: "alignCenterX", label: "alignCenterX" },
  { mode: "right", icon: "alignRight", label: "alignRight" },
  { mode: "top", icon: "alignTop", label: "alignTop" },
  { mode: "centerY", icon: "alignCenterY", label: "alignCenterY" },
  { mode: "bottom", icon: "alignBottom", label: "alignBottom" },
];

/**
 * Panel de propiedades de lo seleccionado. Todo lo que se cambia acá se
 * guarda con «Guardar mapa» y se puede deshacer, igual que lo que se
 * arrastra en el plano. Es también la alternativa sin gestos: tamaño,
 * giro y alineación exactos con botones y campos.
 */
export function Inspector({
  doc,
  metas,
  sel,
  overlaps,
  activeVertex,
  boolTool,
  busy,
  actions,
}: {
  doc: Doc;
  metas: TableMeta[];
  sel: string[];
  overlaps: ReadonlySet<string>;
  activeVertex: number | null;
  /** Herramienta ampliar/recortar armada, para marcar el botón. */
  boolTool: "add" | "cut" | null;
  busy: boolean;
  actions: InspectorActions;
}) {
  const t = useTranslations("opSalon");
  const tf = useTranslations("floorPlan");
  if (sel.length === 0) return null;

  if (sel.length > 1) {
    const hasZone = sel.some((k) => k[0] === "z");
    const onlyTables = sel.every((k) => k[0] === "t");
    return (
      <Panel title={t("multiTitle", { count: sel.length })} onClose={actions.deselect} closeLabel={t("deselect")}>
        <div>
          <FieldLabel>{t("alignHeading")}</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {ALIGNS.map((a) => (
              <IconButton key={a.mode} icon={a.icon} label={t(a.label)} onClick={() => actions.align(a.mode)} />
            ))}
          </div>
        </div>
        <div>
          <FieldLabel>{t("distributeHeading")}</FieldLabel>
          <div className="flex flex-wrap items-center gap-1.5">
            <IconButton
              icon="distributeX"
              label={t("distributeX")}
              disabled={sel.length < 3}
              onClick={() => actions.distribute("x")}
            />
            <IconButton
              icon="distributeY"
              label={t("distributeY")}
              disabled={sel.length < 3}
              onClick={() => actions.distribute("y")}
            />
            {sel.length < 3 && <span className="text-xs text-op-muted">{t("distributeNeed3")}</span>}
          </div>
        </div>
        {!hasZone && (
          <div>
            <FieldLabel>{t("fieldRotation")}</FieldLabel>
            <div className="flex gap-1.5">
              <IconButton icon="rotateCcw" label={t("rotateLeft")} onClick={() => actions.rotate(-15)} />
              <IconButton icon="rotateCw" label={t("rotateRight")} onClick={() => actions.rotate(15)} />
            </div>
          </div>
        )}
        <PanelActions>
          <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm" disabled={busy} onClick={actions.duplicate}>
            <Glyph name="duplicate" size={16} />
            {t("duplicate")}
          </button>
          <button type="button" className="mp-btn mp-btn--danger mp-btn--sm" onClick={actions.remove}>
            <Glyph name={onlyTables ? "unplace" : "trash"} size={16} />
            {onlyTables ? t("removeFromPlan") : t("delete")}
          </button>
        </PanelActions>
      </Panel>
    );
  }

  const { type, id } = splitKey(sel[0]);

  if (type === "t") {
    const table = doc.tables[id];
    const meta = metas.find((m) => m.id === id);
    const p = table?.placement;
    if (!table || !meta || !p) return null;
    const cm = (v: number) => Math.round(v * 100);
    return (
      <Panel
        title={t("tableTitle", { number: meta.number })}
        onClose={actions.deselect}
        closeLabel={t("deselect")}
      >
        {overlaps.has(id) && (
          <p role="status" className="fp-note fp-note--warn">
            {t("overlapWarning")}
          </p>
        )}
        <label className="block">
          <FieldLabel>{t("fieldLabel")}</FieldLabel>
          <input
            type="text"
            value={table.label ?? ""}
            maxLength={40}
            placeholder={t("fieldLabelPlaceholder")}
            onChange={(e) => actions.patchTable(id, { label: e.target.value || null }, `label:${id}`)}
            className="fp-input w-full"
          />
        </label>
        <Stepper
          label={t("fieldCapacity")}
          value={table.capacity}
          min={1}
          max={40}
          step={1}
          onChange={(v) => actions.patchTable(id, { capacity: v }, `cap:${id}`)}
          decLabel={t("stepLess", { field: t("fieldCapacity") })}
          incLabel={t("stepMore", { field: t("fieldCapacity") })}
        />
        <div>
          <FieldLabel>{t("fieldShape")}</FieldLabel>
          <div className="mp-seg fp-seg w-full" role="radiogroup" aria-label={t("fieldShape")}>
            {(["square", "round", "bar"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={table.shape === s}
                data-active={table.shape === s}
                onClick={() => actions.setTableShape(id, s)}
                className="mp-seg__i flex-1 justify-center"
              >
                {t(s === "square" ? "shapeSquare" : s === "round" ? "shapeRound" : "shapeBar")}
              </button>
            ))}
          </div>
        </div>
        {table.shape === "round" ? (
          <Stepper
            label={t("fieldDiameter")}
            unit={t("unitCm")}
            value={cm(p.w)}
            min={cm(TABLE_SIZE_MIN)}
            max={cm(TABLE_SIZE_MAX)}
            step={5}
            onChange={(v) => actions.patchPlacement(id, { w: v / 100, h: v / 100 }, `size:${id}`)}
            decLabel={t("stepLess", { field: t("fieldDiameter") })}
            incLabel={t("stepMore", { field: t("fieldDiameter") })}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Stepper
              label={t("fieldWidth")}
              unit={t("unitCm")}
              value={cm(p.w)}
              min={cm(TABLE_SIZE_MIN)}
              max={cm(TABLE_SIZE_MAX)}
              step={5}
              onChange={(v) => actions.patchPlacement(id, { w: v / 100 }, `w:${id}`)}
              decLabel={t("stepLess", { field: t("fieldWidth") })}
              incLabel={t("stepMore", { field: t("fieldWidth") })}
              compact
            />
            <Stepper
              label={t("fieldDepth")}
              unit={t("unitCm")}
              value={cm(p.h)}
              min={cm(TABLE_SIZE_MIN)}
              max={cm(TABLE_SIZE_MAX)}
              step={5}
              onChange={(v) => actions.patchPlacement(id, { h: v / 100 }, `h:${id}`)}
              decLabel={t("stepLess", { field: t("fieldDepth") })}
              incLabel={t("stepMore", { field: t("fieldDepth") })}
              compact
            />
          </div>
        )}
        <RotationField
          value={p.rotation}
          onSet={(v) => actions.patchPlacement(id, { rotation: v }, `rot:${id}`)}
          onStep={actions.rotate}
        />
        <PanelActions>
          <button
            type="button"
            className="mp-btn mp-btn--secondary mp-btn--sm"
            disabled={busy}
            onClick={actions.duplicate}
            title={t("duplicateTableHint")}
          >
            <Glyph name="duplicate" size={16} />
            {t("duplicate")}
          </button>
          <button type="button" className="mp-btn mp-btn--danger mp-btn--sm" onClick={actions.remove}>
            <Glyph name="unplace" size={16} />
            {t("removeFromPlan")}
          </button>
        </PanelActions>
        <p className="text-xs text-op-muted leading-relaxed">
          {t("tableMorePre")}
          <Link href="/operator/settings/mesas" className="text-terracotta underline-offset-2 hover:underline">
            {t("tableMoreLink")}
          </Link>
          {t("tableMorePost")}
        </p>
      </Panel>
    );
  }

  if (type === "m") {
    const m = doc.markers.find((x) => x.id === id);
    if (!m) return null;
    const cm = (v: number) => Math.round(v * 100);
    return (
      <Panel title={tf(`markerKind.${m.kind}`)} onClose={actions.deselect} closeLabel={t("deselect")}>
        <label className="block">
          <FieldLabel>{t("fieldKind")}</FieldLabel>
          <select
            value={m.kind}
            onChange={(e) => actions.patchMarker(id, { kind: e.target.value as MarkerKind }, `kind:${id}`)}
            className="fp-input w-full"
          >
            {MARKER_KIND_LIST.map((k) => (
              <option key={k} value={k}>
                {tf(`markerKind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <FieldLabel>{t("fieldName")}</FieldLabel>
          <input
            type="text"
            value={m.label ?? ""}
            maxLength={40}
            placeholder={tf(`markerKind.${m.kind}`)}
            onChange={(e) => actions.patchMarker(id, { label: e.target.value || null }, `mlabel:${id}`)}
            className="fp-input w-full"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Stepper
            label={t("fieldWidth")}
            unit={t("unitCm")}
            value={cm(m.w)}
            min={cm(MARKER_SIZE_MIN)}
            max={cm(MARKER_SIZE_MAX)}
            step={5}
            onChange={(v) => actions.patchMarker(id, { w: v / 100 }, `mw:${id}`)}
            decLabel={t("stepLess", { field: t("fieldWidth") })}
            incLabel={t("stepMore", { field: t("fieldWidth") })}
            compact
          />
          <Stepper
            label={t("fieldDepth")}
            unit={t("unitCm")}
            value={cm(m.h)}
            min={cm(MARKER_SIZE_MIN)}
            max={cm(MARKER_SIZE_MAX)}
            step={5}
            onChange={(v) => actions.patchMarker(id, { h: v / 100 }, `mh:${id}`)}
            decLabel={t("stepLess", { field: t("fieldDepth") })}
            incLabel={t("stepMore", { field: t("fieldDepth") })}
            compact
          />
        </div>
        <RotationField
          value={m.rotation}
          onSet={(v) => actions.patchMarker(id, { rotation: v }, `mrot:${id}`)}
          onStep={actions.rotate}
        />
        <PanelActions>
          <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm" onClick={actions.duplicate}>
            <Glyph name="duplicate" size={16} />
            {t("duplicate")}
          </button>
          <button type="button" className="mp-btn mp-btn--danger mp-btn--sm" onClick={actions.remove}>
            <Glyph name="trash" size={16} />
            {t("delete")}
          </button>
        </PanelActions>
      </Panel>
    );
  }

  const z = doc.zones.find((x) => x.id === id);
  if (!z) return null;
  const straight = isRectilinear(z.points);
  return (
    <Panel title={t("zoneTitle")} onClose={actions.deselect} closeLabel={t("deselect")}>
      <label className="block">
        <FieldLabel>{t("fieldKind")}</FieldLabel>
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-6 w-6 shrink-0 rounded-md border"
            style={{ background: ZONE_KINDS[z.kind].fill, borderColor: ZONE_KINDS[z.kind].stroke }}
          />
          <select
            value={z.kind}
            onChange={(e) => actions.patchZone(id, { kind: e.target.value as ZoneKind }, `zkind:${id}`)}
            className="fp-input w-full"
          >
            {ZONE_KIND_LIST.map((k) => (
              <option key={k} value={k}>
                {tf(`zoneKind.${k}`)}
              </option>
            ))}
          </select>
        </div>
      </label>
      <label className="block">
        <FieldLabel>{t("fieldName")}</FieldLabel>
        <input
          type="text"
          value={z.label}
          maxLength={40}
          placeholder={z.kind === "custom" ? t("zoneNamePlaceholderCustom") : tf(`zoneKind.${z.kind}`)}
          onChange={(e) => actions.patchZone(id, { label: e.target.value }, `zlabel:${id}`)}
          className="fp-input w-full"
        />
      </label>
      <div>
        <FieldLabel>{t("zoneShapeHeading")}</FieldLabel>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            className="mp-btn mp-btn--secondary mp-btn--sm"
            disabled={!straight}
            aria-pressed={boolTool === "add"}
            data-active={boolTool === "add"}
            onClick={() => actions.zoneBool("add")}
          >
            <Glyph name="extend" size={16} />
            {t("zoneAdd")}
          </button>
          <button
            type="button"
            className="mp-btn mp-btn--secondary mp-btn--sm"
            disabled={!straight}
            aria-pressed={boolTool === "cut"}
            data-active={boolTool === "cut"}
            onClick={() => actions.zoneBool("cut")}
          >
            <Glyph name="cut" size={16} />
            {t("zoneCut")}
          </button>
          <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm" onClick={actions.addVertex}>
            <Glyph name="vertexAdd" size={16} />
            {t("vertexAdd")}
          </button>
          <button
            type="button"
            className="mp-btn mp-btn--secondary mp-btn--sm"
            disabled={activeVertex === null || z.points.length <= 3}
            onClick={actions.removeVertex}
          >
            <Glyph name="vertexRemove" size={16} />
            {t("vertexRemove")}
          </button>
        </div>
        <p className="mt-2 text-xs text-op-muted leading-relaxed">
          {straight ? t("zoneBoolHint") : t("zoneBoolDisabled")} {t("zoneHandlesHint")}
        </p>
      </div>
      <PanelActions>
        <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm" onClick={actions.duplicate}>
          <Glyph name="duplicate" size={16} />
          {t("duplicate")}
        </button>
        <button type="button" className="mp-btn mp-btn--danger mp-btn--sm" onClick={actions.remove}>
          <Glyph name="trash" size={16} />
          {t("delete")}
        </button>
      </PanelActions>
    </Panel>
  );
}

function Panel({
  title,
  onClose,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="fp-panel" aria-label={title}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-display text-2xl leading-none">{title}</h2>
        <button type="button" onClick={onClose} className="fp-iconbtn" aria-label={closeLabel} title={closeLabel}>
          <Glyph name="close" size={18} />
        </button>
      </header>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function PanelActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2 border-t border-op-border pt-4">{children}</div>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1.5 block text-xs font-medium text-op-muted">{children}</span>;
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: UiGlyph;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="fp-iconbtn" aria-label={label} title={label}>
      <Glyph name={icon} size={20} />
    </button>
  );
}

function Stepper({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
  decLabel,
  incLabel,
  compact,
}: {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  decLabel: string;
  incLabel: string;
  compact?: boolean;
}) {
  const clampV = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <div>
      <FieldLabel>
        {label}
        {unit ? ` (${unit})` : ""}
      </FieldLabel>
      <div className="fp-stepper">
        <button
          type="button"
          className="fp-stepper__btn"
          aria-label={decLabel}
          disabled={value <= min}
          onClick={() => onChange(clampV(value - step))}
        >
          <Glyph name="minus" size={16} />
        </button>
        <input
          type="number"
          inputMode="numeric"
          aria-label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && e.target.value !== "") onChange(clampV(v));
          }}
          className={"fp-stepper__input" + (compact ? " fp-stepper__input--compact" : "")}
        />
        <button
          type="button"
          className="fp-stepper__btn"
          aria-label={incLabel}
          disabled={value >= max}
          onClick={() => onChange(clampV(value + step))}
        >
          <Glyph name="plus" size={16} />
        </button>
      </div>
    </div>
  );
}

function RotationField({
  value,
  onSet,
  onStep,
}: {
  value: number;
  onSet: (v: number) => void;
  onStep: (delta: number) => void;
}) {
  const t = useTranslations("opSalon");
  return (
    <div>
      <FieldLabel>{t("fieldRotation")}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <IconButton icon="rotateCcw" label={t("rotateLeft")} onClick={() => onStep(-15)} />
        <div className="relative flex-1">
          <input
            type="number"
            inputMode="numeric"
            aria-label={t("fieldRotation")}
            value={Math.round(value)}
            min={0}
            max={359}
            step={15}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && e.target.value !== "") onSet(((v % 360) + 360) % 360);
            }}
            className="fp-input w-full pr-7 text-center tabular-nums"
          />
          <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-op-muted">
            {"°"}
          </span>
        </div>
        <IconButton icon="rotateCw" label={t("rotateRight")} onClick={() => onStep(15)} />
        <button type="button" className="fp-iconbtn fp-iconbtn--text" onClick={() => onStep(45)} aria-label={t("rotate45")} title={t("rotate45")}>
          {t("rotate45Short")}
        </button>
      </div>
    </div>
  );
}
