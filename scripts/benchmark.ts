export function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}
export function makeSyntheticPositions(
  run: string,
  start: number,
  count: number,
  ships: number,
  observedAt: string,
) {
  return Array.from({ length: count }, (_, index) => {
    const n = (start + index) % ships;
    return {
      id: `${run}:${start + index}`,
      mmsi: String(500000000 + n),
      observedAt,
      lat: -60 + (n % 12000) / 100,
      lon: -179 + (n % 35800) / 100,
      sogKnots: 10.5,
      cogDegrees: 180,
      headingDegrees: 180,
    };
  });
}
export function benchmarkPhases(full: boolean) {
  return full
    ? [
        { name: 'steady', seconds: 3600, rate: 1000 },
        { name: 'peak', seconds: 300, rate: 3000 },
        { name: 'recovery', seconds: 600, rate: 1000 },
      ]
    : [
        { name: 'steady', seconds: 15, rate: 100 },
        { name: 'peak', seconds: 5, rate: 300 },
        { name: 'recovery', seconds: 10, rate: 100 },
      ];
}
