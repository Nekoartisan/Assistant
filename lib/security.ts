import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("Session configuration missing");
  return s;
}
export function sign(data: Record<string, unknown>, seconds = 43200) {
  const body = Buffer.from(
    JSON.stringify({ ...data, exp: Date.now() + seconds * 1000 }),
  ).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret()).update(body).digest("base64url")
  );
}
export function verify(token: string): Record<string, unknown> | null {
  try {
    const [body, sig, ...rest] = token.split(".");
    if (
      rest.length ||
      !equal(
        sig,
        createHmac("sha256", secret()).update(body).digest("base64url"),
      )
    )
      return null;
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return typeof data.exp === "number" && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}
function key() {
  const k = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || "", "base64");
  if (k.length !== 32)
    throw new Error("Token encryption configuration missing");
  return k;
}
export function encrypt(value: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key(), iv);
  return Buffer.concat([
    iv,
    c.update(value, "utf8"),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64url");
}
export function decrypt(value: string) {
  const b = Buffer.from(value, "base64url");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}
export function validOrigin(r: Request) {
  try {
    return (
      r.headers.get("origin") === new URL(process.env.APP_URL || "").origin
    );
  } catch {
    return false;
  }
}
export function passwordMatches(value: string) {
  const p = process.env.OWNER_PASSWORD || "";
  return p.length >= 16 && equal(value, p);
}
export function authenticated(r: Request) {
  const token = r.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("bao_session="))
    ?.slice(12);
  return !!token && verify(token)?.owner === true;
}
export function cookie(
  name: string,
  value: string,
  maxAge: number,
  sameSite = "Strict",
) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${process.env.APP_URL?.startsWith("https:") ? "; Secure" : ""}`;
}
export function cronAuthorized(r: Request) {
  const s = process.env.CRON_SECRET;
  return (
    !!s &&
    s.length >= 32 &&
    equal(r.headers.get("authorization") || "", `Bearer ${s}`)
  );
}
