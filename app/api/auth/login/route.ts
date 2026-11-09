import { z } from "zod";
import { endpoint, json, body, limit, HttpError } from "../../../../lib/http";
import {
  validOrigin,
  passwordMatches,
  sign,
  cookie,
} from "../../../../lib/security";
export const POST = endpoint(async (r) => {
  if (!validOrigin(r)) throw new HttpError(403, "Invalid request origin");
  await limit("owner-login", 8, 900);
  const data = z
    .object({ password: z.string().max(1024) })
    .strict()
    .parse(await body(r));
  if (!passwordMatches(data.password))
    throw new HttpError(401, "Invalid password");
  return json({ ok: true }, 200, {
    "Set-Cookie": cookie("bao_session", sign({ owner: true }), 43200),
  });
});
