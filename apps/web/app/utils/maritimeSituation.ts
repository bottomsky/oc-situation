export type SituationAgeUnit = 'minutes' | 'hours' | 'days';

export const situationAgePresets = [
  { minutes: 15, label: '15分钟' },
  { minutes: 30, label: '30分钟' },
  { minutes: 60, label: '1小时' },
  { minutes: 180, label: '3小时' },
  { minutes: 360, label: '6小时' },
  { minutes: 720, label: '12小时' },
  { minutes: 1440, label: '24小时' },
  { minutes: 4320, label: '3天' },
  { minutes: 10080, label: '7天' },
  { minutes: 43200, label: '30天' },
] as const;

const factors: Record<SituationAgeUnit, number> = { minutes: 1, hours: 60, days: 1440 };

export function situationAgeMinutes(value: number, unit: SituationAgeUnit): number | null {
  const minutes = value * factors[unit];
  const rounded = Math.round(minutes);
  return Number.isFinite(minutes) &&
    rounded >= 1 &&
    rounded <= 43200 &&
    Math.abs(minutes - rounded) < 1e-7
    ? rounded
    : null;
}

export function situationAgeDraft(hours: number): { value: number; unit: SituationAgeUnit } {
  const minutes = situationAgeMinutes(hours, 'hours') ?? 1440;
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

export function situationAgeLabel(hours: number): string {
  const minutes = situationAgeMinutes(hours, 'hours');
  if (minutes === null) return '—';
  const days = Math.floor(minutes / 1440),
    remainderHours = Math.floor((minutes % 1440) / 60),
    remainderMinutes = minutes % 60;
  return `${days ? `${days}天` : ''}${remainderHours ? `${remainderHours}小时` : ''}${remainderMinutes ? `${remainderMinutes}分钟` : ''}`;
}
