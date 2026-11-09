import { it, expect } from "vitest";
import {
  validateFacts,
  parseMailBody,
  validatePatch,
} from "../../lib/extraction";
const fact = {
  key: "exam",
  title: "Final exam",
  kind: "exam",
  dueAt: null,
  dateOnly: "2026-12-10",
  timezone: null,
  originalDateText: "10 December",
  evidence: "exam on 10 December",
  confidence: 0.9,
  cancelled: false,
};
it("keeps independently evidenced dates without inventing midnight", () => {
  const f = validateFacts(
    { facts: [fact, { ...fact, key: "homework", dateOnly: "2026-12-11" }] },
    "Final exam on 10 December",
  );
  expect(f).toHaveLength(2);
  expect(f[0].dueAt).toBeNull();
});
it("rejects invented evidence and invalid calendar dates", () => {
  expect(() => validateFacts({ facts: [fact] }, "unrelated")).toThrow();
  expect(() =>
    validateFacts(
      { facts: [{ ...fact, dateOnly: "2026-02-30" }] },
      fact.evidence,
    ),
  ).toThrow();
  expect(() =>
    validateFacts(
      { facts: [{ ...fact, dueAt: "2026-12-10T10:00:00", dateOnly: null }] },
      fact.evidence,
    ),
  ).toThrow();
});
it("uses full plain MIME contents not snippets", () => {
  expect(
    parseMailBody({
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("full exam body").toString("base64url") },
        },
      ],
    }),
  ).toBe("full exam body");
  expect(() =>
    parseMailBody({ mimeType: "text/plain", body: { attachmentId: "a" } }),
  ).toThrow();
});
it("requires explicit nonconflicting review dates", () => {
  expect(() => validatePatch({ dateOnly: "2026-02-30" })).toThrow();
  expect(() =>
    validatePatch({ dateOnly: "2026-12-10", dueAt: "2026-12-10T05:00:00Z" }),
  ).toThrow();
  expect(validatePatch({ status: "done" })).toEqual({ status: "done" });
});
