// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import Desk from "../../components/desk";

const status = {
  authenticated: false,
  configured: false,
  missing: ["DATABASE_URL"],
  timezone: "Asia/Bangkok",
  accounts: [],
  lastSyncAt: null,
  gaps: [],
};
let requests: Array<{ url: string; init?: RequestInit }>;
let responder: (url: string, init?: RequestInit) => unknown;
beforeEach(() => {
  requests = [];
  responder = () => status;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const data = responder(String(input), init);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = {
  id: "mail/1",
  title: "Research presentation",
  kind: "exam",
  dueAt: null,
  dateOnly: "2026-11-12",
  timezone: "Asia/Bangkok",
  originalDateText: "Thursday 12 November",
  evidence: "Present on Thursday 12 November.",
  sourceUrl: "https://mail.google.com/mail/u/0/#all/123",
  sourceAccount: "owner@example.com",
  status: "open",
  confidence: 0.95,
  updatedAt: "2026-11-09T00:00:00Z",
};
function connected() {
  responder = (url) =>
    url.startsWith("/api/dashboard")
      ? {
          items: [item],
          news: [],
          gaps: ["Calendar not connected."],
          lastSyncAt: null,
        }
      : {
          ...status,
          authenticated: true,
          configured: true,
          missing: [],
          accounts: [{ email: "owner@example.com", lastSyncAt: null }],
        };
}

describe("private desk setup", () => {
  it("returns to the login form when a dashboard request reports an expired session", async () => {
    connected();
    const initial = responder;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith("weeks=2")
          ? new Response(JSON.stringify({ error: "Authentication required" }), {
              status: 401,
            })
          : new Response(JSON.stringify(initial(url, init))),
      ),
    );
    render(<Desk />);
    await screen.findByText(item.title);
    fireEvent.change(screen.getByLabelText("Time window"), {
      target: { value: "2" },
    });
    expect(await screen.findByLabelText("Owner password")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Agenda monitor" }),
    ).not.toBeInTheDocument();
  });
  it("explains database setup failures using server coverage gaps", async () => {
    responder = () => ({
      ...status,
      authenticated: true,
      missing: [],
      gaps: ["Database unavailable or migration not applied."],
    });
    render(<Desk />);
    expect(
      await screen.findByText("Database unavailable or migration not applied."),
    ).toBeInTheDocument();
  });
  it("does not label stale agenda data as a newly selected window after a failed fetch", async () => {
    connected();
    const initial = responder;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return url.endsWith("weeks=8")
          ? new Response(JSON.stringify({ error: "Source unavailable" }), {
              status: 503,
            })
          : new Response(JSON.stringify(initial(url, init)));
      }),
    );
    render(<Desk />);
    await screen.findByText(item.title);
    fireEvent.change(screen.getByLabelText("Time window"), {
      target: { value: "8" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Source unavailable",
    );
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    expect(screen.getByText("Agenda unavailable")).toBeInTheDocument();
  });
  it("does not leak raw HTML parser errors when an API is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!DOCTYPE html><h1>Unavailable</h1>", { status: 502 }),
      ),
    );
    render(<Desk />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server returned an unreadable response. Please try again.",
    );
    expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument();
  });
  it("offers a real retry when the initial status request fails", async () => {
    let failed = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        failed
          ? new Response(JSON.stringify({ error: "Temporarily unavailable" }), {
              status: 503,
            })
          : new Response(JSON.stringify(status)),
      ),
    );
    render(<Desk />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporarily unavailable",
    );
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(await screen.findByText("DATABASE_URL")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("asks grounded questions with week context and renders source links", async () => {
    connected();
    const initial = responder;
    responder = (url, init) =>
      url === "/api/chat"
        ? {
            answer: "Prioritize the presentation.",
            sources: [{ title: "Presentation email", url: item.sourceUrl }],
            gaps: ["Only synced mail is available."],
          }
        : initial(url, init);
    render(<Desk />);
    await screen.findByText(item.title);
    fireEvent.change(screen.getByLabelText("Ask Bao"), {
      target: { value: "What matters this week?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask Bao" }));
    expect(
      await screen.findByText("Prioritize the presentation."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Presentation email/ }),
    ).toHaveAttribute("href", item.sourceUrl);
    expect(
      screen.getByText("Only synced mail is available."),
    ).toBeInTheDocument();
    expect(
      JSON.parse(
        String(requests.find((r) => r.url === "/api/chat")?.init?.body),
      ),
    ).toEqual({ message: "What matters this week?", weeks: 1 });
  });
  it("shows connected accounts and locks the desk through logout", async () => {
    connected();
    const initial = responder;
    let locked = false;
    responder = (url, init) => {
      if (url === "/api/auth/logout") {
        locked = true;
        return { ok: true };
      }
      if (url === "/api/status" && locked)
        return { ...status, configured: true, missing: [] };
      return initial(url, init);
    };
    render(<Desk />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("heading", { name: "Connected accounts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Connect Google account/ }),
    ).toHaveAttribute("href", "/api/google/connect");
    fireEvent.click(screen.getByRole("button", { name: "Lock desk" }));
    expect(await screen.findByLabelText("Owner password")).toBeInTheDocument();
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    expect(
      requests.find((r) => r.url === "/api/auth/logout")?.init?.method,
    ).toBe("POST");
  });
  it("syncs sources and reports server summary with refreshed data", async () => {
    connected();
    const initial = responder;
    responder = (url, init) =>
      url === "/api/sync"
        ? {
            ok: true,
            summary: "Read 2 threads; more pages remain.",
            gaps: ["More pages remain."],
          }
        : initial(url, init);
    render(<Desk />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
    expect(
      await screen.findByText("Read 2 threads; more pages remain."),
    ).toBeInTheDocument();
    expect(requests.find((r) => r.url === "/api/sync")?.init?.method).toBe(
      "POST",
    );
    expect(
      requests.filter((r) => r.url === "/api/dashboard?weeks=1").length,
    ).toBe(2);
    expect(screen.getByText("More pages remain.")).toBeInTheDocument();
  });
  it("filters review and research while fetching the selected week window", async () => {
    connected();
    const initial = responder;
    responder = (url, init) =>
      url.startsWith("/api/dashboard")
        ? {
            items: [
              item,
              {
                ...item,
                id: "review",
                title: "Unclear date",
                status: "needs_review",
                dateOnly: null,
              },
            ],
            news: [
              {
                id: "paper",
                title: "A sourced paper",
                summary: "Publication summary.",
                url: "https://arxiv.org/abs/2601.00001",
                publishedAt: "2026-11-08T00:00:00Z",
                source: "arXiv",
                kind: "paper",
              },
            ],
            gaps: [],
            lastSyncAt: null,
          }
        : initial(url, init);
    render(<Desk />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Unclear date")).toBeInTheDocument();
    expect(screen.queryByText(item.title)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    expect(
      screen.getByRole("link", { name: /A sourced paper/ }),
    ).toHaveAttribute("href", "https://arxiv.org/abs/2601.00001");
    fireEvent.change(screen.getByLabelText("Time window"), {
      target: { value: "4" },
    });
    await waitFor(() =>
      expect(requests.some((r) => r.url === "/api/dashboard?weeks=4")).toBe(
        true,
      ),
    );
  });
  it("requires an explicit date review before saving a date-only correction", async () => {
    connected();
    render(<Desk />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByText("Review date"));
    fireEvent.change(screen.getByLabelText("Confirmed date"), {
      target: { value: "2026-11-18" },
    });
    expect(requests.some((r) => r.init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed date" }));
    await waitFor(() =>
      expect(requests.some((r) => r.init?.method === "PATCH")).toBe(true),
    );
    expect(
      JSON.parse(
        String(requests.find((r) => r.init?.method === "PATCH")?.init?.body),
      ),
    ).toEqual({ dateOnly: "2026-11-18", dueAt: null, status: "open" });
  });
  it("renders dated source-backed agenda and marks an item done only through PATCH", async () => {
    connected();
    const initial = responder;
    responder = (url, init) =>
      init?.method === "PATCH"
        ? { ...item, status: "done" }
        : initial(url, init);
    render(<Desk />);
    expect(
      await screen.findByText("Research presentation"),
    ).toBeInTheDocument();
    expect(screen.getByText("Calendar not connected.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Source & evidence"));
    expect(screen.getByText("Present on Thursday 12 November.")).toBeVisible();
    expect(screen.getByRole("link", { name: /Open original/ })).toHaveAttribute(
      "href",
      item.sourceUrl,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() =>
      expect(requests.find((r) => r.init?.method === "PATCH")?.url).toBe(
        "/api/items/mail%2F1",
      ),
    );
    expect(
      JSON.parse(
        String(requests.find((r) => r.init?.method === "PATCH")?.init?.body),
      ),
    ).toEqual({ status: "done" });
    expect(
      await screen.findByText("Nothing scheduled in this window."),
    ).toBeInTheDocument();
  });
  it("signs in with a password and loads the real dashboard", async () => {
    let authenticated = false;
    responder = (url, init) => {
      if (url === "/api/auth/login") {
        authenticated = true;
        return { ok: true };
      }
      if (url.startsWith("/api/dashboard"))
        return { items: [], news: [], gaps: [], lastSyncAt: null };
      return { ...status, configured: true, missing: [], authenticated };
    };
    render(<Desk />);
    fireEvent.change(await screen.findByLabelText("Owner password"), {
      target: { value: "private password example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock desk" }));
    expect(
      await screen.findByRole("heading", { name: "Your agenda" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nothing scheduled in this window."),
    ).toBeInTheDocument();
    const login = requests.find((r) => r.url === "/api/auth/login");
    expect(JSON.parse(String(login?.init?.body))).toEqual({
      password: "private password example",
    });
    expect(requests.some((r) => r.url === "/api/dashboard?weeks=1")).toBe(true);
  });
  it("shows an honest missing-configuration state without fabricated inbox data", async () => {
    render(<Desk />);
    expect(
      await screen.findByRole("heading", {
        name: "A private desk, ready when you are.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("DATABASE_URL")).toBeInTheDocument();
    expect(
      screen.getByText(/No inbox data has been loaded/),
    ).toBeInTheDocument();
    expect(requests.map((r) => r.url)).toEqual(["/api/status"]);
    expect(screen.queryByText("Connected accounts")).not.toBeInTheDocument();
  });
});
