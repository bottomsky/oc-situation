import { describe, it, expect } from 'vitest';
import { planGraphRoute, routeDistance, RoutePlanningError } from './route-planning';

describe('route graph planning', () => {
  const nodes = [
    { id: 'a', coordinate: [0, 0] as [number, number] },
    { id: 'b', coordinate: [1, 1] as [number, number] },
    { id: 'c', coordinate: [2, 0] as [number, number] },
  ];
  const edges = [
    {
      from: 'a',
      to: 'b',
      coordinates: [
        [0, 0],
        [1, 1],
      ] as [number, number][],
    },
    {
      from: 'b',
      to: 'c',
      coordinates: [
        [1, 1],
        [2, 0],
      ] as [number, number][],
    },
  ];
  it('retains edge geometry and includes endpoint connectors in total length', () => {
    const result = planGraphRoute({
      nodes,
      edges,
      start: [[-0.1, 0], ['a']],
      end: [[2.1, 0], ['c']],
    });
    expect(result.coordinates).toEqual([
      [-0.1, 0],
      [0, 0],
      [1, 1],
      [2, 0],
      [2.1, 0],
    ]);
    expect(result.lengthMeters).toBeCloseTo(routeDistance(result.coordinates), 4);
  });
  it('finds the shortest route (Dijkstra reference on a competing graph)', () => {
    const detour = {
      from: 'a',
      to: 'c',
      coordinates: [
        [0, 0],
        [0, 4],
        [2, 0],
      ] as [number, number][],
    };
    const result = planGraphRoute({
      nodes,
      edges: [...edges, detour],
      start: [[0, 0], ['a']],
      end: [[2, 0], ['c']],
    });
    expect(result.coordinates).toContainEqual([1, 1]);
    expect(result.lengthMeters).toBeCloseTo(
      routeDistance([
        [0, 0],
        [1, 1],
        [2, 0],
      ]),
      4,
    );
  });
  it('reports disconnected graphs and missing visible connectors', () => {
    expect(() =>
      planGraphRoute({ nodes, edges: [], start: [[0, 0], ['a']], end: [[2, 0], ['c']] }),
    ).toThrowError('no_path');
    expect(() =>
      planGraphRoute({ nodes, edges, start: [[0, 0], []], end: [[2, 0], ['c']] }),
    ).toThrowError('no_connector');
  });
  it('treats the date line as a short geodesic and blocks closed channels', () => {
    expect(
      routeDistance([
        [179, 0],
        [-179, 0],
      ]),
    ).toBeLessThan(223000);
    expect(() =>
      planGraphRoute({
        nodes,
        edges: edges.map((e) => ({ ...e, channel: 'canal' })),
        start: [[0, 0], ['a']],
        end: [[2, 0], ['c']],
      }),
    ).toThrow(RoutePlanningError);
  });
});

// Independent O(V²) Dijkstra with an independent central-angle distance implementation.
it('matches independent Dijkstra on 60 curved multi-connector graphs including date line/high latitude', () => {
  type Point = [number, number];
  const metres = (a: Point, b: Point) => {
    const r = Math.PI / 180,
      d = (b[0] - a[0]) * r;
    const x = Math.cos(b[1] * r) * Math.sin(d);
    const y =
      Math.cos(a[1] * r) * Math.sin(b[1] * r) -
      Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos(d);
    const z =
      Math.sin(a[1] * r) * Math.sin(b[1] * r) +
      Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.cos(d);
    return 6371008.8 * Math.atan2(Math.hypot(x, y), z);
  };
  let seed = 7234;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let trial = 0; trial < 60; trial++) {
    const lat = trial % 2 ? 78 : -20;
    const point = (i: number): Point => [((179 + i * 0.22 + 180) % 360) - 180, lat + rand() * 0.4];
    const nodes = Array.from({ length: 18 }, (_, i) => ({ id: String(i), coordinate: point(i) }));
    const edges: { from: string; to: string; coordinates: Point[] }[] = [];
    for (let i = 0; i < 18; i++)
      for (let j = i + 1; j < 18; j++)
        if (j === i + 1 || rand() < 0.16) {
          const a = nodes[i]!.coordinate,
            b = nodes[j]!.coordinate;
          // Curve toward the pole with longitude chosen from a node to stay normalized.
          edges.push({
            from: String(i),
            to: String(j),
            coordinates: [a, [a[0], lat + 1 + rand()], b],
          });
        }
    const start: Point = point(-1),
      end: Point = point(19);
    const matrix = Array.from({ length: 20 }, () => Array<number>(20).fill(Infinity));
    for (const e of edges) {
      const cost = e.coordinates.slice(1).reduce((s, p, i) => s + metres(e.coordinates[i]!, p), 0);
      matrix[+e.from]![+e.to] = cost;
      matrix[+e.to]![+e.from] = cost;
    }
    for (const i of [0, 1, 2]) matrix[18]![i] = metres(start, nodes[i]!.coordinate);
    for (const i of [15, 16, 17]) matrix[i]![19] = metres(nodes[i]!.coordinate, end);
    const distances = Array<number>(20).fill(Infinity),
      visited = new Set<number>();
    distances[18] = 0;
    for (let step = 0; step < 20; step++) {
      let u = -1;
      for (let i = 0; i < 20; i++)
        if (!visited.has(i) && (u < 0 || distances[i]! < distances[u]!)) u = i;
      visited.add(u);
      for (let v = 0; v < 20; v++)
        distances[v] = Math.min(distances[v]!, distances[u]! + matrix[u]![v]!);
    }
    const result = planGraphRoute({
      nodes,
      edges,
      start: [start, ['0', '1', '2']],
      end: [end, ['15', '16', '17']],
    });
    expect(result.lengthMeters).toBeCloseTo(distances[19]!, 5);
    expect(result.coordinates.length).toBeGreaterThan(3);
  }
});
