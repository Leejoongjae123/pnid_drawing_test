import type { Line } from "./types";

export interface Pt {
  x: number;
  y: number;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export const lineLength = (l: Line) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);

/** 점 p 를 선분 l 에 투영한 점과 매개변수 t(0~1) */
export function project(p: Pt, l: Line): { pt: Pt; t: number } {
  const dx = l.x2 - l.x1;
  const dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len2));
  return { pt: { x: l.x1 + t * dx, y: l.y1 + t * dy }, t };
}

/** anchor 기준으로 수평/수직 중 가까운 쪽으로 고정 */
export function ortho(anchor: Pt, p: Pt): Pt {
  return Math.abs(p.x - anchor.x) >= Math.abs(p.y - anchor.y) ? { x: p.x, y: anchor.y } : { x: anchor.x, y: p.y };
}

/** 다른 선의 끝점 → 선분 위 순서로 가장 가까운 스냅 지점을 찾는다. */
export function snap(p: Pt, lines: Line[], exclude: Set<string>, radius: number): { pt: Pt; kind: "end" | "on" } | null {
  let best: Pt | null = null;
  let bestD = radius;
  for (const l of lines) {
    if (exclude.has(l.id)) continue;
    for (const e of [
      { x: l.x1, y: l.y1 },
      { x: l.x2, y: l.y2 },
    ]) {
      const d = dist(p, e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  if (best) return { pt: best, kind: "end" };
  bestD = radius;
  for (const l of lines) {
    if (exclude.has(l.id)) continue;
    const { pt } = project(p, l);
    const d = dist(p, pt);
    if (d < bestD) {
      bestD = d;
      best = pt;
    }
  }
  return best ? { pt: best, kind: "on" } : null;
}

/** 선분이 사각형과 교차하거나 안에 있는지 (박스 선택용, 근사) */
export function lineInRect(l: Line, r: { x: number; y: number; w: number; h: number }): boolean {
  const inside = (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  if (inside(l.x1, l.y1) || inside(l.x2, l.y2)) return true;
  const n = Math.max(2, Math.ceil(lineLength(l) / 10));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (inside(l.x1 + (l.x2 - l.x1) * t, l.y1 + (l.y2 - l.y1) * t)) return true;
  }
  return false;
}

/** 기울어진 선을 수평/수직으로 곧게 편다(중심 기준). */
export function straighten(l: Line): Line {
  const dx = Math.abs(l.x2 - l.x1);
  const dy = Math.abs(l.y2 - l.y1);
  if (dx >= dy) {
    const y = (l.y1 + l.y2) / 2;
    return { ...l, y1: y, y2: y };
  }
  const x = (l.x1 + l.x2) / 2;
  return { ...l, x1: x, x2: x };
}

export const round1 = (v: number) => Math.round(v * 10) / 10;

let counter = 0;
export const newId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;
