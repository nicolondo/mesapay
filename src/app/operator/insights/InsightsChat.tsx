"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { AppDialog } from "@/components/ui/AppDialog";
import { conversationHref, formatConversationDate, readConversationId } from "./conversationUrl";

type Msg = { role: "user" | "assistant"; content: string };
type ConversationSummary = { id: string; title: string; updatedAt: string; messageCount: number };
type ConversationDetail = { messages: { role: string; content: string }[] };
/**
 * La conversación en pantalla. `id` es null mientras no se ha guardado
 * ninguna (conversación nueva sin respuesta todavía). `notice` avisa que la
 * de la URL no se pudo cargar o ya no existe.
 */
type Thread = { id: string | null; msgs: Msg[]; notice: "error" | "notFound" | null };

const EMPTY_THREAD: Thread = { id: null, msgs: [], notice: null };
const CONVERSATIONS_API = "/api/operator/insights/conversations";

/** Lista de conversaciones del usuario en el comercio activo; null si falló. */
async function fetchConversationList(): Promise<ConversationSummary[] | null> {
  try {
    const res = await fetch(CONVERSATIONS_API);
    if (!res.ok) return null;
    const j = (await res.json()) as { conversations: ConversationSummary[] };
    return j.conversations;
  } catch {
    return null;
  }
}

/**
 * Chat de Pulso con historial. El servidor siempre guardó las conversaciones
 * (AiConversation / AiMessage); lo que faltaba era leerlas: el id vivía sólo
 * en el estado de React y al recargar la PWA la pantalla salía vacía («no
 * guarda»). Ahora la conversación abierta va en la URL (`?c=<id>`): recargar
 * vuelve a la misma, y el panel «Conversaciones» (hoja en el celular,
 * columna fija en escritorio) abre o borra cualquiera de las anteriores.
 */
export function InsightsChat() {
  const t = useTranslations("insights");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const searchString = search.toString();
  const urlConvId = readConversationId(search);

  const [thread, setThread] = useState<Thread>(EMPTY_THREAD);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Id de la conversación en curso para el POST. Va en un ref además de la
  // URL porque `router.replace` es asíncrono: si el operador manda otro
  // mensaje antes de que la URL cambie, igual sigue en la misma conversación.
  const convIdRef = useRef<string | null>(null);

  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [listError, setListError] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  // Zona horaria del navegador: el operador está en el local. La lista se
  // pinta sólo en el cliente (llega por fetch), así que no hay desfase de
  // hidratación.
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const endRef = useRef<HTMLDivElement>(null);

  // La URL pide una conversación distinta de la que está en pantalla: se
  // está cargando. Se deriva (no se guarda) para que en el primer render con
  // `?c=` ya salga «cargando» y no parpadeen las sugerencias. Si la URL no
  // trae `?c=` pero el hilo ya tiene id, es la conversación recién creada
  // cuyo `router.replace` todavía no llegó: se sigue mostrando.
  const convLoading = urlConvId !== null && urlConvId !== thread.id;
  const msgs = convLoading ? [] : thread.msgs;
  const notice = convLoading ? null : thread.notice;

  const suggestions = [t("sug1"), t("sug2"), t("sug3"), t("sug4"), t("sug5"), t("sug6")];

  // Refresca la lista tras enviar o borrar (desde manejadores de eventos).
  const loadList = useCallback(async () => {
    const rows = await fetchConversationList();
    if (rows) setList(rows);
    setListError(rows === null);
  }, []);

  // Primera carga de la lista al montar.
  useEffect(() => {
    let cancelled = false;
    void fetchConversationList().then((rows) => {
      if (cancelled) return;
      if (rows) setList(rows);
      setListError(rows === null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Carga la conversación de la URL: al montar o al tocar una de la lista.
  // No recarga la que se acaba de crear en esta sesión (ya está en pantalla).
  useEffect(() => {
    if (!urlConvId || urlConvId === convIdRef.current) return;
    let cancelled = false;
    convIdRef.current = urlConvId;
    (async () => {
      try {
        const res = await fetch(`${CONVERSATIONS_API}/${urlConvId}`);
        if (cancelled) return;
        if (res.status === 404) {
          // Borrada o de otro usuario: se quita de la URL y se empieza limpio.
          convIdRef.current = null;
          setThread({ id: null, msgs: [], notice: "notFound" });
          router.replace(conversationHref(pathname, searchString, null), { scroll: false });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { conversation: ConversationDetail };
        if (cancelled) return;
        setThread({
          id: urlConvId,
          msgs: j.conversation.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role as Msg["role"], content: m.content })),
          notice: null,
        });
      } catch {
        // El POST sigue funcionando con el id de la URL: el servidor tiene
        // el historial aunque acá no se haya podido pintar.
        if (!cancelled) setThread({ id: urlConvId, msgs: [], notice: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlConvId, pathname, router, searchString]);

  useEffect(() => {
    if (msgs.length > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, busy]);

  function startNew() {
    setSheetOpen(false);
    if (busy) return;
    convIdRef.current = null;
    setThread(EMPTY_THREAD);
    if (urlConvId) router.replace(conversationHref(pathname, searchString, null), { scroll: false });
  }

  function openConversation(id: string) {
    setSheetOpen(false);
    if (busy || id === convIdRef.current) return;
    router.replace(conversationHref(pathname, searchString, id), { scroll: false });
  }

  async function send(text: string) {
    if (!text.trim() || busy || convLoading) return;
    const conversationId = convIdRef.current ?? undefined;
    setThread((th) => ({ ...th, msgs: [...th.msgs, { role: "user", content: text }], notice: null }));
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/operator/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversationId }),
      });
      const j = await res.json();
      if (!res.ok) {
        const content = j.error === "daily_limit" ? t("limitReached") : t("error");
        setThread((th) => ({ ...th, msgs: [...th.msgs, { role: "assistant", content }] }));
      } else {
        const id = j.conversationId as string;
        if (conversationId !== id) {
          // Primera respuesta de una conversación nueva: queda en la URL
          // para que recargar la PWA vuelva acá.
          convIdRef.current = id;
          router.replace(conversationHref(pathname, searchString, id), { scroll: false });
        }
        setThread((th) => ({ ...th, id, msgs: [...th.msgs, { role: "assistant", content: j.text }] }));
        void loadList();
      }
    } catch {
      setThread((th) => ({ ...th, msgs: [...th.msgs, { role: "assistant", content: t("error") }] }));
    } finally {
      setBusy(false);
    }
  }

  function closeDelete() {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteError(false);
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      const res = await fetch(`${CONVERSATIONS_API}/${target.id}`, { method: "DELETE" });
      // 404 = ya no existía; para el operador el resultado es el mismo.
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      setList((l) => l?.filter((c) => c.id !== target.id) ?? l);
      setPendingDelete(null);
      if (convIdRef.current === target.id) startNew();
    } catch {
      setDeleteError(true);
    } finally {
      setDeleting(false);
    }
  }

  function retryList() {
    setListError(false);
    setList(null);
    void loadList();
  }

  const canReset = urlConvId !== null || thread.id !== null || thread.msgs.length > 0;
  const count = list?.length ?? 0;

  function renderList() {
    if (listError) {
      return (
        <div className="p-4 text-sm text-op-muted" role="status">
          <p>{t("historyError")}</p>
          <button type="button" onClick={retryList} className="mp-btn mp-btn--sm mp-btn--secondary mt-2">
            {t("retry")}
          </button>
        </div>
      );
    }
    if (list === null) return <p className="p-4 text-sm text-op-muted">{t("historyLoading")}</p>;
    if (list.length === 0) return <p className="p-4 text-sm text-op-muted">{t("historyEmpty")}</p>;
    return (
      <ul className="flex flex-col gap-0.5 p-2">
        {list.map((c) => {
          const active = c.id === urlConvId;
          return (
            <li
              key={c.id}
              className={"flex items-center gap-1 rounded-xl pr-1 " + (active ? "bg-op-bg" : "hover:bg-op-bg")}
            >
              <button
                type="button"
                disabled={busy}
                aria-current={active ? "true" : undefined}
                onClick={() => openConversation(c.id)}
                className="min-w-0 flex-1 px-3 py-2.5 text-left disabled:opacity-60"
              >
                <span className={"block truncate text-sm " + (active ? "font-medium" : "")}>{c.title}</span>
                <span className="block truncate text-xs text-op-muted">
                  {t("historyMeta", {
                    date: formatConversationDate(c.updatedAt, { locale, timeZone }),
                    count: c.messageCount,
                  })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(c)}
                aria-label={t("deleteConversation")}
                title={t("deleteConversation")}
                className="mp-icon-button shrink-0"
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="md:grid md:grid-cols-[16rem_minmax(0,1fr)] md:items-start md:gap-6">
      {/* Escritorio: columna fija con el historial */}
      <aside className="hidden md:flex md:flex-col md:sticky md:top-4 max-h-[calc(100dvh-9rem)] overflow-hidden rounded-2xl border border-op-border bg-op-surface">
        <div className="flex items-center justify-between gap-2 border-b border-op-border py-2 pl-4 pr-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {t("conversations")}
            {count > 0 && <CountBadge n={count} />}
          </h2>
          <button
            type="button"
            onClick={startNew}
            disabled={busy || !canReset}
            aria-label={t("newConversation")}
            title={t("newConversation")}
            className="mp-icon-button disabled:opacity-40"
          >
            <PlusIcon />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">{renderList()}</div>
      </aside>

      <div className="flex min-w-0 flex-col gap-3">
        {/* Celular: barra con la hoja de conversaciones y «nueva» */}
        <div className="flex items-center justify-between gap-2 md:hidden">
          <button type="button" onClick={() => setSheetOpen(true)} className="mp-btn mp-btn--sm mp-btn--secondary">
            <ChatIcon />
            <span>{t("conversations")}</span>
            {count > 0 && <CountBadge n={count} />}
          </button>
          <button
            type="button"
            onClick={startNew}
            disabled={busy || !canReset}
            className="mp-btn mp-btn--sm mp-btn--ghost disabled:opacity-40"
          >
            <PlusIcon />
            <span>{t("newConversation")}</span>
          </button>
        </div>

        {notice === "notFound" && (
          <p role="status" className="text-xs text-op-muted">
            {t("conversationNotFound")}
          </p>
        )}
        {notice === "error" && (
          <p role="status" className="text-xs text-danger">
            {t("conversationError")}
          </p>
        )}

        {convLoading && <p className="text-sm text-op-muted">{t("conversationLoading")}</p>}

        {!convLoading && msgs.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} onClick={() => send(s)} className="mp-btn mp-btn--sm mp-btn--secondary">
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-3">
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? "self-end max-w-[85%]" : "self-start max-w-[90%]"}>
              <div
                className={
                  "rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap " +
                  (m.role === "user" ? "bg-ink text-bone" : "bg-op-surface border border-op-border")
                }
              >
                {m.content}
              </div>
            </div>
          ))}
          {busy && <div className="self-start text-op-muted text-sm">{t("thinking")}</div>}
          <div ref={endRef} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2 mt-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("placeholder")}
            disabled={convLoading}
            className="flex-1 h-11 px-4 rounded-full border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
          />
          <button disabled={busy || convLoading} className="mp-btn mp-btn--primary">
            {t("send")}
          </button>
        </form>
      </div>

      {sheetOpen && (
        <AppDialog label={t("conversations")} onClose={() => setSheetOpen(false)} mobileOnly className="mp-sheet">
          <div className="flex items-center justify-between gap-3 border-b border-op-border py-3 pl-5 pr-3">
            <h2 className="flex items-center gap-2 font-display text-xl">
              {t("conversations")}
              {count > 0 && <CountBadge n={count} />}
            </h2>
            <button type="button" onClick={() => setSheetOpen(false)} aria-label={t("close")} className="mp-icon-button">
              <CloseIcon />
            </button>
          </div>
          <div className="max-h-[60dvh] overflow-y-auto">{renderList()}</div>
          <div className="border-t border-op-border p-3">
            <button
              type="button"
              onClick={startNew}
              disabled={busy || !canReset}
              className="mp-btn mp-btn--secondary mp-btn--block disabled:opacity-40"
            >
              <PlusIcon />
              <span>{t("newConversation")}</span>
            </button>
          </div>
        </AppDialog>
      )}

      {pendingDelete && (
        <AppDialog label={t("deleteConfirmTitle")} onClose={closeDelete} placement="center" className="rounded-2xl">
          <div className="p-5 space-y-3">
            <h2 className="font-display text-lg">{t("deleteConfirmTitle")}</h2>
            <p className="truncate text-sm">{pendingDelete.title}</p>
            <p className="text-sm text-op-muted">{t("deleteConfirmBody")}</p>
            {deleteError && (
              <p role="alert" className="text-xs text-danger">
                {t("deleteError")}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                autoFocus
                onClick={closeDelete}
                disabled={deleting}
                className="mp-btn mp-btn--sm mp-btn--ghost"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="mp-btn mp-btn--sm mp-btn--danger-solid"
              >
                {t("deleteConfirm")}
              </button>
            </div>
          </div>
        </AppDialog>
      )}
    </div>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11px] font-medium leading-5 text-bone tabular">
      {n}
    </span>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}
const ChatIcon = () => (
  <Svg>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
  </Svg>
);
const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
const CloseIcon = () => (
  <Svg>
    <path d="m6 6 12 12M6 18 18 6" />
  </Svg>
);
const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Svg>
);
