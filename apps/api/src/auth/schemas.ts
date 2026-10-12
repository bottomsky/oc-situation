import { z } from 'zod';
import { UserRoleSchema } from '@ais/contracts';
export const LoginSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
});
export const UserResponseSchema = z.strictObject({
  id: z.uuid(),
  username: z.string(),
  role: UserRoleSchema,
});
export const SessionResponseSchema = z.strictObject({
  user: UserResponseSchema,
  csrfToken: z.string(),
  expiresAt: z.iso.datetime(),
});
export const CreateUserSchema = z.strictObject({
  username: z.string().regex(/^[\p{L}\p{N}_.@-]{1,100}$/u),
  password: z.string().min(12).max(1000),
  role: UserRoleSchema,
});
