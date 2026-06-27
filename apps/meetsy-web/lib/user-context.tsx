"use client";

import { createContext, useContext } from "react";
import type { AuthPrincipal } from "./auth";

/**
 * Exposes the authenticated principal (from `GET /auth/me`) to the page tree.
 *
 * AppShell only mounts its children AFTER `me()` resolves (its `checked` gate),
 * so any component under the provider is guaranteed a non-null principal — the
 * `useCurrentUser` hook can therefore return `AuthPrincipal` directly without a
 * null dance. The hook throws only if used outside the provider (a wiring bug).
 */
const UserContext = createContext<AuthPrincipal | null>(null);

export function UserProvider({
  user,
  children,
}: {
  user: AuthPrincipal;
  children: React.ReactNode;
}) {
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

/** The signed-in principal. Must be called inside `<UserProvider>`. */
export function useCurrentUser(): AuthPrincipal {
  const user = useContext(UserContext);
  if (!user) {
    throw new Error("useCurrentUser must be used within <UserProvider>");
  }
  return user;
}
