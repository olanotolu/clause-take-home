import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Who is calling. `undefined` means anonymous: the caller may read shared documents but owns none. */
export interface Viewer {
  id: string;
}

export class SessionError extends Error {}

/**
 * Verifies a Supabase Auth access token (an asymmetric JWT, checked against the project's public JWKS). Anonymous
 * callers pass no header and get `undefined`. A header that does not verify is an error, never a silent downgrade to
 * anonymous, so an expired or forged token cannot read as "no owner".
 */
export async function viewerFromHeader(header: string | undefined, keys: JWTVerifyGetKey, issuer: string): Promise<Viewer | undefined> {
  if (!header) return undefined;
  if (!header.startsWith("Bearer ")) throw new SessionError("Authorization must be a Bearer token.");
  try {
    const { payload } = await jwtVerify(header.slice(7), keys, { issuer, audience: "authenticated" });
    if (typeof payload.sub !== "string" || payload.sub === "") throw new SessionError("Token has no subject.");
    return { id: payload.sub };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("Your session is invalid or expired. Sign in again.");
  }
}

/** The project's JWKS, cached by jose. Supabase publishes it at `<project>/auth/v1/.well-known/jwks.json`. */
export function supabaseKeys(projectUrl: string): { keys: JWTVerifyGetKey; issuer: string } {
  const base = projectUrl.replace(/\/$/, "");
  return { keys: createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`)), issuer: `${base}/auth/v1` };
}
