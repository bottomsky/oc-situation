import type { RouteCoordinate } from '../contracts/routes';

export class RoutePlanningError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export function routeDistance(coordinates: RouteCoordinate[]): number {
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]!,
      b = coordinates[i]!;
    const dlat = (b[1] - a[1]) * rad,
      dlon = (b[0] - a[0]) * rad;
    const h =
      Math.sin(dlat / 2) ** 2 +
      Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
    total += 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }
  return total;
}
export interface RouteGraphNode {
  id: string;
  coordinate: RouteCoordinate;
}
export interface RouteGraphEdge {
  from: string;
  to: string;
  coordinates: RouteCoordinate[];
  channel?: string;
}
export interface RouteGraphInput {
  direct?: boolean;
  nodes: RouteGraphNode[];
  edges: RouteGraphEdge[];
  start: [RouteCoordinate, string[]];
  end: [RouteCoordinate, string[]];
}
export class RouteMinHeap {
  private entries: { id: string; priority: number }[] = [];
  push(entry: { id: string; priority: number }) {
    this.entries.push(entry);
    let i = this.entries.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.entries[p]!.priority <= entry.priority) break;
      this.entries[i] = this.entries[p]!;
      i = p;
    }
    this.entries[i] = entry;
  }
  pop() {
    const root = this.entries[0];
    const tail = this.entries.pop();
    if (this.entries.length && tail) {
      let i = 0;
      while (i * 2 + 1 < this.entries.length) {
        let j = i * 2 + 1;
        if (
          j + 1 < this.entries.length &&
          this.entries[j + 1]!.priority < this.entries[j]!.priority
        )
          j++;
        if (this.entries[j]!.priority >= tail.priority) break;
        this.entries[i] = this.entries[j]!;
        i = j;
      }
      this.entries[i] = tail;
    }
    return root;
  }
}
/** A* over verified navigable edges. Connector visibility is established by PostGIS before dispatch. */
export function planGraphRoute(input: RouteGraphInput): {
  coordinates: RouteCoordinate[];
  lengthMeters: number;
} {
  if (!input.start[1].length || !input.end[1].length) throw new RoutePlanningError('no_connector');
  const nodes = new Map(input.nodes.map((n) => [n.id, n.coordinate]));
  const startId = '__start',
    endId = '__end';
  nodes.set(startId, input.start[0]);
  nodes.set(endId, input.end[0]);
  const adjacency = new Map<
    string,
    { to: string; coordinates: RouteCoordinate[]; cost: number }[]
  >();
  const add = (from: string, to: string, coordinates: RouteCoordinate[]) => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, coordinates, cost: routeDistance(coordinates) });
    adjacency.set(from, list);
  };
  for (const edge of input.edges) {
    if (edge.channel === 'canal' || edge.channel === 'arctic') continue;
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    add(edge.from, edge.to, edge.coordinates);
    add(edge.to, edge.from, [...edge.coordinates].reverse());
  }
  for (const id of input.start[1])
    if (nodes.has(id)) add(startId, id, [input.start[0], nodes.get(id)!]);
  if (input.direct) add(startId, endId, [input.start[0], input.end[0]]);
  for (const id of input.end[1]) if (nodes.has(id)) add(id, endId, [nodes.get(id)!, input.end[0]]);
  const distance = new Map<string, number>([[startId, 0]]),
    previous = new Map<string, { from: string; coordinates: RouteCoordinate[] }>();
  const heap = new RouteMinHeap();
  heap.push({ id: startId, priority: 0 });
  while (true) {
    const entry = heap.pop();
    if (!entry) break;
    const best = distance.get(entry.id)!;
    if (entry.priority > best + routeDistance([nodes.get(entry.id)!, input.end[0]]) + 0.01)
      continue;
    if (entry.id === endId) {
      const segments: RouteCoordinate[][] = [];
      let id = endId;
      while (id !== startId) {
        const step = previous.get(id)!;
        segments.push(step.coordinates);
        id = step.from;
      }
      const coordinates: RouteCoordinate[] = [];
      for (const segment of segments.reverse())
        for (const point of segment)
          if (
            !coordinates.length ||
            point[0] !== coordinates.at(-1)![0] ||
            point[1] !== coordinates.at(-1)![1]
          )
            coordinates.push(point);
      if (coordinates.length < 2) coordinates.push(input.end[0]);
      return { coordinates, lengthMeters: routeDistance(coordinates) };
    }
    for (const edge of adjacency.get(entry.id) ?? []) {
      const score = best + edge.cost;
      if (score >= (distance.get(edge.to) ?? Infinity)) continue;
      distance.set(edge.to, score);
      previous.set(edge.to, { from: entry.id, coordinates: edge.coordinates });
      heap.push({
        id: edge.to,
        priority: score + routeDistance([nodes.get(edge.to)!, input.end[0]]),
      });
    }
  }
  throw new RoutePlanningError('no_path');
}
