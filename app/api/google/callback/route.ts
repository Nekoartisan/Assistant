import { endpoint, limit, HttpError } from "../../../../lib/http";
import { oauthFinish } from "../../../../lib/google";
import { cookie } from "../../../../lib/security";
export const GET = endpoint(async (r) => {
  await limit("oauth-callback", 20);
  const u = new URL(r.url);
  const c = r.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("bao_oauth="))
    ?.slice(10);
  if (!c || !u.searchParams.get("state") || !u.searchParams.get("code"))
    throw new HttpError(400, "Google connection cancelled or invalid state");
  try {
    await oauthFinish(
      u.searchParams.get("code")!,
      u.searchParams.get("state")!,
      c,
    );
    return new Response(null, {
      status: 303,
      headers: {
        Location: process.env.APP_URL + "/?google=connected",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("bao_oauth", "", 0, "Lax"),
      },
    });
  } catch {
    return new Response(null, {
      status: 303,
      headers: {
        Location: process.env.APP_URL + "/?google=failed",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie("bao_oauth", "", 0, "Lax"),
      },
    });
  }
});
