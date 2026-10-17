import {
  BadRequestException,
  Catch,
  HttpException,
  SetMetadata,
  applyDecorators,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Infrastructure } from '@ais/infrastructure';
export const INFRA = Symbol('Infrastructure');
export const OPTIONS = Symbol('ApiOptions');
export interface ApiOptions {
  production: boolean;
  origins: string[];
  scheduler: boolean;
}
export const Public = () => SetMetadata('public', true);
export const MinimumRole = (role: 'viewer' | 'operator' | 'admin') => SetMetadata('role', role);
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  return result.data;
}
// Runtime validators are also the source for request/response OpenAPI schemas.
function isRecursiveJson(schema: z.core.$ZodTypes) {
  // Zod's public z.json() factory is a lazy union of these six JSON value types.
  if (!(schema instanceof z.ZodLazy)) return false;
  const inner = schema.unwrap();
  if (!(inner instanceof z.ZodUnion) || inner.options.length !== 6) return false;
  return (
    inner.options.some((option) => option instanceof z.ZodString) &&
    inner.options.some((option) => option instanceof z.ZodNumber) &&
    inner.options.some((option) => option instanceof z.ZodBoolean) &&
    inner.options.some((option) => option instanceof z.ZodNull) &&
    inner.options.some((option) => option instanceof z.ZodArray && option.element === schema) &&
    inner.options.some(
      (option) =>
        option instanceof z.ZodRecord &&
        option.keyType instanceof z.ZodString &&
        option.valueType === schema,
    )
  );
}
function inlineSchemaDefinitions(
  value: unknown,
  definitions: Record<string, unknown>,
  active = new Set<string>(),
): unknown {
  if (Array.isArray(value))
    return value.map((item) => inlineSchemaDefinitions(item, definitions, active));
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/definitions/')) {
    const name = ref.slice('#/definitions/'.length).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!(name in definitions) || active.has(ref))
      throw new Error(`OpenAPI requires a document-level schema for ${ref}`);
    return {
      ...(inlineSchemaDefinitions(
        definitions[name],
        definitions,
        new Set([...active, ref]),
      ) as object),
      ...(inlineSchemaDefinitions(
        Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref')),
        definitions,
        active,
      ) as object),
    };
  }
  if (ref === '#')
    throw new Error('OpenAPI requires a document-level schema for recursive objects');
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'definitions')
      .map(([key, item]) => [key, inlineSchemaDefinitions(item, definitions, active)]),
  );
}
export function schemaJson(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if (!isRecursiveJson(zodSchema)) return;
      const description = jsonSchema.description;
      for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
      if (description) jsonSchema.description = description;
    },
  });
  // Each route embeds its schema below a response/body; fragment refs would target the
  // OpenAPI document root. Inline Zod's local definitions after mapping JSON to {}.
  return inlineSchemaDefinitions(
    json,
    (json.definitions ?? {}) as Record<string, unknown>,
  ) as Extract<Parameters<typeof ApiBody>[0], { schema: unknown }>['schema'];
}
export function DocumentRoute(
  summary: string,
  response: z.ZodType,
  body?: z.ZodType,
  status = 200,
) {
  return applyDecorators(
    ApiOperation({ summary }),
    ApiCookieAuth('ais_session'),
    ApiResponse({ status, schema: schemaJson(response) }),
    ApiResponse({ status: 400, description: 'Validation error' }),
    ApiResponse({ status: 401, description: 'Session required' }),
    ApiResponse({ status: 403, description: 'Role, origin or CSRF denied' }),
    ...(body ? [ApiBody({ schema: schemaJson(body) })] : []),
  );
}
export function DocumentQuery(schema: z.ZodObject) {
  return applyDecorators(
    ...Object.entries(schema.shape).map(([name, value]) =>
      ApiQuery({
        name,
        required: !(value as z.ZodType).isOptional(),
        schema: schemaJson(value as z.ZodType),
      }),
    ),
  );
}
export const PageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export const Uuid = z.uuid();
export const SafeId = z.string().min(1).max(200);
export const EmptyResponse = z.strictObject({});
export const Iso = z.iso.datetime();
export const JsonObject = z.record(z.string(), z.unknown());
export const PageResponse = (item: z.ZodType) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export const nowIso = () => new Date().toISOString();
export const isoValue = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !/password|token|secret|credential|authorization|cookie|api.?key/i.test(key),
        )
        .map(([key, child]) => [key, redact(child)]),
    );
  return value;
}
export async function audit(
  infra: Infrastructure,
  userId: string,
  action: string,
  type: string,
  resourceId: string,
  details: unknown = {},
) {
  await infra.pool.query(
    'INSERT INTO audit(id,user_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [randomUUID(), userId, action, type, resourceId, JSON.stringify(redact(details))],
  );
}
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const pgCode = (exception as { code?: string })?.code;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : ['23505', '23503'].includes(pgCode ?? '')
          ? 409
          : 503;
    const content = exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      typeof content === 'string' ? content : (content as { message?: string })?.message;
    response.status(status).json({
      error: {
        code:
          status === 503
            ? 'SERVICE_UNAVAILABLE'
            : status === 400
              ? 'VALIDATION_ERROR'
              : status === 401
                ? 'UNAUTHORIZED'
                : status === 403
                  ? 'FORBIDDEN'
                  : status === 404
                    ? 'NOT_FOUND'
                    : `HTTP_${status}`,
        message: message ?? 'Service temporarily unavailable',
        requestId: randomUUID(),
      },
    });
  }
}
