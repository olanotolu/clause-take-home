import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createAuthClient } from "@neondatabase/neon-js/auth";
import { BetterAuthReactAdapter } from "@neondatabase/neon-js/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
export const authConfigured = Boolean(authUrl);
export const neonAuth = createAuthClient(authUrl || "http://127.0.0.1:1", { adapter: BetterAuthReactAdapter() });

export interface SessionUser { id: string; email: string; name: string; image?: string | null; role?: string }
interface AuthContextValue {
  user: SessionUser | null;
  pending: boolean;
  available: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  bearer(): Promise<string | null>;
}
const empty: AuthContextValue = { user: null, pending: false, available: false, signIn: async () => { throw new Error("Neon Auth is not configured."); }, signOut: async () => {}, bearer: async () => null };
const AuthContext = createContext<AuthContextValue>(empty);
export const useAuth = () => useContext(AuthContext);

function ConfiguredAuthProvider({ children }: { children: ReactNode }) {
  const session = neonAuth.useSession();
  const user = (session.data?.user as SessionUser | undefined) ?? null;
  const value = useMemo<AuthContextValue>(() => ({
    user,
    pending: session.isPending,
    available: true,
    signIn: async (email, password) => {
      const result = await neonAuth.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message ?? "Could not sign in.");
    },
    signOut: async () => { await neonAuth.signOut(); },
    bearer: async () => {
      const response = await fetch(`${authUrl!.replace(/\/$/, "")}/token`, { credentials: "include" });
      if (!response.ok) return null;
      const result = await response.json() as { token?: string };
      return result.token ?? null;
    },
  }), [user, session.isPending]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return authConfigured ? <ConfiguredAuthProvider>{children}</ConfiguredAuthProvider> : <AuthContext.Provider value={empty}>{children}</AuthContext.Provider>;
}
