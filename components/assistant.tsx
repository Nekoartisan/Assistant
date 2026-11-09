"use client";
import React, { useState } from "react";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { safeUrl } from "./agenda";
interface Reply {
  answer: string;
  sources: { title: string; url: string }[];
  gaps?: string[];
}
export default function Assistant({ weeks }: { weeks: number }) {
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<{ question: string; reply: Reply }[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question.trim(), weeks }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Bao could not answer. Please try again.",
        );
      setHistory((old) => [...old, { question, reply: data }]);
      setMessage("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="assistant-panel" aria-label="Grounded assistant">
      <div className="assistant-kicker">
        <span className="eyebrow">COMMAND / INSPECT</span>
        <MessageSquare size={16} />
      </div>
      <h2>
        A second pair
        <br />
        of eyes.
      </h2>
      <p className="muted">
        Ask about your priorities or explore recent research, with the original
        sources close at hand.
      </p>
      <div className="chat-shortcuts">
        <button
          disabled={busy}
          onClick={() => ask("What should I prioritize this week?")}
        >
          Plan my week <ArrowUpRight size={14} />
        </button>
        <button
          disabled={busy}
          onClick={() =>
            ask(`Summarize research from the past ${weeks} weeks.`)
          }
        >
          Catch up on research <ArrowUpRight size={14} />
        </button>
        <button
          disabled={busy}
          onClick={() => ask("Which dates or commitments need my review?")}
        >
          What needs my review? <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="chat-history" aria-live="polite">
        {history.map((entry, index) => (
          <article className="chat-turn" key={index}>
            <p className="chat-question">{entry.question}</p>
            <p className="chat-answer">{entry.reply.answer}</p>
            {entry.reply.sources?.length > 0 && (
              <div className="chat-sources">
                <span className="eyebrow">SOURCES</span>
                {entry.reply.sources.map((source, i) =>
                  safeUrl(source.url) ? (
                    <a
                      key={i}
                      href={safeUrl(source.url)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {source.title} ↗
                    </a>
                  ) : (
                    <span key={i}>{source.title} (link unavailable)</span>
                  ),
                )}
              </div>
            )}
            {entry.reply.gaps?.map((gap) => (
              <p key={gap} className="chat-gap">
                {gap}
              </p>
            ))}
          </article>
        ))}
      </div>
      {error && (
        <p role="alert" className="chat-gap">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="muted">
          Checking your synced sources…
        </p>
      )}
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(message);
        }}
      >
        <label htmlFor="chat-message">Ask Bao</label>
        <textarea
          id="chat-message"
          rows={3}
          required
          maxLength={4000}
          placeholder="What should I focus on?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          className="primary"
          disabled={busy || !message.trim()}
          type="submit"
        >
          {busy ? "Checking sources…" : "Ask Bao"}
          <ArrowUpRight size={15} />
        </button>
      </form>
      <p className="assistant-footnote">
        <span className="status-dot" />
        Answers use synced sources. Chat never changes your mail, calendar, or
        agenda.
      </p>
    </aside>
  );
}
