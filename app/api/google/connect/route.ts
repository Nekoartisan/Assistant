import { endpoint, protect, limit, HttpError } from "../../../../lib/http";
import { oauthStart } from "../../../../lib/google";
import { cookie } from "../../../../lib/security";
export const GET = endpoint(async (r) => {
  protect(r);
  await limit("oauth", 10);
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.OWNER_EMAILS
  )
    throw new HttpError(503, "Google OAuth setup required");
  const s = oauthStart();
  return new Response(null, {
    status: 302,
    headers: {
      Location: s.url,
      "Cache-Control": "no-store",
      "Set-Cookie": cookie("bao_oauth", s.state, 600, "Lax"),
    },
  });
});
