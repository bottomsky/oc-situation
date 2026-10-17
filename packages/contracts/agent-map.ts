import { z } from 'zod';

export const MAP_HIGHLIGHT_LIMIT = 100;
const Mmsi = z.string().regex(/^[1-9]\d{8}$/);
const Bbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((v) => v[1] <= v[3], 'South must precede north');
const Point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const HighlightVesselSchema = z.strictObject({
  mmsi: Mmsi,
  name: z.string().max(1000).nullable(),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  observedAt: z.iso.datetime(),
});
export type HighlightVessel = z.infer<typeof HighlightVesselSchema>;
export const HighlightGroupSchema = z.strictObject({
  groupId: z.uuid(),
  taskId: z.uuid(),
  mmsis: z
    .array(Mmsi)
    .min(1)
    .max(MAP_HIGHLIGHT_LIMIT)
    .refine((items) => new Set(items).size === items.length, 'Duplicate vessels'),
});
export type HighlightGroup = z.infer<typeof HighlightGroupSchema>;
export const HighlightClearSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({
    mode: z.literal('groups'),
    groupIds: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine((items) => new Set(items).size === items.length, 'Duplicate groups'),
  }),
]);
export type HighlightClear = z.infer<typeof HighlightClearSchema>;
export const MapCameraRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('point'),
    center: Point,
    zoom: z.number().min(0).max(22).default(10),
  }),
  z.strictObject({
    mode: z.literal('bounds'),
    bbox: Bbox,
    maxZoom: z.number().min(0).max(22).default(10),
  }),
  z
    .strictObject({
      mode: z.literal('current'),
      zoom: z.number().min(0).max(22).optional(),
      zoomDelta: z.number().min(-22).max(22).optional(),
    })
    .refine(
      (v) => (v.zoom === undefined) !== (v.zoomDelta === undefined),
      'Choose absolute or relative zoom',
    ),
]);
export type MapCameraRequest = z.infer<typeof MapCameraRequestSchema>;
export const MapCameraStateSchema = z.strictObject({
  center: Point,
  zoom: z.number().min(0).max(22),
  bbox: Bbox,
});
export const MapCameraResultSchema = MapCameraStateSchema.extend({ commandId: z.uuid() });
export type MapCameraResult = z.infer<typeof MapCameraResultSchema>;
export const AgentVesselHighlightsResultSchema = z
  .strictObject({
    kind: z.literal('vessel_highlights'),
    version: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    operation: z.enum(['show', 'clear']),
    vessels: z
      .array(HighlightVesselSchema)
      .max(MAP_HIGHLIGHT_LIMIT)
      .refine(
        (items) => new Set(items.map((v) => v.mmsi)).size === items.length,
        'Duplicate vessels',
      ),
    missingMmsis: z.array(Mmsi).max(MAP_HIGHLIGHT_LIMIT),
    clear: HighlightClearSchema.optional(),
  })
  .refine(
    (v) =>
      v.operation === 'show'
        ? v.vessels.length > 0 && !v.clear
        : !!v.clear && v.vessels.length === 0,
    'Invalid highlight operation',
  );
export type AgentVesselHighlightsResult = z.infer<typeof AgentVesselHighlightsResultSchema>;
export const AgentMapCameraResultSchema = z.strictObject({
  kind: z.literal('map_camera'),
  version: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative(),
  request: MapCameraRequestSchema,
});
export type AgentMapCameraResult = z.infer<typeof AgentMapCameraResultSchema>;
export const HighlightEvidenceSchema = z.strictObject({
  artifactRef: z.uuid(),
  groups: z.array(HighlightGroupSchema).max(100),
});
export type HighlightEvidence = z.infer<typeof HighlightEvidenceSchema>;
