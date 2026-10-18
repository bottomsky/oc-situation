import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Infrastructure } from '../../../../packages/infrastructure/clients';
import { RoutePlanningScheduler } from '../../../../packages/infrastructure/route-planning';
import { INFRA, OPTIONS, type ApiOptions } from '../common';
@Injectable()
export class RoutePlanningService implements OnModuleInit, OnModuleDestroy {
  private scheduler: RoutePlanningScheduler;
  constructor(
    @Inject(INFRA) infra: Infrastructure,
    @Inject(OPTIONS) private options: ApiOptions,
  ) {
    this.scheduler = new RoutePlanningScheduler(infra);
  }
  onModuleInit() {
    if (this.options.scheduler && process.env.ROUTE_PLANNING_ENABLED !== 'false')
      this.scheduler.start();
  }
  async onModuleDestroy() {
    await this.scheduler.stop();
  }
}
