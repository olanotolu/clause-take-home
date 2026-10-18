import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { SessionError, viewerFromHeader } from "../src/auth/session.ts";

const ISSUER = "https://example.supabase.co/auth/v1";

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { exp?: string; issuer?: string; audience?: string } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuedAt().setIssuer(opts.issuer ?? ISSUER).setAudience(opts.audience ?? "authenticated").setExpirationTime(opts.exp ?? "1h").sign(privateKey);
  return { keys, sign };
}

describe("viewerFromHeader", () => {
  it("is anonymous with no header", async () => {
    const { keys } = await fixture();
    expect(await viewerFromHeader(undefined, keys, ISSUER)).toBeUndefined();
  });

  it("returns the subject for a valid token", async () => {
    const { keys, sign } = await fixture();
    const token = await sign({ sub: "user-1", role: "authenticated" });
    expect(await viewerFromHeader(`Bearer ${token}`, keys, ISSUER)).toEqual({ id: "user-1" });
  });

  it("refuses an expired token instead of treating it as anonymous", async () => {
    const { keys, sign } = await fixture();
    const token = await sign({ sub: "user-1" }, { exp: "-1h" });
    await expect(viewerFromHeader(`Bearer ${token}`, keys, ISSUER)).rejects.toBeInstanceOf(SessionError);
  });

  it("refuses a token from another issuer or audience", async () => {
    const { keys, sign } = await fixture();
    await expect(viewerFromHeader(`Bearer ${await sign({ sub: "u" }, { issuer: "https://evil.example/auth/v1" })}`, keys, ISSUER)).rejects.toBeInstanceOf(SessionError);
    await expect(viewerFromHeader(`Bearer ${await sign({ sub: "u" }, { audience: "other" })}`, keys, ISSUER)).rejects.toBeInstanceOf(SessionError);
  });

  it("refuses a token signed by a key not in the JWKS", async () => {
    const { keys } = await fixture();
    const other = await fixture();
    const forged = await other.sign({ sub: "user-1" });
    await expect(viewerFromHeader(`Bearer ${forged}`, keys, ISSUER)).rejects.toBeInstanceOf(SessionError);
  });

  it("refuses a malformed Authorization header", async () => {
    const { keys } = await fixture();
    await expect(viewerFromHeader("Basic abc", keys, ISSUER)).rejects.toBeInstanceOf(SessionError);
  });
});
