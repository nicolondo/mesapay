"use client";

/**
 * Inputs del formulario de factura. Viven aparte porque los comparten el
 * sheet de datos personalizados y cualquier pantalla futura que pida lo
 * mismo (p. ej. el operador cargando la factura a mano).
 */

export function Field({
  label,
  value,
  onChange,
  type,
  placeholder,
  hint,
  inputMode,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  inputMode?: "text" | "numeric" | "email" | "tel";
  className?: string;
}) {
  return (
    <label className={"block " + (className ?? "")}>
      <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
        {label}
      </span>
      <input
        type={type ?? "text"}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta"
      />
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  className?: string;
}) {
  return (
    <label className={"block " + (className ?? "")}>
      <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-ivory text-sm focus:outline-none focus:border-terracotta"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
