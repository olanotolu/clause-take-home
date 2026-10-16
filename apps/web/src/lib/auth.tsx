import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from "react";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
export const authConfigured = Boolean(authUrl);

export interface SessionUser { id: string; email: string; name: string; image?: string | null; role?: string }
export interface AuthContextValue {
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

// The auth client is a large dependency that only matters once someone signs in, so it loads after first paint. It
// renders beside the app and reports the session through onChange, which keeps the app tree mounted while it loads.
const NeonSession = lazy(() => import("./auth-neon.tsx"));

export function AuthProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<AuthContextValue>(authConfigured ? { ...empty, pending: true } : empty);
  return (
    <AuthContext.Provider value={value}>
      {children}
      {authConfigured && <Suspense fallback={null}><NeonSession authUrl={authUrl!} onChange={setValue} /></Suspense>}
    </AuthContext.Provider>
  );
}
