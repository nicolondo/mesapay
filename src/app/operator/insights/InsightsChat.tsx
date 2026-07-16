"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

type Msg = { role: "user" | "assistant"; content: string };

export function InsightsChat() {
  const t = useTranslations("insights");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [convId, setConvId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const suggestions = [t("sug1"), t("sug2"), t("sug3"), t("sug4"), t("sug5"), t("sug6")];

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/operator/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: convId }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsgs((m) => [...m, { role: "assistant", content: j.error === "daily_limit" ? t("limitReached") : t("error") }]);
      } else {
        setConvId(j.conversationId);
        setMsgs((m) => [...m, { role: "assistant", content: j.text }]);
      }
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: t("error") }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {msgs.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button key={s} onClick={() => send(s)}
              className="mp-btn mp-btn--sm mp-btn--secondary">
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end max-w-[85%]" : "self-start max-w-[90%]"}>
            <div className={"rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap " +
              (m.role === "user" ? "bg-ink text-bone" : "bg-op-surface border border-op-border")}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && <div className="self-start text-op-muted text-sm">{t("thinking")}</div>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2 mt-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("placeholder")}
          className="flex-1 h-11 px-4 rounded-full border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta" />
        <button disabled={busy} className="mp-btn mp-btn--primary">
          {t("send")}
        </button>
      </form>
    </div>
  );
}
