// 검출된 선분들을 연결 그래프로 만들고, 파이프라인(폴리라인) 추적에 쓰는 함수들.
// node 에서 직접 실행해 테스트할 수 있도록 type import 외 의존성이 없다.
import type { Line } from "./types";

export interface Pt {
  x: number;
  y: number;
}
export interface GNode {
  id: number;
  x: number;
  y: number;
  edges: number[];
}
export interface GEdge {
  id: number;
  a: number;
  b: number;
  len: number;
  lineId: string | null; // null = 끊긴 곳을 이은 가상 연결(밸브 등)
  virtual: boolean;
}
export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}
export interface GraphOpts {
  joinTol: number; // 이 거리 안의 끝점/T자 접점은 같은 노드
  bridgeGap: number; // 같은 축 위 끊김을 이어주는 최대 간격
  bridgeMinSide: number; // 이을 때 양쪽 선의 최소 길이(점선 오인 방지)
}
export const DEFAULT_GRAPH_OPTS: GraphOpts = { joinTol: 7, bridgeGap: 70, bridgeMinSide: 60 };

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
const norm = (a: Pt) => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt) => norm(sub(a, b));
export const unit = (a: Pt): Pt => {
  const n = norm(a) || 1;
  return { x: a.x / n, y: a.y / n };
};
const COS_STRAIGHT = Math.cos((15 * Math.PI) / 180);
const SIN_CORNER = Math.sin((10 * Math.PI) / 180);
const CORNER_GAP = 45;

export function buildGraph(lines: Line[], opts: GraphOpts = DEFAULT_GRAPH_OPTS): Graph {
  const { joinTol } = opts;
  // 1) 선분별 분할점: 양 끝 + 다른 선의 끝점이 내부에 닿는 T자 접점
  const pts: { x: number; y: number }[] = [];
  const perLine: { t: number; p: number }[][] = lines.map(() => []);
  lines.forEach((l, i) => {
    perLine[i].push({ t: 0, p: pts.push({ x: l.x1, y: l.y1 }) - 1 });
    perLine[i].push({ t: 1, p: pts.push({ x: l.x2, y: l.y2 }) - 1 });
  });
  lines.forEach((li, i) => {
    const a = { x: li.x1, y: li.y1 };
    const d = sub({ x: li.x2, y: li.y2 }, a);
    const len = norm(d);
    if (len < 1) return;
    lines.forEach((lj, j) => {
      if (i === j) return;
      for (const e of [
        { x: lj.x1, y: lj.y1 },
        { x: lj.x2, y: lj.y2 },
      ]) {
        const v = sub(e, a);
        const t = dot(v, d) / (len * len);
        if (t * len <= joinTol || (1 - t) * len <= joinTol) continue;
        if (Math.abs(cross(v, d)) / len > joinTol) continue;
        perLine[i].push({ t, p: pts.push({ x: a.x + d.x * t, y: a.y + d.y * t }) - 1 });
      }
    });
  });

  // 2) 가까운 점끼리 union-find 로 묶어 노드 생성 (격자 해시)
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = (v: number) => Math.floor(v / joinTol);
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const k = `${cell(p.x)},${cell(p.y)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  pts.forEach((p, i) => {
    const cx = cell(p.x);
    const cy = cell(p.y);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j > i && dist(p, pts[j]) <= joinTol) parent[find(i)] = find(j);
        }
  });
  const rootToNode = new Map<number, number>();
  const nodes: GNode[] = [];
  const acc: { sx: number; sy: number; n: number }[] = [];
  const nodeOf = pts.map((p, i) => {
    const r = find(i);
    let id = rootToNode.get(r);
    if (id === undefined) {
      id = nodes.length;
      rootToNode.set(r, id);
      nodes.push({ id, x: 0, y: 0, edges: [] });
      acc.push({ sx: 0, sy: 0, n: 0 });
    }
    acc[id].sx += p.x;
    acc[id].sy += p.y;
    acc[id].n++;
    return id;
  });
  nodes.forEach((n, i) => {
    n.x = acc[i].sx / acc[i].n;
    n.y = acc[i].sy / acc[i].n;
  });

  // 3) 선분을 분할점 순서대로 잘라 간선 생성
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (a: number, b: number, lineId: string | null) => {
    if (a === b) return;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    const e: GEdge = { id: edges.length, a, b, len: dist(nodes[a], nodes[b]), lineId, virtual: lineId === null };
    edges.push(e);
    nodes[a].edges.push(e.id);
    nodes[b].edges.push(e.id);
  };
  lines.forEach((l, i) => {
    const sorted = perLine[i].sort((p, q) => p.t - q.t).map((s) => nodeOf[s.p]);
    for (let k = 1; k < sorted.length; k++) addEdge(sorted[k - 1], sorted[k], l.id);
  });

  // 4) 끊긴 끝점을 같은 축 방향의 가까운 노드와 가상 연결 (밸브/계기 심볼로 끊긴 배관)
  /** 끝점에서 일직선으로 이어지는 구간 전체 길이 (T자 접점 너머까지) */
  const run = (n: GNode): { len: number; far: GNode } => {
    let e = edges[n.edges[0]];
    let cur = n.id;
    let len = 0;
    const d = unit(sub(n, nodes[e.a === n.id ? e.b : e.a]));
    for (let k = 0; k < 20 && e; k++) {
      len += e.len;
      const nxt = e.a === cur ? e.b : e.a;
      cur = nxt;
      const straight = nodes[nxt].edges
        .map((id) => edges[id])
        .find((x) => x.id !== e.id && !x.virtual && dot(unit(sub(nodes[nxt], nodes[x.a === nxt ? x.b : x.a])), d) > COS_STRAIGHT);
      if (!straight) break;
      e = straight;
    }
    return { len, far: nodes[cur] };
  };
  const runLen = (n: GNode) => run(n).len;
  const dangling = nodes.filter((n) => n.edges.length === 1);
  for (const n of dangling) {
    const r = run(n);
    if (r.len < opts.bridgeMinSide) continue;
    // 짧은 토막 대신 일직선 구간 전체로 방향을 잡는다 (스캔 기울기 오차 감소)
    const d = unit(sub(n, r.far));
    let best: GNode | null = null;
    let bestAlong = opts.bridgeGap;
    for (const m of nodes) {
      if (m.id === n.id || !m.edges.length) continue;
      const v = sub(m, n);
      const along = dot(v, d);
      if (along <= joinTol || along > bestAlong) continue;
      if (Math.abs(cross(v, d)) > 4) continue;
      if (m.edges.length === 1) {
        const me = edges[m.edges[0]];
        if (runLen(m) < opts.bridgeMinSide) continue;
        const mo = nodes[me.a === m.id ? me.b : me.a];
        // 서로 마주보거나(직선 상의 밸브) 짧은 간격에서 직각으로 만나야 함(모서리의 리듀서·엘보 심볼)
        const c = dot(unit(sub(m, mo)), d);
        const facing = c <= -COS_STRAIGHT;
        const corner = Math.abs(c) <= SIN_CORNER && along <= CORNER_GAP;
        if (!facing && !corner) continue;
      }
      best = m;
      bestAlong = along;
    }
    if (best) addEdge(n.id, best.id, null);
  }
  return { nodes, edges };
}

export const otherEnd = (e: GEdge, n: number) => (e.a === n ? e.b : e.a);

export function nearestNode(g: Graph, p: Pt, tol: number): GNode | null {
  let best: GNode | null = null;
  let bd = tol;
  for (const n of g.nodes) {
    if (!n.edges.length) continue;
    const d = dist(n, p);
    if (d <= bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/** from 노드에서 edge 로 나가서, 분기 없는 구간(차수 2)을 계속 따라간 노드 좌표들 (from 제외) */
export function followChain(g: Graph, from: number, edgeId: number, max = 2000): Pt[] {
  const out: Pt[] = [];
  const visited = new Set([from]);
  let cur = from;
  let e = g.edges[edgeId];
  for (let i = 0; i < max; i++) {
    const nxt = otherEnd(e, cur);
    out.push({ x: g.nodes[nxt].x, y: g.nodes[nxt].y });
    if (visited.has(nxt)) break;
    visited.add(nxt);
    const rest = g.nodes[nxt].edges.filter((id) => id !== e.id);
    if (rest.length !== 1) break;
    cur = nxt;
    e = g.edges[rest[0]];
  }
  return out;
}

export interface Continuation {
  dir: Pt;
  chain: Pt[]; // 끝점 다음부터 이어질 점들
}

/** 폴리라인 끝점 P 에서 그래프를 따라 연장 가능한 방향들. back 은 폴리라인 안쪽 이웃 점 */
export function continuationsAt(g: Graph, P: Pt, back: Pt | null, tol: number): Continuation[] {
  const backDir = back ? unit(sub(back, P)) : null;
  const res: Continuation[] = [];
  const ok = (d: Pt) => !backDir || dot(d, backDir) < COS_STRAIGHT;
  const node = nearestNode(g, P, tol);
  if (node) {
    for (const id of node.edges) {
      const o = g.nodes[otherEnd(g.edges[id], node.id)];
      const d = unit(sub(o, P));
      if (!ok(d)) continue;
      res.push({ dir: d, chain: followChain(g, node.id, id) });
    }
    return res;
  }
  // 간선 중간에 있는 경우: 그 간선의 양쪽 방향
  for (const e of g.edges) {
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const ab = sub(B, A);
    const L = norm(ab);
    if (L < 1) continue;
    const t = dot(sub(P, A), ab) / (L * L);
    if (t <= 0 || t >= 1 || Math.abs(cross(sub(P, A), ab)) / L > tol) continue;
    for (const [end, start] of [
      [B, e.a],
      [A, e.b],
    ] as const) {
      const d = unit(sub(end, P));
      if (!ok(d)) continue;
      res.push({ dir: d, chain: followChain(g, start, e.id) });
    }
  }
  return res;
}

/** 다음 간선 선택: 차수 2면 그대로, 분기점이면 직진 방향만 */
function nextEdge(g: Graph, node: number, inDir: Pt, prevEdge: number, used: Set<number>): number | null {
  const all = g.nodes[node].edges.filter((id) => id !== prevEdge);
  const free = all.filter((id) => !used.has(id));
  if (!free.length) return null;
  if (all.length === 1) return free[0];
  let best: number | null = null;
  let bd = COS_STRAIGHT;
  for (const id of free) {
    const o = g.nodes[otherEnd(g.edges[id], node)];
    const c = dot(unit(sub(o, g.nodes[node])), inDir);
    if (c > bd) {
      bd = c;
      best = id;
    }
  }
  return best;
}

function walk(g: Graph, start: number, first: number, used: Set<number>): number[] {
  const path = [start];
  let cur = start;
  let e = first;
  for (;;) {
    used.add(e);
    const nxt = otherEnd(g.edges[e], cur);
    path.push(nxt);
    if (nxt === path[0]) break;
    const inDir = unit(sub(g.nodes[nxt], g.nodes[cur]));
    const n = nextEdge(g, nxt, inDir, e, used);
    if (n === null) break;
    cur = nxt;
    e = n;
  }
  return path;
}

/** 폴리라인 정리: 중복점/일직선 중간점 제거 */
export function simplify(pts: Pt[]): Pt[] {
  const a: Pt[] = [];
  for (const p of pts) if (!a.length || dist(a[a.length - 1], p) > 0.5) a.push(p);
  const out: Pt[] = [];
  for (const p of a) {
    while (out.length >= 2) {
      const u = sub(out[out.length - 1], out[out.length - 2]);
      const v = sub(p, out[out.length - 1]);
      if (Math.abs(cross(u, v)) / (norm(u) * norm(v)) < 0.02 && dot(u, v) > 0) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

export function polyLength(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

export function distToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSeg(p, pts[i - 1], pts[i]));
  return best;
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  const t = L2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/** 끝 구간을 그래프 노드 하나만큼 되돌린다. */
export function trimEnd(g: Graph, pts: Pt[], atStart: boolean, tol: number): Pt[] {
  const arr = atStart ? [...pts].reverse() : [...pts];
  if (arr.length < 2) return pts;
  const P = arr[arr.length - 1];
  const Q = arr[arr.length - 2];
  let best: Pt | null = null;
  let bd = Infinity;
  for (const n of g.nodes) {
    if (!n.edges.length) continue;
    if (dist(n, P) <= tol || dist(n, Q) <= tol) continue;
    if (distToSeg(n, Q, P) > tol) continue;
    const d = dist(n, P);
    if (d < bd) {
      bd = d;
      best = { x: n.x, y: n.y };
    }
  }
  if (best) arr[arr.length - 1] = best;
  else arr.pop();
  if (arr.length < 2) return pts;
  return atStart ? arr.reverse() : arr;
}

export interface TraceOpts {
  count: number;
  width: number;
  height: number;
  exclude: Pt[][]; // 이미 확정된 파이프라인 (이 위의 간선은 제외)
  skip?: Pt[][]; // 거절한 후보
}

/** 긴 선분을 씨앗으로 양방향 추적해 파이프라인 후보를 만든다. */
export function tracePipelines(g: Graph, o: TraceOpts): Pt[][] {
  const used = new Set<number>();
  const onAny = (e: GEdge, polys: Pt[][]) => {
    const m = { x: (g.nodes[e.a].x + g.nodes[e.b].x) / 2, y: (g.nodes[e.a].y + g.nodes[e.b].y) / 2 };
    return polys.some((pl) => distToPolyline(m, pl) < 4);
  };
  for (const e of g.edges) if (onAny(e, o.exclude)) used.add(e.id);

  const margin = 0.04 * Math.min(o.width, o.height);
  const nearBorder = (p: Pt) => p.x < margin || p.y < margin || p.x > o.width - margin || p.y > o.height - margin;

  const found: { pts: Pt[]; score: number }[] = [];
  const seeds = g.edges.filter((e) => !e.virtual).sort((a, b) => b.len - a.len);
  for (const s of seeds) {
    if (used.has(s.id)) continue;
    if (found.length >= o.count * 6) break;
    const local = new Set(used);
    const fwd = walk(g, s.a, s.id, local);
    const back = nextEdge(g, s.a, unit(sub(g.nodes[s.a], g.nodes[s.b])), s.id, local);
    const bwd = back === null ? [s.a] : walk(g, s.a, back, local);
    const nodeIds = [...bwd.reverse(), ...fwd.slice(1)];
    for (const id of local) used.add(id);

    if (nodeIds[0] === nodeIds[nodeIds.length - 1]) continue; // 닫힌 도형(장비 외곽/도면 틀)
    const raw = nodeIds.map((id) => ({ x: g.nodes[id].x, y: g.nodes[id].y }));
    const pts = simplify(raw);
    if (pts.every(nearBorder)) continue;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    if (bw > o.width * 0.8 && bh > o.height * 0.8) continue; // 도면 테두리
    if (dist(pts[0], pts[pts.length - 1]) < margin * 0.5 && pts.length > 3) continue; // 거의 닫힘
    if (o.skip?.some((sk) => pts.every((p) => distToPolyline(p, sk) < 6))) continue;
    let real = 0;
    let bridges = 0;
    for (let i = 1; i < nodeIds.length; i++) {
      const eid = g.nodes[nodeIds[i]].edges.find((id) => otherEnd(g.edges[id], nodeIds[i]) === nodeIds[i - 1]);
      const e = eid === undefined ? null : g.edges[eid];
      if (e?.virtual) bridges++;
      else real += e?.len ?? 0;
    }
    const turns = pts.length - 2;
    if (turns + bridges < 1) continue; // 꺾임도 밸브도 없는 직선 → 표 칸선일 가능성
    found.push({ pts, score: real * (1 + 0.3 * Math.min(turns, 5)) });
  }
  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, o.count)
    .map((f) => f.pts);
}
