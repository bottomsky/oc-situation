import { createInfrastructure, runMigrations, seedDemo } from '@ais/infrastructure';
import { bootstrapAdmin } from '../apps/api/src/auth/service';
const infra = await createInfrastructure();
try {
  await runMigrations(infra);
  if (!infra.config.production) await seedDemo(infra);
  await bootstrapAdmin(infra);
  console.log('管理员初始化完成；开发环境已建立受控样例来源');
} finally {
  await infra.close();
}
