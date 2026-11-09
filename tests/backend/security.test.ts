import { describe, it, expect } from "vitest";
import {
  sign,
  verify,
  encrypt,
  decrypt,
  validOrigin,
  passwordMatches,
} from "../../lib/security";
describe("owner security", () => {
  it("rejects expired and forged cookies", () => {
    process.env.SESSION_SECRET = "s".repeat(40);
    const t = sign({ owner: true }, 60);
    expect(verify(t)?.owner).toBe(true);
    expect(verify(t + "x")).toBeNull();
    expect(verify(sign({ owner: true }, -1))).toBeNull();
  });
  it("encrypts tokens with authenticated encryption", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
    const c = encrypt("private-token");
    expect(c).not.toContain("private");
    expect(decrypt(c)).toBe("private-token");
    expect(() => decrypt(c.slice(0, -4) + "AAAA")).toThrow();
  });
  it("requires exact configured origin and long password", () => {
    process.env.APP_URL = "https://bao.example";
    process.env.OWNER_PASSWORD = "a".repeat(16);
    expect(
      validOrigin(
        new Request("https://bao.example/api/sync", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toBe(false);
    expect(passwordMatches("a".repeat(16))).toBe(true);
    expect(passwordMatches("wrong")).toBe(false);
  });
});
