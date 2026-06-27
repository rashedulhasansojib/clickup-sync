import { z } from "zod";

/**
 * Phase 4 — authentication contracts (self-hosted JWT).
 */
export const UserRole = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof UserRole>;

export const RegisterRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).max(120),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: UserRole,
  orgId: z.string(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

/** Returned by register + login. */
export const AuthResponseSchema = z.object({
  user: AuthUserSchema,
  tokens: AuthTokensSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

/** Returned by refresh. */
export const RefreshResponseSchema = z.object({
  tokens: AuthTokensSchema,
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
