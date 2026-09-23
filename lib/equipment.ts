// 파이프라인 ↔ 장비 연결 판정 (장비 외곽을 통과/접촉하는 지점 → 가장 가까운 노즐)
import type { Pt } from "./graph";
import type { Equipment, Pipeline } from "./types";

export interface EquipConnection {
  equipment: Equipment;
  nozzles: string[]; // 연결된 노즐 이름 (없으면 외곽 접촉)
  points: Pt[]; // 접촉 지점
  relation: "nozzle" | "edge";
}

export interface EquipOpts {
  edgeTol: number; // 끝점이 외곽에서 이 거리 안이면 연결
  nozzleTol: number; // 접촉 지점-노즐 거리
}
export const DEFAULT_EQUIP_OPTS: EquipOpts = { edgeTol: 25, nozzleTol: 30 };

const inside = (p: Pt, e: Equipment, m = 0) => p.x >= e.x - m && p.x <= e.x + e.w + m && p.y >= e.y - m && p.y <= e.y + e.h + m;

/** 선분이 사각형 네 변과 만나는 점들 */
function crossings(a: Pt, b: Pt, e: Equipment): Pt[] {
  const out: Pt[] = [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const tryT = (t: number) => {
    if (t < 0 || t > 1) return;
    const p = { x: a.x + dx * t, y: a.y + dy * t };
    if (inside(p, e, 0.5)) out.push(p);
  };
  if (dx) {
    tryT((e.x - a.x) / dx);
    tryT((e.x + e.w - a.x) / dx);
  }
  if (dy) {
    tryT((e.y - a.y) / dy);
    tryT((e.y + e.h - a.y) / dy);
  }
  return out;
}

export function pipelineEquipment(pipe: Pipeline, equipment: Equipment[], o: EquipOpts = DEFAULT_EQUIP_OPTS): EquipConnection[] {
  const pts = pipe.points;
  if (pts.length < 2) return [];
  const res: EquipConnection[] = [];
  for (const e of equipment) {
    const contacts: Pt[] = [];
    for (let i = 1; i < pts.length; i++) contacts.push(...crossings(pts[i - 1], pts[i], e));
    // 외곽 바로 바깥에서 끝나는 경우 (노즐 플랜지 앞에서 끊긴 선)
    for (const end of [pts[0], pts[pts.length - 1]]) {
      if (!inside(end, e) && inside(end, e, o.edgeTol)) contacts.push(end);
    }
    if (!contacts.length) continue;
    const nozzles = new Set<string>();
    for (const c of contacts) {
      let best: string | null = null;
      let bd = o.nozzleTol;
      for (const n of e.nozzles) {
        const d = Math.hypot(n.x - c.x, n.y - c.y);
        if (d < bd) {
          bd = d;
          best = n.name;
        }
      }
      if (best) nozzles.add(best);
    }
    res.push({ equipment: e, nozzles: [...nozzles], points: contacts, relation: nozzles.size ? "nozzle" : "edge" });
  }
  return res;
}
