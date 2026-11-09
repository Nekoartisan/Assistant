import { endpoint, json, HttpError } from "../../../lib/http";
import { cronAuthorized } from "../../../lib/security";
export const maxDuration = 120;
export const GET = endpoint(async (r) => {
  if (!cronAuthorized(r)) throw new HttpError(401, "Unauthorized");
  const task = new URL(r.url).searchParams.get("task");
  if (!["morning", "evening", "poll"].includes(task || ""))
    throw new HttpError(400, "Invalid cron task");
  const { runReminders } = await import("../../../lib/reminders");
  return json(await runReminders(task as "morning" | "evening" | "poll"));
});
