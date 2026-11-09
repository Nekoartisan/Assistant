export interface Deadline {
  id: string;
  title: string;
  kind: "deadline" | "exam" | "event" | "commitment";
  dueAt: string | null;
  dateOnly: string | null;
  timezone: string | null;
  originalDateText: string;
  evidence: string;
  sourceUrl: string;
  sourceAccount: string;
  status: "open" | "done" | "dismissed" | "needs_review";
  confidence: number;
  updatedAt: string;
  notes?: string;
  location?: string;
}
export interface News {
  id: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  source: string;
  kind: "paper" | "news";
  fetchedAt?: string;
}
