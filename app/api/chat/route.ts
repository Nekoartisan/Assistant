import { z } from "zod";
import { endpoint, json, protect, limit, body } from "../../../lib/http";
export const maxDuration = 60;
export const POST = endpoint(async (r) => {
  protect(r, true);
  await limit("chat", 15);
  const d = z
    .object({
      message: z.string().min(1).max(4000),
      weeks: z.number().int().min(1).max(8).optional(),
    })
    .strict()
    .parse(await body(r));
  const { answerChat } = await import("../../../lib/chat");
  return json(await answerChat(d.message, d.weeks || 1));
});
