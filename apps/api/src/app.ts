import type { NestExpressApplication } from '@nestjs/platform-express';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Infrastructure } from '@ais/infrastructure';
import { AccessGuard } from './auth/guard';
import { AuthService } from './auth/service';
import { AuthController } from './auth/controller';
import { UsersController } from './auth/users.controller';
import { VesselsController } from './vessels/controller';
import { MapController } from './map/controller';
import { SourcesController } from './sources/controller';
import { JobsController } from './jobs/controller';
import { JobsService } from './jobs/service';
import { RunsController } from './runs/controller';
import { QualityController } from './quality/controller';
import { ReplayController } from './replay/controller';
import { SystemController } from './system/controller';
import { ApiExceptionFilter, INFRA, OPTIONS, type ApiOptions } from './common';
import { trustedProxies } from './auth/proxy';
import { IntelligenceController } from './intelligence/controller';
import { TopicsController, AnalysisController } from './topics/controller';
import { readLiveAnalysisFeed, logger } from '@ais/infrastructure';
import { attachLiveGateway } from './live/gateway';
import { AgentController } from './agent/controller';
export async function createApi(infra: Infrastructure, options: Partial<ApiOptions> = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origins =
    options.origins ??
    process.env.WEB_ORIGINS?.split(',')
      .map((v) => v.trim())
      .filter(Boolean) ??
    (production ? [] : ['http://127.0.0.1:13001', 'http://localhost:13001']);
  if (production && !origins.length) throw new Error('Explicit WEB_ORIGINS required in production');
  const settings: ApiOptions = { production, origins, scheduler: options.scheduler ?? true };
  @Module({
    controllers: [
      AuthController,
      UsersController,
      VesselsController,
      MapController,
      SourcesController,
      JobsController,
      RunsController,
      QualityController,
      ReplayController,
      SystemController,
      IntelligenceController,
      TopicsController,
      AnalysisController,
      AgentController,
    ],
    providers: [
      { provide: INFRA, useValue: infra },
      { provide: OPTIONS, useValue: settings },
      AuthService,
      JobsService,
      { provide: APP_GUARD, useClass: AccessGuard },
    ],
  })
  class ApiModule {}
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    logger: ['error', 'warn'],
    bodyParser: true,
  });
  app.useBodyParser('json', { limit: '4mb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  const adapter = app.getHttpAdapter().getInstance();
  adapter.set('trust proxy', trustedProxies(production, process.env.TRUSTED_PROXY_CIDRS));
  adapter.disable('x-powered-by');
  adapter.use(
    (_req: unknown, res: { setHeader: (key: string, value: string) => void }, next: () => void) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  const openapi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('AIS intelligence API')
      .setVersion('1.0.0')
      .setDescription(
        'Same origin session cookie authentication. Login requires exact allowed Origin; all subsequent writes require Origin and X-CSRF-Token returned by login/me. Idempotency-Key UUID is required for run and replay.',
      )
      .addCookieAuth('ais_session')
      .build(),
  );
  // Documentation is served through the API authentication guard via controllers only; export offline for client generation.
  await app.init();
  const live = attachLiveGateway(app.getHttpServer(), {
    origins,
    authenticate: (token) => app.get(AuthService).session(token),
    readFeed: (cursor) => readLiveAnalysisFeed(infra, cursor),
    readMap: (query) => app.get(MapController).get(query),
    onError: (error) =>
      logger.warn(
        { error: error instanceof Error ? error.message : 'Live update failed' },
        'Live gateway retry pending',
      ),
  });
  const jobs = app.get(JobsService);
  if (settings.scheduler) jobs.start();
  return {
    app,
    openapi,
    stop: async () => {
      jobs.stop();
      await live.close();
      await app.close();
    },
  };
}
