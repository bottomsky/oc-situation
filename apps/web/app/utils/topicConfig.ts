import { isPredictionDefinition } from '@ais/contracts';
export function topicTargetConfig(
  definitionId: string,
  mmsi: string,
  fixedMmsi?: string,
): { mmsi?: string } {
  if (!isPredictionDefinition(definitionId)) return {};
  const value = mmsi.trim();
  if (!/^[1-9]\d{8}$/.test(value)) throw new Error('请输入9位有效目标MMSI');
  if (fixedMmsi !== undefined && value !== fixedMmsi)
    throw new Error('预测专题目标MMSI已固定，切换目标需新建专题');
  return { mmsi: value };
}
