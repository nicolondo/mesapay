import Link from "next/link";
import type { ReactNode } from "react";
import {
  parseChatMarkdown,
  type ChatBlock,
  type ChatInline,
  type ChatList,
} from "@/lib/markdown/chat";

/**
 * Pinta la respuesta de un modelo de lenguaje (Pulso) con elementos de
 * React, sin HTML crudo: negritas, cursivas, títulos, listas (anidadas),
 * separadores, tablas, citas y código. Compacto, para vivir dentro de una
 * burbuja de chat (`text-sm`). Lo que el parser no reconoce sale como texto.
 */
export function ChatMarkdown({ source }: { source: string }) {
  const blocks = parseChatMarkdown(source);
  return (
    <div className="chat-md space-y-2 leading-relaxed [overflow-wrap:anywhere]">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}

function Block({ block }: { block: ChatBlock }) {
  switch (block.type) {
    case "heading": {
      // En una burbuja todos los niveles pesan parecido: el 1 y el 2 un
      // poco más grandes, el 3 y el 4 como texto destacado.
      const big = block.level <= 2;
      return (
        <div
          role="heading"
          aria-level={block.level}
          className={
            "pt-1 font-semibold tracking-tight text-op-text " + (big ? "text-[15px]" : "text-sm")
          }
        >
          {renderInline(block.children)}
        </div>
      );
    }
    case "paragraph":
      return <p>{renderInline(block.children)}</p>;
    case "list":
      return <List list={block} />;
    case "code":
      return (
        <pre className="overflow-x-auto whitespace-pre rounded-lg border border-op-border bg-op-bg px-3 py-2 font-mono text-[12px] leading-5">
          <code>{block.value}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-op-border pl-3 text-op-muted">
          {renderInline(block.children)}
        </blockquote>
      );
    case "hr":
      return <hr className="my-1 border-op-border" />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    scope="col"
                    className="border-b border-op-border px-2 py-1 font-semibold text-op-text"
                    style={{ textAlign: block.align[i] ?? "left" }}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-op-border/60 last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-2 py-1 align-top" style={{ textAlign: block.align[c] ?? "left" }}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function List({ list }: { list: ChatList }) {
  const cls = list.ordered
    ? "list-decimal space-y-1 pl-5 marker:font-semibold marker:text-op-muted"
    : "list-disc space-y-1 pl-5 marker:text-op-muted";
  const items = list.items.map((it, i) => (
    <li key={i} className="pl-0.5">
      {renderInline(it.children)}
      {it.sub && (
        <div className="mt-1">
          <List list={it.sub} />
        </div>
      )}
    </li>
  ));
  return list.ordered ? (
    <ol start={list.start} className={cls}>
      {items}
    </ol>
  ) : (
    <ul className={cls}>{items}</ul>
  );
}

function renderInline(nodes: ChatInline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.value;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="rounded border border-op-border bg-op-bg px-1 py-0.5 font-mono text-[0.85em]">
            {n.value}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold text-op-text">
            {renderInline(n.children)}
          </strong>
        );
      case "em":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.children)}</del>;
      case "link":
        return n.external ? (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-op-accent underline underline-offset-4 hover:text-op-text"
          >
            {renderInline(n.children)}
          </a>
        ) : (
          <Link
            key={i}
            href={n.href}
            className="font-medium text-op-accent underline underline-offset-4 hover:text-op-text"
          >
            {renderInline(n.children)}
          </Link>
        );
    }
  });
}
