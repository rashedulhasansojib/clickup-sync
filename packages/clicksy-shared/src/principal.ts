/** Org roles, matching Clicksy's Prisma `Role` enum values. */
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

/** Identity attached to every authenticated request, shared across services. */
export interface AuthPrincipal {
  userId: string;
  orgId: string;
  role: Role;
  email: string | null;
  isMachine: boolean;
}
