import { it, expect } from "vitest";
import { validateFacts } from "../../lib/extraction";
const f = {
  key: "exam",
  title: "Exam",
  kind: "exam",
  dueAt: null,
  dateOnly: "2026-12-10",
  timezone: null,
  originalDateText: "10 December",
  evidence: "Exam 10 December",
  confidence: 1,
  cancelled: false,
};
it("demotes model-invented years to manual review", () => {
  const [r] = validateFacts({ facts: [f] }, "Exam 10 December");
  expect(r.dateOnly).toBeNull();
  expect(r.confidence).toBeLessThan(0.8);
});
it("demotes exact times lacking explicit original timezone", () => {
  const [r] = validateFacts(
    {
      facts: [
        {
          ...f,
          dueAt: "2026-12-10T03:00:00Z",
          dateOnly: null,
          originalDateText: "10 December 2026 10:00",
          evidence: "Exam 10 December 2026 10:00",
        },
      ],
    },
    "Exam 10 December 2026 10:00",
  );
  expect(r.dueAt).toBeNull();
  expect(r.timezone).toBeNull();
  expect(r.confidence).toBeLessThan(0.8);
});
