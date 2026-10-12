import {
  bootstrapJetstream,
  bootstrapS3,
  createInfrastructure,
  ensureFusionBus,
  runMigrations,
  seedDemo,
} from '../packages/infrastructure/index';
import { bootstrapAdmin } from '../apps/api/src/auth/service';
const infra = await createInfrastructure();
try {
  await runMigrations(infra);
  await bootstrapJetstream(infra);
  await ensureFusionBus(infra);
  await bootstrapS3(infra);
  if (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD) {
    await bootstrapAdmin(infra);
  } else if (infra.config.production) {
    const admins = await infra.pool.query(
      "SELECT 1 FROM users WHERE role='admin' AND disabled=false LIMIT 1",
    );
    if (!admins.rowCount)
      throw new Error(
        'Initial production deployment requires explicit ADMIN_USERNAME and ADMIN_PASSWORD',
      );
  }
  if (!infra.config.production) await seedDemo(infra);
} finally {
  await infra.close();
}
