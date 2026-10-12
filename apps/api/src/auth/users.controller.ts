import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  NotFoundException,
  HttpCode,
  ConflictException,
} from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
import { UserRoleSchema } from '@ais/contracts';
import { DocumentRoute, INFRA, MinimumRole, Uuid, parse, audit } from '../common';
import type { AuthRequest } from './guard';
import { hashPassword } from './service';
import { CreateUserSchema, UserResponseSchema } from './schemas';
const ManageUserSchema = z.strictObject({
  role: UserRoleSchema,
  disabled: z.boolean(),
  password: z.string().min(12).max(1000).optional(),
});
const ManagedUserSchema = UserResponseSchema.extend({ disabled: z.boolean() });
@Controller('users')
@MinimumRole('admin')
export class UsersController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentRoute('Administrative user directory', z.array(ManagedUserSchema))
  async list() {
    return (
      await this.infra.pool.query(
        'SELECT id,username,role,disabled FROM users ORDER BY username LIMIT 1000',
      )
    ).rows;
  }
  @Post()
  @DocumentRoute(
    'Create an account with Argon2id password hashing',
    ManagedUserSchema,
    CreateUserSchema,
    201,
  )
  async create(@Body() body: unknown, @Req() req: AuthRequest) {
    const q = parse(CreateUserSchema, body);
    const result = await this.infra.pool.query(
      'INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,role,disabled',
      [randomUUID(), q.username, await hashPassword(q.password), q.role],
    );
    await audit(this.infra, req.user.id, 'user.create', 'user', result.rows[0].id, {
      username: q.username,
      role: q.role,
    });
    return result.rows[0];
  }
  @Put(':userId')
  @ApiParam({ name: 'userId', format: 'uuid' })
  @HttpCode(200)
  @DocumentRoute(
    'Change role, disable account or rotate password and revoke sessions',
    ManagedUserSchema,
    ManageUserSchema,
  )
  async update(@Param('userId') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
    parse(Uuid, id);
    const q = parse(ManageUserSchema, body);
    if (id === req.user.id && (q.disabled || q.role !== 'admin'))
      throw new ConflictException('Administrator must retain their own active account');
    const client = await this.infra.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'UPDATE users SET role=$2,disabled=$3,password_hash=coalesce($4,password_hash),updated_at=now() WHERE id=$1 RETURNING id,username,role,disabled',
        [id, q.role, q.disabled, q.password ? await hashPassword(q.password) : null],
      );
      if (!result.rows[0]) throw new NotFoundException('User not found');
      await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await client.query('COMMIT');
      await audit(this.infra, req.user.id, 'user.update', 'user', id, q);
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
