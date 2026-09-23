// 파이프라인 ↔ 심볼(밸브/피팅/계기) 포함 관계 판정
import type { Graph, Pt } from "./graph";
import type { PidSymbol, Pipeline } from "./types";

export type Relation = "inline" | "branch" | "manual";
export interface Membership {
  symbol: PidSymbol;
  relation: Relation;
}
export interface PipeMembers {
  members: Membership[];
  excluded: PidSymbol[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/** 선분-사각형 교차 (Liang–Barsky) */
export function segHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
const distToPoly = (p: Pt, pts: Pt[]) => {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSeg(p, pts[i - 1], pts[i]));
  return d;
};

/** 선분과 사각형 사이 최소 거리 (교차하면 0) */
export function segRectDist(a: Pt, b: Pt, r: Rect): number {
  if (segHitsRect(a, b, r)) return 0;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x, y: r.y + r.h },
    { x: r.x + r.w, y: r.y + r.h },
  ];
  const ptRect = (p: Pt) => Math.hypot(Math.max(r.x - p.x, 0, p.x - r.x - r.w), Math.max(r.y - p.y, 0, p.y - r.y - r.h));
  return Math.min(ptRect(a), ptRect(b), ...corners.map((c) => distToSeg(c, a, b)));
}

export interface MemberOpts {
  margin: number; // 박스 여유(px)
  branchLenInstrument: number; // 분기선을 따라 계기까지 허용 거리(px)
  branchLenValve: number; // 분기선을 따라 밸브/피팅까지 허용 거리(px) — 드레인·벤트 밸브 정도
  nearInstrument: number; // 연결선이 검출되지 않아도 이 거리 안의 계기는 분기로 본다
  nearValve: number; // 같은 기준, 밸브/피팅
  tol: number; // 노드가 파이프라인 위에 있다고 볼 거리
}
export const DEFAULT_MEMBER_OPTS: MemberOpts = {
  margin: 3,
  branchLenInstrument: 150,
  branchLenValve: 60,
  nearInstrument: 32,
  nearValve: 18,
  tol: 5,
};

/**
 * inline: 파이프라인이 심볼 박스를 관통 (밸브, 리듀서 등)
 * branch: 파이프라인에서 갈라지는 검출선을 따라가면 닿는 심볼 (계기 탭, 드레인 밸브 등)
 */
export function pipelineMembers(g: Graph, pipe: Pipeline, symbols: PidSymbol[], o: MemberOpts = DEFAULT_MEMBER_OPTS): PipeMembers {
  const pts = pipe.points;
  const exclude = new Set(pipe.exclude ?? []);
  const include = new Set(pipe.include ?? []);
  const rel = new Map<string, Relation>();

  for (const s of symbols) {
    const r = grow(s, o.margin);
    for (let i = 1; i < pts.length; i++) {
      if (segHitsRect(pts[i - 1], pts[i], r)) {
        rel.set(s.id, "inline");
        break;
      }
    }
  }

  // 파이프라인 위의 노드에서 출발해, 파이프라인에 속하지 않은 간선을 따라 BFS
  const onPipe = (p: Pt) => distToPoly(p, pts) <= o.tol;
  const best = new Map<number, number>(); // node → 누적 거리
  const queue: number[] = [];
  for (const n of g.nodes) {
    if (n.edges.length && onPipe(n)) {
      best.set(n.id, 0);
      queue.push(n.id);
    }
  }
  // 파이프라인 바로 옆 심볼 (짧은 연결선은 검출되지 않으므로 거리로 판정)
  for (const s of symbols) {
    if (rel.has(s.id)) continue;
    const near = s.category === "instrument" ? o.nearInstrument : o.nearValve;
    for (let i = 1; i < pts.length; i++) {
      if (segRectDist(pts[i - 1], pts[i], s) <= near) {
        rel.set(s.id, "branch");
        break;
      }
    }
  }

  const rest = symbols.filter((s) => !rel.has(s.id));
  const maxLen = Math.max(o.branchLenInstrument, o.branchLenValve);
  while (queue.length) {
    const cur = queue.shift()!;
    const d0 = best.get(cur)!;
    for (const eid of g.nodes[cur].edges) {
      const e = g.edges[eid];
      const nxt = e.a === cur ? e.b : e.a;
      const A = g.nodes[cur];
      const B = g.nodes[nxt];
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      if (onPipe(mid)) continue; // 파이프라인 자체 구간
      const d = d0 + e.len;
      let hit = false;
      for (const s of rest) {
        if (rel.has(s.id)) continue;
        const r = grow(s, o.margin);
        if (!segHitsRect(A, B, r)) continue;
        // 분기 시작점부터 심볼까지 거리 (간선 위 근사)
        const reach = d0 + Math.min(e.len, Math.hypot(s.x + s.w / 2 - A.x, s.y + s.h / 2 - A.y));
        const lim = s.category === "instrument" ? o.branchLenInstrument : o.branchLenValve;
        if (reach <= lim) {
          rel.set(s.id, "branch");
          hit = true;
        }
      }
      if (hit || d > maxLen) continue; // 심볼에 닿거나 한도를 넘으면 그 너머는 탐색하지 않음
      if ((best.get(nxt) ?? Infinity) > d) {
        best.set(nxt, d);
        queue.push(nxt);
      }
    }
  }

  const members: Membership[] = [];
  const excluded: PidSymbol[] = [];
  for (const s of symbols) {
    const r = rel.get(s.id);
    if (exclude.has(s.id)) {
      if (r) excluded.push(s);
      else if (include.has(s.id)) excluded.push(s);
      continue;
    }
    if (r) members.push({ symbol: s, relation: r });
    else if (include.has(s.id)) members.push({ symbol: s, relation: "manual" });
  }
  // 파이프라인 진행 방향 순으로 정렬
  const along = (s: PidSymbol) => {
    const c = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    let acc = 0;
    let bestD = Infinity;
    let bestT = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const d = distToSeg(c, a, b);
      if (d < bestD) {
        bestD = d;
        const t = L ? Math.max(0, Math.min(1, ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / (L * L))) : 0;
        bestT = acc + t * L;
      }
      acc += L;
    }
    return bestT;
  };
  members.sort((a, b) => along(a.symbol) - along(b.symbol));
  return { members, excluded };
}

export const isInstrument = (s: PidSymbol) => s.category === "instrument";

export interface Ownership {
  pipeId: string;
  relation: Relation;
}

/**
 * 심볼 하나는 파이프라인 하나에만 귀속된다.
 * 우선순위: 수동 포함 > 라인상 > 분기, 같으면 확정 > 후보, 그래도 같으면 목록 순서.
 */
export function resolveOwners(pipelines: Pipeline[], membersOf: Map<string, PipeMembers>): Map<string, Ownership> {
  const rank: Record<Relation, number> = { manual: 3, inline: 2, branch: 1 };
  const best = new Map<string, { own: Ownership; score: number }>();
  pipelines.forEach((p, order) => {
    if (!p.visible) return;
    for (const m of membersOf.get(p.id)?.members ?? []) {
      const score = rank[m.relation] * 1e6 + (p.status === "confirmed" ? 1e5 : 0) - order;
      const cur = best.get(m.symbol.id);
      if (!cur || score > cur.score) best.set(m.symbol.id, { own: { pipeId: p.id, relation: m.relation }, score });
    }
  });
  return new Map([...best].map(([k, v]) => [k, v.own]));
}

export const CATEGORY_LABEL: Record<PidSymbol["category"], string> = {
  valve: "밸브",
  fitting: "피팅",
  instrument: "계기",
  other: "기타",
};
