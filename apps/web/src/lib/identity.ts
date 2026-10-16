export interface IdentityUser { name?: string | null; email?: string | null; role?: string | null }

export interface WorkspaceIdentity {
  signedIn: boolean;
  initials: string;
  title: string;
  subtitle: string;
}

/** What the sidebar chip says about who is using the app. Only what the session actually provides; nothing invented. */
export function workspaceIdentity(user: IdentityUser | null): WorkspaceIdentity {
  if (!user) return { signedIn: false, initials: "", title: "Open workspace", subtitle: "No sign-in required" };
  const named = user.name?.trim() || user.email?.trim() || "";
  const initials = named.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
  const role = user.role?.trim();
  return { signedIn: true, initials, title: named || "Signed in", subtitle: role ? role[0]!.toUpperCase() + role.slice(1) : "Signed in" };
}
