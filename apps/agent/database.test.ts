import { describe, expect, it } from 'vitest';
import { agentDatabaseUrl } from './database';

describe('智能体专用数据库超时', () => {
  it('保留URL凭证和既有连接参数，追加服务端语句与锁超时', () => {
    const source =
      'postgresql://user:synthetic%40pass@localhost:5432/db?sslmode=require&options=-c%20search_path%3Dais%20-c%20application_name%3Dagent';
    const output = new URL(agentDatabaseUrl(source));
    expect(output.username).toBe('user');
    expect(output.password).toBe('synthetic%40pass');
    expect(output.searchParams.get('sslmode')).toBe('require');
    expect(output.searchParams.get('options')).toBe(
      '-c search_path=ais -c application_name=agent -c statement_timeout=60000 -c lock_timeout=5000',
    );
    expect(source).not.toContain('statement_timeout');
  });
  it('已有超时配置仍保留，并以专用worker边界作为最后有效值', () => {
    const output = new URL(
      agentDatabaseUrl('postgres://localhost/db?options=-c%20statement_timeout%3D0'),
    );
    expect(output.searchParams.get('options')).toBe(
      '-c statement_timeout=0 -c statement_timeout=60000 -c lock_timeout=5000',
    );
  });
});
