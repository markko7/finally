"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ChatActions, ChatMessage } from "@/lib/types";

interface Props {
  onActions: () => void;
}

function ActionList({ actions }: { actions: ChatActions }) {
  const items = [
    ...actions.watchlist_changes.map((c) => ({
      ok: c.status === "ok",
      text: `${c.action === "add" ? "Added" : "Removed"} ${c.ticker} ${c.action === "add" ? "to" : "from"} watchlist`,
      error: c.error,
    })),
    ...actions.trades.map((t) => ({
      ok: t.status === "ok",
      text: `${t.side === "buy" ? "Bought" : "Sold"} ${t.quantity} ${t.ticker}${t.price ? ` @ $${t.price.toFixed(2)}` : ""}`,
      error: t.error,
    })),
  ];
  if (!items.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {items.map((i, idx) => (
        <li
          key={idx}
          data-testid="chat-action"
          className={`rounded border px-2 py-1 font-mono text-xs ${
            i.ok ? "border-up/40 text-up" : "border-down/40 text-down"
          }`}
        >
          {i.ok ? i.text : `Failed: ${i.text} - ${i.error}`}
        </li>
      ))}
    </ul>
  );
}

/** Collapsible AI assistant sidebar with history, loading state and inline action confirmations. */
export default function ChatPanel({ onActions }: Props) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatHistory().then(setMessages);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text, actions: null }]);
    setLoading(true);
    try {
      const { message, ...actions } = await api.chat(text);
      setMessages((m) => [...m, { role: "assistant", content: message, actions }]);
      onActions();
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Error: ${(err as Error).message}`, actions: null },
      ]);
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        data-testid="chat-toggle"
        onClick={() => setOpen(true)}
        className="border-l border-border bg-panel px-2 text-xs tracking-widest text-accent [writing-mode:vertical-rl] hover:bg-panel-2"
      >
        AI ASSISTANT
      </button>
    );
  }

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-panel" data-testid="chat-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-accent">AI Assistant</span>
        <button
          data-testid="chat-toggle"
          onClick={() => setOpen(false)}
          className="text-xs text-muted hover:text-text"
        >
          Hide
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm" data-testid="chat-messages">
        {!messages.length && (
          <p className="text-xs text-muted">
            Ask about your portfolio, request analysis, or say &quot;buy 5 AAPL&quot;.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            data-testid={`chat-message-${m.role}`}
            className={m.role === "user" ? "ml-8 rounded bg-panel-2 px-3 py-2" : "mr-4"}
          >
            {m.role === "assistant" && (
              <div className="mb-1 text-[10px] uppercase tracking-wider text-primary">FinAlly</div>
            )}
            <div className="whitespace-pre-wrap">{m.content}</div>
            {m.actions && <ActionList actions={m.actions} />}
          </div>
        ))}
        {loading && (
          <div data-testid="chat-loading" className="animate-pulse text-xs text-muted">
            FinAlly is thinking...
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-border p-2">
        <input
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask FinAlly..."
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-primary"
        />
        <button
          data-testid="chat-send"
          disabled={loading}
          className="rounded bg-secondary px-4 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </aside>
  );
}
