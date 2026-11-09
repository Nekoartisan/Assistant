import { endpoint, json, protect } from "../../../../lib/http";
import { cookie } from "../../../../lib/security";
export const POST = endpoint(async (r) => {
  protect(r, true);
  return json({ ok: true }, 200, {
    "Set-Cookie": cookie("bao_session", "", 0),
  });
});
