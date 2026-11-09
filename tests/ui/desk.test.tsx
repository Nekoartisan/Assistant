// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
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
  vi.useRealTimers();
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

const progress = {
  accounts: [{email:'owner@example.com',processedThreads:12,pendingThreads:3,failedThreads:1,hasMoreMailPages:true,mailComplete:false,calendarsDone:1,calendarsTotal:2,calendarComplete:false}],
  totalProcessedThreads:12,totalPendingThreads:3,totalFailedThreads:1,hasMore:true,canContinue:true,madeProgress:true,scopeDays:90,blockedReasons:['One thread waiting for retry.'],
};

describe("private desk setup", () => {
  it("runs successive explicit batches at least five seconds apart, shows real counts, and stops on completion", async () => {
    vi.useFakeTimers(); connected(); const initial = responder; let batches = 0;
    responder = (url,init) => url === '/api/sync' ? {ok:true,summary:'Batch saved',gaps:[],progress:{...progress,hasMore:++batches < 2}} : initial(url,init);
    await act(async () => { render(<Desk />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(requests.filter(r => r.url === '/api/sync')).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button',{name:'Sync sources'})); });
    expect(screen.getByText(/12 threads processed/)).toBeInTheDocument();
    expect(screen.getByText(/3 known pending \(including retries\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed thread/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 calendars/)).toBeInTheDocument();
    expect(screen.getByText(/90-day/)).toBeInTheDocument();
    expect(screen.getByText(/browser.*remain open/i)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(batches).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(batches).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(batches).toBe(2);
    expect(screen.queryByRole('button',{name:'Pause sync'})).not.toBeInTheDocument();
  });
  it("pauses between batches and resumes saved work without bypassing five-second pacing", async () => {
    vi.useFakeTimers(); connected(); const initial = responder; let batches = 0;
    responder = (url,init) => url === '/api/sync' ? (++batches,{ok:true,summary:'Saved',gaps:[],progress}) : initial(url,init);
    await act(async () => { render(<Desk />); });
    await act(async () => { fireEvent.click(screen.getByRole('button',{name:'Sync sources'})); });
    fireEvent.click(screen.getByRole('button',{name:'Pause sync'}));
    expect(screen.getByText(/current batch may finish/i)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button',{name:'Resume sync'})); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(batches).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(batches).toBe(2);
    fireEvent.click(screen.getByRole('button',{name:'Pause sync'}));
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(batches).toBe(2);
  });
  it("allows an inflight batch to finish after Pause but never overlaps or launches another", async () => {
    vi.useFakeTimers(); connected(); const initial = responder; let release!: (r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(async (url:string,init?:RequestInit) => {
      requests.push({url,init});
      if (url === '/api/sync') return new Promise<Response>(resolve => {release=resolve;});
      return Response.json(initial(url,init));
    }));
    await act(async () => { render(<Desk />); });
    await act(async () => { fireEvent.click(screen.getByRole('button',{name:'Sync sources'})); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(requests.filter(r=>r.url==='/api/sync')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'Pause sync'}));
    expect(screen.getByRole('button',{name:'Resume sync'})).toBeDisabled();
    await act(async () => { release(Response.json({ok:true,summary:'Saved',gaps:[],progress})); });
    expect(screen.getByRole('button',{name:'Resume sync'})).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(requests.filter(r=>r.url==='/api/sync')).toHaveLength(1);
    expect(screen.getByText(/12 threads processed/)).toBeInTheDocument();
  });
  it.each([{madeProgress:false,canContinue:true},{madeProgress:true,canContinue:false}])("stops incomplete batches when progress is blocked: %j", async flags => {
    vi.useFakeTimers(); connected(); const initial=responder; let batches=0;
    responder=(url,init)=>url==='/api/sync'?(++batches,{ok:true,summary:'Saved',gaps:[],progress:{...progress,...flags}}):initial(url,init);
    await act(async()=>{render(<Desk />);});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Sync sources'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
    expect(batches).toBe(1);
    expect(screen.getByText(/no further forward progress/i)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Resume sync'})).toBeEnabled();
  });
  it("stops automatic batches when a status refresh reports missing configuration", async () => {
    vi.useFakeTimers(); connected(); const initial=responder; let batches=0;
    responder=(url,init)=>url==='/api/sync'?(++batches,{ok:true,summary:'Saved',gaps:[],progress}):url==='/api/status'&&batches ? {...status,authenticated:true,configured:false,gaps:['Database unavailable.']} : initial(url,init);
    await act(async()=>{render(<Desk />);});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Sync sources'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
    expect(batches).toBe(1);
  });
  it("bounds an explicit run to twenty batches", async () => {
    vi.useFakeTimers(); connected(); const initial=responder; let batches=0;
    responder=(url,init)=>url==='/api/sync'?(++batches,{ok:true,summary:'Saved',gaps:[],progress}):initial(url,init);
    await act(async()=>{render(<Desk />);});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Sync sources'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(600000);});
    expect(batches).toBe(20);
    expect(screen.getByText(/paused at its safety limit/)).toBeInTheDocument();
  });
  it("pauses at ten minutes even if a server batch is still pending", async () => {
    vi.useFakeTimers(); connected(); const initial=responder; let release!: (r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      requests.push({url,init});
      return url==='/api/sync'?new Promise<Response>(resolve=>{release=resolve;}):Response.json(initial(url,init));
    }));
    await act(async()=>{render(<Desk />);});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Sync sources'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(600000);});
    expect(screen.getByText(/10-minute limit/)).toBeInTheDocument();
    await act(async()=>{release(Response.json({ok:true,summary:'Saved',gaps:[],progress}));await vi.advanceTimersByTimeAsync(60000);});
    expect(requests.filter(r=>r.url==='/api/sync')).toHaveLength(1);
  });
  it.each([401,403,429,503])("does not automatically retry a sync HTTP %s", async code => {
    vi.useFakeTimers(); connected(); const initial=responder;
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      requests.push({url,init});
      return url==='/api/sync'?Response.json({error:'Provider or session unavailable'},{status:code}):Response.json(initial(url,init));
    }));
    await act(async()=>{render(<Desk />);});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Sync sources'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(600000);});
    expect(requests.filter(r=>r.url==='/api/sync')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Provider or session unavailable');
  });
  it.each(['logout','unmount'])("cancels scheduled POST batches on %s",async action=>{
    vi.useFakeTimers(); connected(); const initial=responder; let locked=false;
    responder=(url,init)=>{
      if(url==='/api/auth/logout'){locked=true;return {ok:true};}
      if(url==='/api/status'&&locked)return {...status,configured:true,missing:[]};
      return url==='/api/sync'?{ok:true,summary:'Saved',gaps:[],progress}:initial(url,init);
    };
    let unmount!:()=>void;
    await act(async()=>{({unmount}=render(<Desk />));});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Sync sources'}));});
    if(action==='logout'){
      fireEvent.click(screen.getByRole('button',{name:'Settings'}));
      await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Lock desk'}));});
    }else unmount();
    const count=requests.length;
    await act(async()=>{await vi.advanceTimersByTimeAsync(600000);});
    expect(requests).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes an active server sync using GET only and unlocks an expired first sync without claiming success", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let active = true;
    responder = (url, init) =>
      url === "/api/status"
        ? {
            ...(initial(url, init) as object),
            syncInProgress: active,
            syncLeaseExpiresAt: new Date(
              Date.now() + (active ? 180000 : -1000),
            ).toISOString(),
          }
        : url.startsWith("/api/dashboard")
          ? {
              items: active ? [] : [item],
              news: [],
              gaps: active ? ["Backfill pending."] : [],
              lastSyncAt: null,
            }
          : initial(url, init);
    await act(async () => {
      render(<Desk />);
    });
    expect(screen.getByRole("button", { name: "Syncing…" })).toBeDisabled();
    expect(screen.getByText(/Sync in progress/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(requests.filter((r) => r.url === "/api/status")).toHaveLength(2);
    active = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(item.title)).toBeInTheDocument();
    expect(
      screen.getByText(/No completed sync was recorded.*retry/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync sources" })).toBeEnabled();
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(requests).toHaveLength(count);
    expect(
      requests.every((r) => !r.init?.method || r.init.method === "GET"),
    ).toBe(true);
  });
  it("keeps an unconfirmed sync honest and pauses when its fresh status GET fails", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let checks = 0;
    responder = (url, init) => {
      if (url === "/api/sync")
        return {
          ok: false,
          summary: "A sync is already in progress.",
          gaps: [],
        };
      if (url === "/api/status" && checks++ > 0)
        throw new Error("Status unavailable");
      return initial(url, init);
    };
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
    });
    expect(screen.getByText(/Waiting for sync status/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(requests.filter((r) => r.url === "/api/status")).toHaveLength(2);
  });
  it("checks fresh status after an already-running response and allows retry when no lease remains", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    responder = (url, init) =>
      url === "/api/sync"
        ? { ok: false, summary: "A sync is already in progress.", gaps: [] }
        : initial(url, init);
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
    });
    expect(screen.getByRole("button", { name: "Sync sources" })).toBeEnabled();
    expect(
      screen.getByText(/No completed sync was recorded.*retry/i),
    ).toBeInTheDocument();
    expect(requests.filter((r) => r.url === "/api/status")).toHaveLength(2);
  });
  it("stops failed refreshes, preserves the error and existing agenda, and unlocks at lease expiry", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    const expiry = new Date(Date.now() + 15000).toISOString();
    let fail = false;
    responder = (url, init) => {
      if (url === "/api/status") {
        if (fail) throw new Error("Status unavailable");
        return {
          ...(initial(url, init) as object),
          syncInProgress: true,
          syncLeaseExpiresAt: expiry,
        };
      }
      return initial(url, init);
    };
    await act(async () => {
      render(<Desk />);
    });
    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable");
    expect(screen.getByText(item.title)).toBeInTheDocument();
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(requests).toHaveLength(count);
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable");
    expect(screen.getByRole("button", { name: "Sync sources" })).toBeEnabled();
    expect(screen.getByText(/lease expired.*unconfirmed/i)).toBeInTheDocument();
  });
  it("reports a hung GET timeout rather than silently leaving automatic refresh pending", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let checks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === "/api/status" && checks++ > 0)
          return new Promise<Response>(() => {});
        return Response.json(
          url === "/api/status"
            ? {
                ...(initial(url, init) as object),
                syncInProgress: true,
                syncLeaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
              }
            : initial(url, init),
        );
      }),
    );
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/refresh.*timed out/i);
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(requests).toHaveLength(count);
    expect(
      requests.find((r) => r.url === "/api/status" && r !== requests[0])?.init
        ?.signal?.aborted,
    ).toBe(true);
  });
  it("polls an already-running sync without resubmitting POST and renders real progress before completion", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let active = false;
    let finished = false;
    let progress = false;
    responder = (url, init) => {
      if (url === "/api/sync") {
        active = true;
        return {
          ok: false,
          summary: "A sync is already in progress.",
          gaps: [],
        };
      }
      if (url === "/api/status")
        return {
          ...(initial(url, init) as object),
          syncInProgress: active,
          syncLeaseExpiresAt: active
            ? new Date(Date.now() + 180000).toISOString()
            : null,
          lastSyncAt: finished ? "2026-11-09T00:00:00Z" : null,
        };
      if (url.startsWith("/api/dashboard"))
        return {
          items: progress ? [item] : [],
          news: [],
          gaps: progress ? ["Mail backfill remains incomplete."] : [],
          lastSyncAt: finished ? "2026-11-09T00:00:00Z" : null,
        };
      return initial(url, init);
    };
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
    });
    expect(screen.getByRole("button", { name: "Syncing…" })).toBeDisabled();
    progress = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(item.title)).toBeInTheDocument();
    expect(
      screen.getByText("Mail backfill remains incomplete."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last sync:/)).toHaveTextContent("Not yet synced");
    active = false;
    finished = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("button", { name: "Sync sources" })).toBeEnabled();
    expect(screen.getByText(/Last sync:/)).not.toHaveTextContent(
      "Not yet synced",
    );
    expect(requests.filter((r) => r.init?.method === "POST")).toHaveLength(1);
  });
  it("does not overlap slow polls and discards an old window response after a window change", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let release!: (r: Response) => void;
    let checks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === "/api/status" && checks++ === 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return Response.json(
          url === "/api/status"
            ? {
                ...(initial(url, init) as object),
                syncInProgress: true,
                syncLeaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
              }
            : initial(url, init),
        );
      }),
    );
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(requests.filter((r) => r.url === "/api/status")).toHaveLength(2);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Time window"), {
        target: { value: "2" },
      });
    });
    await act(async () => {
      release(
        Response.json({ ...status, authenticated: false, configured: true }),
      );
    });
    expect(
      screen.getByRole("heading", { name: "Your agenda" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Time window")).toHaveValue("2");
    expect(
      requests.filter((r) => r.url === "/api/dashboard?weeks=1"),
    ).toHaveLength(1);
  });
  it.each(["logout", "unmount"])(
    "cancels polling and ignores late private responses on %s",
    async (action) => {
      vi.useFakeTimers();
      connected();
      const initial = responder;
      let locked = false;
      let checks = 0;
      let release!: (r: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          if (url === "/api/auth/logout") {
            locked = true;
            return Response.json({ ok: true });
          }
          if (url === "/api/status") {
            if (locked)
              return Response.json({
                ...status,
                configured: true,
                missing: [],
              });
            if (checks++ > 0)
              return new Promise<Response>((resolve) => {
                release = resolve;
              });
            return Response.json({
              ...(initial(url, init) as object),
              syncInProgress: true,
              syncLeaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
            });
          }
          return Response.json(initial(url, init));
        }),
      );
      let unmount!: () => void;
      await act(async () => {
        ({ unmount } = render(<Desk />));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      const pending = requests.at(-1)!;
      if (action === "logout") {
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Lock desk" }));
        });
      } else unmount();
      expect(pending.init?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const count = requests.length;
      await act(async () => {
        release(
          Response.json({
            ...(initial("/api/status") as object),
            syncInProgress: true,
          }),
        );
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(requests).toHaveLength(count);
      expect(screen.queryByText(item.title)).not.toBeInTheDocument();
      if (action === "logout")
        expect(screen.getByLabelText("Owner password")).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("unlocks when a released lease is observed even if refreshing the agenda fails", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let active = true;
    responder = (url, init) => {
      if (url === "/api/status")
        return {
          ...(initial(url, init) as object),
          syncInProgress: active,
          syncLeaseExpiresAt: active
            ? new Date(Date.now() + 180000).toISOString()
            : null,
        };
      if (url.startsWith("/api/dashboard") && !active)
        throw new Error("Agenda refresh failed");
      return initial(url, init);
    };
    await act(async () => {
      render(<Desk />);
    });
    active = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Agenda refresh failed",
    );
    expect(screen.getByRole("button", { name: "Sync sources" })).toBeEnabled();
    expect(screen.getByText(item.title)).toBeInTheDocument();
    expect(
      screen.getByText(/No completed sync was recorded.*retry/i),
    ).toBeInTheDocument();
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(requests).toHaveLength(count);
  });
  it("discards a late sync response after logout and does not leave the next session stuck syncing", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let locked = false;
    let release!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === "/api/sync")
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        if (url === "/api/auth/logout") {
          locked = true;
          return Response.json({ ok: true });
        }
        if (url === "/api/auth/login") {
          locked = false;
          return Response.json({ ok: true });
        }
        return Response.json(
          url === "/api/status" && locked
            ? { ...status, configured: true, missing: [] }
            : initial(url, init),
        );
      }),
    );
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lock desk" }));
    });
    const count = requests.length;
    await act(async () => {
      release(
        Response.json({
          ok: false,
          summary: "A sync is already in progress.",
          gaps: [],
        }),
      );
    });
    expect(requests).toHaveLength(count);
    fireEvent.change(screen.getByLabelText("Owner password"), {
      target: { value: "test password only" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unlock desk" }));
    });
    expect(screen.getByRole("button", { name: "Sync sources" })).toBeEnabled();
  });
  it("does not restart automatic polling until an explicit status retry succeeds", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    let checks = 0;
    let release!: (r: Response) => void;
    const active = () => ({
      ...(initial("/api/status") as object),
      syncInProgress: true,
      syncLeaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === "/api/status") {
          checks++;
          if (checks === 2) throw new Error("Status unavailable");
          if (checks >= 3)
            return new Promise<Response>((resolve) => {
              release = resolve;
            });
          return Response.json(active());
        }
        return Response.json(initial(url, init));
      }),
    );
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(checks).toBe(3);
    await act(async () => {
      release(Response.json(active()));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("bounds automatic refresh even when the server keeps reporting a live lease", async () => {
    vi.useFakeTimers();
    connected();
    const initial = responder;
    const expiry = new Date(Date.now() + 3600000).toISOString();
    responder = (url, init) =>
      url === "/api/status"
        ? {
            ...(initial(url, init) as object),
            syncInProgress: true,
            syncLeaseExpiresAt: expiry,
          }
        : initial(url, init);
    await act(async () => {
      render(<Desk />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Automatic refresh paused",
    );
    expect(requests.filter((r) => r.url === "/api/status")).toHaveLength(61);
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(requests).toHaveLength(count);
  });
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
