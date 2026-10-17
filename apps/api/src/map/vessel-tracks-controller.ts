import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  SetMetadata,
} from '@nestjs/common';
import type { Infrastructure } from '@ais/infrastructure';
import {
  queryVesselTracks,
  VesselTracksQueryError,
} from '../../../../packages/infrastructure/vessel-tracks';
import {
  VesselTracksQuerySchema,
  VesselTracksResultSchema,
} from '../../../../packages/contracts/vessel-tracks';
import { DocumentRoute, INFRA, MinimumRole, parse } from '../common';
import type { AuthRequest } from '../auth/guard';

@Controller('map/vessel-tracks')
export class VesselTracksController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}

  @Post('query')
  @HttpCode(200)
  @MinimumRole('viewer')
  @SetMetadata('allowViewerWrite', true)
  @DocumentRoute(
    'Bounded historical vessel tracks selected by recorded vessel information',
    VesselTracksResultSchema,
    VesselTracksQuerySchema,
  )
  async query(@Body() body: unknown, @Req() req: AuthRequest) {
    const input = parse(VesselTracksQuerySchema, body);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => {
      if (!req.res?.writableEnded) abort();
    };
    req.once('aborted', abort);
    req.res?.once('close', closed);
    if (req.aborted) abort();
    try {
      return await queryVesselTracks(this.infra, input, {
        ownerId: req.user.id,
        signal: controller.signal,
      });
    } catch (error) {
      if (!(error instanceof VesselTracksQueryError)) throw error;
      const status = {
        invalid_input: 400,
        retention: 400,
        data_limit: 413,
        busy: 429,
        cancelled: 499,
        unavailable: 503,
      }[error.category];
      throw new HttpException({ code: error.category, message: error.message }, status);
    } finally {
      req.off('aborted', abort);
      req.res?.off('close', closed);
    }
  }
}
