import { z } from "zod";
import { DateTime } from "luxon";
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => DateTime.fromISO(v).isValid, "Invalid date");
export const instantSchema = z
  .string()
  .regex(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  .refine(
    (v) => DateTime.fromISO(v, { setZone: true }).isValid,
    "Invalid timestamp",
  );
const factSchema = z
  .object({
    key: z.string().min(1).max(120),
    title: z.string().min(1).max(300),
    kind: z.enum(["deadline", "exam", "event", "commitment"]),
    dueAt: instantSchema.nullable(),
    dateOnly: dateOnlySchema.nullable(),
    timezone: z.string().max(100).nullable(),
    originalDateText: z.string().max(500),
    evidence: z.string().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    cancelled: z.boolean(),
    notes: z.string().max(1000).optional(),
    location: z.string().max(300).optional(),
  })
  .refine((v) => !(v.dueAt && v.dateOnly), "Use one date representation")
  .refine(
    (v) => !v.timezone || DateTime.now().setZone(v.timezone).isValid,
    "Unknown timezone",
  );
export type Fact = z.infer<typeof factSchema>;
export function validateFacts(value: unknown, body: string): Fact[] {
  const data = z.object({ facts: z.array(factSchema).max(50) }).parse(value);
  if (data.facts.some((f) => !body.includes(f.evidence)))
    throw new Error("Evidence is not an exact source quote");
  if (new Set(data.facts.map((f) => f.key)).size !== data.facts.length)
    throw new Error("Duplicate fact keys");
  return data.facts.map((f) => {
    if (!body.includes(f.originalDateText))
      throw new Error("Original date text is not source grounded");
    const date = f.dueAt || f.dateOnly;
    const year = date?.slice(0, 4);
    const missingYear = !!year && !f.originalDateText.includes(year);
    const missingZone =
      !!f.dueAt &&
      !/(?:UTC|GMT|ICT|Bangkok|Hanoi|Ho Chi Minh|Asia\/|America\/|Europe\/|[+-]\d{2}:?\d{2}|T\d{2}:\d{2}[^ ]*Z\b)/i.test(
        f.originalDateText,
      );
    if (missingYear || missingZone)
      return {
        ...f,
        dueAt: null,
        dateOnly: null,
        timezone: null,
        confidence: Math.min(f.confidence, 0.5),
        notes: [
          f.notes,
          missingYear ? "Original date has no explicit year." : null,
          missingZone ? "Original time has no explicit timezone." : null,
        ]
          .filter(Boolean)
          .join(" "),
      };
    return f;
  });
}
export const patchSchema = z
  .object({
    status: z.enum(["open", "done", "dismissed"]).optional(),
    dueAt: instantSchema.nullable().optional(),
    dateOnly: dateOnlySchema.nullable().optional(),
    title: z.string().min(1).max(300).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0)
  .refine((v) => !(v.dueAt && v.dateOnly), "Conflicting dates");
export function validatePatch(v: unknown) {
  return patchSchema.parse(v);
}
export interface MimePart {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: MimePart[];
  headers?: { name: string; value: string }[];
}
function decode(p: MimePart) {
  if (p.body?.attachmentId && !p.body.data)
    throw new Error("Large body requires attachment fetch");
  return p.body?.data
    ? Buffer.from(p.body.data, "base64url").toString("utf8")
    : "";
}
export function plainText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
export function parseMailBody(part: MimePart): string {
  const leaves: MimePart[] = [];
  function visit(p: MimePart) {
    if (p.parts) for (const c of p.parts) visit(c);
    else leaves.push(p);
  }
  visit(part);
  const plain = leaves.filter((p) => p.mimeType === "text/plain");
  if (plain.length) return plain.map(decode).join("\n");
  return leaves
    .filter((p) => p.mimeType === "text/html")
    .map((p) => plainText(decode(p)))
    .join("\n");
}
