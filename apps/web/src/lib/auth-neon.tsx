import { useEffect, useMemo } from "react";
import { createAuthClient } from "@neondatabase/neon-js/auth";
import { BetterAuthReactAdapter } from "@neondatabase/neon-js/auth/react/adapters";
import type { AuthContextValue, SessionUser } from "./auth.tsx";

/** Loaded on demand by AuthProvider; keeps the Neon Auth client out of the main bundle. */
export default function NeonSession({ authUrl, onChange }: { authUrl: string; onChange(value: AuthContextValue): void }) {
  const client = useMemo(() => createAuthClient(authUrl, { adapter: BetterAuthReactAdapter() }), [authUrl]);
  const session = client.useSession();
  const user = (session.data?.user as SessionUser | undefined) ?? null;
  const value = useMemo<AuthContextValue>(() => ({
    user,
    pending: session.isPending,
    available: true,
    signIn: async (email, password) => {
      const result = await client.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message ?? "Could not sign in.");
    },
    signOut: async () => { await client.signOut(); },
    bearer: async () => {
      const response = await fetch(`${authUrl.replace(/\/$/, "")}/token`, { credentials: "include" });
      if (!response.ok) return null;
      const result = await response.json() as { token?: string };
      return result.token ?? null;
    },
  }), [client, user, session.isPending, authUrl]);
  useEffect(() => { onChange(value); }, [value, onChange]);
  return null;
}
