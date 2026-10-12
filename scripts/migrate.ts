import {
  bootstrapJetstream,
  bootstrapS3,
  createInfrastructure,
  ensureFusionBus,
  runMigrations,
} from '@ais/infrastructure';
const infra = await createInfrastructure();
try {
  await runMigrations(infra);
  await bootstrapJetstream(infra);
  await ensureFusionBus(infra);
  await bootstrapS3(infra);
  console.log('数据库迁移、必需消费者与对象存储初始化完成');
} finally {
  await infra.close();
}
