import { z } from 'zod';

export const VESSEL_TRACKS_MAX_HOURS = 168;
export const VESSEL_TRACKS_RETENTION_DAYS = 30;
export const VESSEL_TRACKS_MAX_TOTAL_POINTS = 10000;
const Timestamp = z.iso.datetime().max(40);
const Mmsi = z.string().regex(/^[1-9]\d{8}$/);
const Bbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((value) => value[1] <= value[3], 'South must precede north');

export const VesselTracksSelectorSchema = z
  .strictObject({
    shipTypes: z
      .array(z.number().int().min(1).max(99))
      .min(1)
      .max(30)
      .refine((items) => new Set(items).size === items.length, 'Duplicate ship types')
      .optional(),
    mmsis: z
      .array(Mmsi)
      .min(1)
      .max(100)
      .refine((items) => new Set(items).size === items.length, 'Duplicate vessels')
      .optional(),
    query: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    'A vessel selector is required',
  );
export type VesselTracksSelector = z.infer<typeof VesselTracksSelectorSchema>;

/** Absolute bounds also describe persisted results; execution applies retention separately. */
export const VesselTracksQuerySchema = z
  .strictObject({
    bbox: Bbox,
    from: Timestamp,
    to: Timestamp,
    selector: VesselTracksSelectorSchema,
    sourceId: z.string().min(1).max(200).optional(),
    maxVessels: z.number().int().min(1).max(50).default(20),
    maxPointsPerVessel: z.number().int().min(2).max(1000).default(500),
  })
  .refine(
    (query) =>
      Date.parse(query.from) < Date.parse(query.to) &&
      Date.parse(query.to) - Date.parse(query.from) <= VESSEL_TRACKS_MAX_HOURS * 3600000,
    'Track range must be positive and at most 168 hours',
  )
  .refine(
    (query) => query.maxVessels * query.maxPointsPerVessel <= VESSEL_TRACKS_MAX_TOTAL_POINTS,
    'Total point budget exceeds 10000',
  );
export type VesselTracksQuery = z.infer<typeof VesselTracksQuerySchema>;

export function validateVesselTracksWindow(input: unknown, now: Date): void {
  const asOf = now.getTime();
  if (!Number.isFinite(asOf)) throw new Error('Invalid execution clock');
  const query = VesselTracksQuerySchema.parse(input);
  if (Date.parse(query.from) < asOf - VESSEL_TRACKS_RETENTION_DAYS * 86400000)
    throw new Error('Track range exceeds 30 day retention');
  if (Date.parse(query.to) > asOf) throw new Error('Track range must not be in the future');
}
export const VesselTrackPointSchema = z.strictObject({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  observedAt: Timestamp,
});
export type VesselTrackPoint = z.infer<typeof VesselTrackPointSchema>;
export const VesselTrackSchema = z
  .strictObject({
    mmsi: Mmsi,
    name: z.string().max(1000).nullable(),
    shipType: z.number().int().min(1).max(99).nullable(),
    segments: z
      .array(z.strictObject({ points: z.array(VesselTrackPointSchema).min(1).max(1000) }))
      .max(1000),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    returned: z.number().int().nonnegative().max(1000),
    sampled: z.boolean(),
    truncated: z.boolean(),
  })
  .refine((track) => {
    const points = track.segments.flatMap((segment) => segment.points);
    return (
      track.returned === points.length &&
      track.total >= track.returned &&
      track.sampled === track.total > track.returned &&
      (!track.truncated || track.sampled) &&
      points.every(
        (point, index) =>
          index === 0 || Date.parse(point.observedAt) > Date.parse(points[index - 1]!.observedAt),
      ) &&
      track.segments.every((segment) =>
        segment.points.every(
          (point, index) =>
            index === 0 || Math.abs(point.lon - segment.points[index - 1]!.lon) <= 180,
        ),
      )
    );
  }, 'Invalid track counts, order or segment boundaries');
export type VesselTrack = z.infer<typeof VesselTrackSchema>;
export const VesselTracksResultSchema = z
  .strictObject({
    query: VesselTracksQuerySchema,
    asOf: Timestamp,
    generatedAt: Timestamp,
    shipTypeBasis: z.literal('current_profile'),
    selectionBasis: z.literal('historical_observation_in_bbox'),
    trackScope: z.literal('full_time_window'),
    returnedVessels: z.number().int().nonnegative().max(50),
    matchedVesselsLowerBound: z.number().int().nonnegative().max(51),
    hasMoreVessels: z.boolean(),
    tracks: z.array(VesselTrackSchema).max(50),
  })
  .refine((result) => {
    const from = Date.parse(result.query.from),
      to = Date.parse(result.query.to);
    return (
      to <= Date.parse(result.asOf) &&
      result.tracks.length === result.returnedVessels &&
      result.returnedVessels <= result.query.maxVessels &&
      new Set(result.tracks.map((track) => track.mmsi)).size === result.tracks.length &&
      (result.hasMoreVessels
        ? result.matchedVesselsLowerBound > result.returnedVessels
        : result.matchedVesselsLowerBound === result.returnedVessels) &&
      result.tracks.reduce((sum, track) => sum + track.returned, 0) <=
        VESSEL_TRACKS_MAX_TOTAL_POINTS &&
      result.tracks.every(
        (track) =>
          track.returned <= result.query.maxPointsPerVessel &&
          track.segments.every((segment) =>
            segment.points.every(
              (point) => Date.parse(point.observedAt) >= from && Date.parse(point.observedAt) < to,
            ),
          ),
      )
    );
  }, 'Result must match query bounds and counts');
export type VesselTracksResult = z.infer<typeof VesselTracksResultSchema>;
export const AgentVesselTracksResultSchema = VesselTracksResultSchema.safeExtend({
  kind: z.literal('vessel_tracks'),
  version: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative(),
});
export type AgentVesselTracksResult = z.infer<typeof AgentVesselTracksResultSchema>;
