// 라인 번호 파싱과 파이프라인 귀속, 파이프라인별 유체(chemical) 정보 정리
import type { Pt } from "./graph";
import type { LineLabel, Pipeline } from "./types";

export interface ParsedLineNumber {
  fluidCode: string; // P, CHL, NG …
  fluidName: string;
  unit: string; // 232
  sequence: string; // 02203
  spec: string; // 배관 재질 등급 (3R1BD, CSL1D …)
  size: string; // 20"
  insulation: string; // IC, N …
  insulationName: string;
}

/** 유체 코드 → 이름 (도면 범례 기준 일반적인 약어. 필요 시 추가) */
export const FLUID_CODES: Record<string, string> = {
  P: "Process",
  CHL: "Chemical (liquid)",
  CHG: "Chemical (gas)",
  NG: "Nitrogen gas",
  IA: "Instrument air",
  PA: "Plant air",
  CW: "Cooling water",
  FG: "Fuel gas",
  FL: "Flare",
  DR: "Drain",
  ST: "Steam",
  BD: "Blowdown",
};

export const INSULATION_CODES: Record<string, string> = {
  N: "No insulation",
  IC: "Cold insulation",
  IH: "Hot insulation",
  IP: "Personnel protection",
  ET: "Electric tracing",
  ST: "Steam tracing",
};

// 알파벳-숫자3-숫자5-등급-사이즈-보온 (끝 '-' 은 선택)
const LINE_NO = /^([A-Z]{1,4})-(\d{3})-(\d{5})-([A-Z0-9]+)-([\d\s/.]+"?)-([A-Z]{1,3})-?$/;

export function parseLineNumber(text: string): ParsedLineNumber | null {
  const m = LINE_NO.exec(text.trim().replace(/[”″]/g, '"'));
  if (!m) return null;
  const [, fluidCode, unit, sequence, spec, size, insulation] = m;
  return {
    fluidCode,
    fluidName: FLUID_CODES[fluidCode] ?? fluidCode,
    unit,
    sequence,
    spec,
    size: size.trim(),
    insulation,
    insulationName: INSULATION_CODES[insulation] ?? insulation,
  };
}

/** 텍스트 안에서 라인 번호 패턴만 찾아낸다 (LLM/OCR 결과 정리용) */
export const LINE_NO_SEARCH = /[A-Z]{1,4}-\d{3}-\d{5}-[A-Z0-9]+-[\d\s/.]+"?-[A-Z]{1,3}-?/g;

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

export interface LabelOpts {
  anchorTol: number; // anchor 가 파이프라인에서 이 거리 안
  boxTol: number; // anchor 가 없을 때 라벨 중심-파이프라인 거리
  endTol: number; // service: 파이프라인 끝점과 커넥터 anchor 거리
}
export const DEFAULT_LABEL_OPTS: LabelOpts = { anchorTol: 10, boxTol: 22, endTol: 60 };

/**
 * 라벨 → 파이프라인 (가장 가까운 한 개).
 * line_number: anchor(지시선 끝)가 폴리라인 위, 없으면 라벨 중심이 폴리라인 가까이
 * service: 커넥터 anchor 가 폴리라인 위이거나 파이프라인 끝점 근처
 */
export function assignLabels(pipelines: Pipeline[], labels: LineLabel[], o: LabelOpts = DEFAULT_LABEL_OPTS): Map<string, string> {
  const res = new Map<string, string>();
  for (const l of labels) {
    const c = l.anchor ?? { x: l.x + l.w / 2, y: l.y + l.h / 2 };
    const tol = l.anchor ? o.anchorTol : o.boxTol;
    let best: string | null = null;
    let bd = Infinity;
    for (const p of pipelines) {
      if (!p.visible || p.points.length < 2) continue;
      let d = distToPoly(c, p.points);
      if (d > tol && l.kind === "service") {
        const e = Math.min(Math.hypot(p.points[0].x - c.x, p.points[0].y - c.y), Math.hypot(p.points.at(-1)!.x - c.x, p.points.at(-1)!.y - c.y));
        d = e <= o.endTol ? e : Infinity;
      } else if (d > tol) d = Infinity;
      if (d < bd || (d === bd && p.status === "confirmed")) {
        bd = d;
        best = p.id;
      }
    }
    if (best) res.set(l.id, best);
  }
  return res;
}

export interface ChemicalInfo {
  service: string | null; // 커넥터에서 읽은 유체/서비스명 (ETHANE PRODUCT …)
  fluidCodes: string[];
  fluidNames: string[];
  sizes: string[];
  specs: string[];
  insulations: string[];
  connectors: { service: string; ref?: string; fromTo?: string }[];
  lineNumbers: (ParsedLineNumber & { text: string; labelId: string })[];
  unparsed: string[];
}

export function chemicalInfo(labels: LineLabel[]): ChemicalInfo {
  const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];
  const lineNumbers: ChemicalInfo["lineNumbers"] = [];
  const unparsed: string[] = [];
  for (const l of labels.filter((x) => x.kind === "line_number")) {
    const p = parseLineNumber(l.text);
    if (p) lineNumbers.push({ ...p, text: l.text, labelId: l.id });
    else unparsed.push(l.text);
  }
  const connectors = labels.filter((x) => x.kind === "service").map((x) => ({ service: x.text, ref: x.ref, fromTo: x.fromTo }));
  return {
    service: connectors[0]?.service ?? null,
    fluidCodes: uniq(lineNumbers.map((x) => x.fluidCode)),
    fluidNames: uniq(lineNumbers.map((x) => x.fluidName)),
    sizes: uniq(lineNumbers.map((x) => x.size)),
    specs: uniq(lineNumbers.map((x) => x.spec)),
    insulations: uniq(lineNumbers.map((x) => x.insulation)),
    connectors,
    lineNumbers,
    unparsed,
  };
}
