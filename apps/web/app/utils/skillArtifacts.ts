import { AgentQueryResultSchema } from '../../../../packages/contracts/agent';
import { AgentHeatmapResultSchema } from '../../../../packages/contracts/heatmap';
import { AgentVesselTracksResultSchema } from '../../../../packages/contracts/vessel-tracks';

interface ArtifactInput {
  id: string;
  stepId: string;
  kind: string;
  inputRevision: number;
  payload: unknown;
}
export function readSkillArtifacts(artifacts: ArtifactInput[], inputRevision: number) {
  return artifacts
    .filter((artifact) => artifact.inputRevision === inputRevision)
    .map((artifact) => {
      const schema =
        artifact.kind === 'ais_heatmap'
          ? AgentHeatmapResultSchema
          : artifact.kind === 'vessel_tracks'
            ? AgentVesselTracksResultSchema
            : artifact.kind === 'vessel_list' || artifact.kind === 'vessel_detail'
              ? AgentQueryResultSchema
              : null;
      const parsed = schema?.safeParse(artifact.payload);
      const result =
        parsed?.success &&
        parsed.data.kind === artifact.kind &&
        parsed.data.inputRevision === inputRevision
          ? parsed.data
          : null;
      return { ...artifact, result };
    });
}
