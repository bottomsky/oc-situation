import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import openapiTS from 'openapi-typescript';
import { DynamicSkillExecutionSchema } from '../../../packages/contracts/dynamic-skills';
import { schemaJson } from './common';

describe('OpenAPI内嵌JSON值schema', () => {
  it('递归JSON字段转换为内嵌自由值schema并保留其他字段约束', () => {
    const result = schemaJson(z.strictObject({ payload: z.json(), label: z.string().min(3) }));
    expect(result).toMatchObject({
      type: 'object',
      properties: { payload: {}, label: { type: 'string', minLength: 3 } },
      additionalProperties: false,
    });
    expect(JSON.stringify(result)).not.toContain('$ref');
    expect(schemaJson(z.json())).toEqual({});
  });
  it('文档转换保留运行时JSON校验', () => {
    const runtime = z.json();
    schemaJson(runtime);
    expect(runtime.safeParse({ nested: [null, true, { value: 3 }] }).success).toBe(true);
    expect(runtime.safeParse({ value: new Date() }).success).toBe(false);
  });
  it('真实动态执行响应内嵌OpenAPI后可由客户端生成器解析', async () => {
    const schema = schemaJson(DynamicSkillExecutionSchema);
    const document = {
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
      paths: {
        '/skills': {
          get: {
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema } } },
            },
          },
        },
      },
    };
    await expect(openapiTS(Buffer.from(JSON.stringify(document)))).resolves.toHaveProperty(
      'length',
    );
  });
});
