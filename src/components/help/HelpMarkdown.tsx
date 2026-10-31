import Link from "next/link";
import type { ReactNode } from "react";
import {
  parseHelpMarkdown,
  type HelpBlock,
  type HelpInline,
} from "@/lib/help/markdown";
import { CopyCodeButton } from "./CopyCodeButton";

export type HelpMarkdownLabels = {
  tip: string;
  warning: string;
  copy: string;
  copied: string;
};

/**
 * Pinta el markdown reducido de un artículo con elementos de React (que
 * escapan todo el texto). Sin `dangerouslySetInnerHTML`: lo que el parser no
 * reconoce sale como texto. Sirve en Server Components; sólo el botón de
 * copiar de los bloques de código es de cliente.
 *
 * `allowHref` filtra enlaces según quién lee (en la app del mesero, los que
 * llevan al panel del dueño se pintan como texto).
 */
export function HelpMarkdown({
  source,
  blocks,
  labels,
  allowHref,
}: {
  source?: string;
  blocks?: HelpBlock[];
  labels: HelpMarkdownLabels;
  allowHref?: (href: string) => boolean;
}) {
  const parsed = blocks ?? parseHelpMarkdown(source ?? "");
  return (
    <div className="help-prose space-y-4 text-[15px] leading-relaxed text-op-text">
      {parsed.map((b, i) => (
        <Block key={i} block={b} labels={labels} allowHref={allowHref} />
      ))}
    </div>
  );
}

function Block({
  block,
  labels,
  allowHref,
}: {
  block: HelpBlock;
  labels: HelpMarkdownLabels;
  allowHref?: (href: string) => boolean;
}) {
  const inl = (nodes: HelpInline[]) => renderInline(nodes, allowHref);
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h2
          id={block.id}
          className="scroll-mt-24 pt-4 text-lg font-semibold tracking-tight text-op-text"
        >
          {inl(block.children)}
        </h2>
      ) : (
        <h3
          id={block.id}
          className="scroll-mt-24 pt-2 text-base font-semibold text-op-text"
        >
          {inl(block.children)}
        </h3>
      );
    case "paragraph":
      return <p>{inl(block.children)}</p>;
    case "list":
      return block.ordered ? (
        <ol
          start={block.start}
          className="list-decimal space-y-2 pl-6 marker:font-semibold marker:text-op-muted"
        >
          {block.items.map((it, i) => (
            <li key={i} className="pl-1">
              {inl(it)}
            </li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc space-y-1.5 pl-6 marker:text-op-muted">
          {block.items.map((it, i) => (
            <li key={i} className="pl-1">
              {inl(it)}
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <div className="relative">
          <pre className="overflow-x-auto whitespace-pre rounded-xl border border-op-border bg-op-bg py-3 pl-4 pr-20 font-mono text-[13px] leading-6">
            <code>{block.value}</code>
          </pre>
          <CopyCodeButton
            text={block.value}
            label={labels.copy}
            doneLabel={labels.copied}
          />
        </div>
      );
    case "callout": {
      const warning = block.tone === "warning";
      const label = warning ? labels.warning : labels.tip;
      return (
        <div
          role="note"
          aria-label={label}
          className={
            "rounded-xl border px-4 py-3 text-sm leading-relaxed " +
            (warning
              ? "border-[#C98A2E]/40 bg-[#C98A2E]/10"
              : "border-op-border bg-op-bg")
          }
        >
          <div
            className={
              "mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] " +
              (warning ? "text-[#8F6828]" : "text-op-muted")
            }
          >
            {label}
          </div>
          <p>{inl(block.children)}</p>
        </div>
      );
    }
  }
}

function renderInline(
  nodes: HelpInline[],
  allowHref?: (href: string) => boolean,
): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.value;
      case "code":
        return (
          <code
            key={i}
            className="rounded border border-op-border bg-op-bg px-1.5 py-0.5 font-mono text-[0.85em]"
          >
            {n.value}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold text-op-text">
            {renderInline(n.children, allowHref)}
          </strong>
        );
      case "link":
        if (allowHref && !allowHref(n.href)) {
          return <span key={i}>{renderInline(n.children, allowHref)}</span>;
        }
        return (
          <Link
            key={i}
            href={n.href}
            className="font-medium text-op-accent underline underline-offset-4 hover:text-op-text"
          >
            {renderInline(n.children, allowHref)}
          </Link>
        );
    }
  });
}
