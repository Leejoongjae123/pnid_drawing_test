// HAZOP Step 2.2 (Process interpretation & review) 기준으로 파이프라인의 하위 요소를 분류한다.
// B Components (Equipment · Lines · Valves · Fittings · Loops · Interlocks · Relief)
// C Connectivity (From → To · 오프페이지 커넥터 · 분기) · D Chemicals · E Conditions · F Review
import type { Pt } from "./graph";
import type { EquipConnection } from "./equipment";
import type { ChemicalInfo } from "./labels";
import type { Membership } from "./symbols";
import type { Equipment, LineLabel, PidSymbol, Pipeline } from "./types";
import { candidateChemicals, CHEMICALS } from "./chemicals";

export type ReviewStatus = "Confirmed" | "Confirm" | "Review" | "Ask user" | "Gap";
export interface ReviewEntry {
  status: "Confirmed" | "Ask user";
  at: string;
}
export type Reviews = Record<string, ReviewEntry>;

export interface DrawingInfo {
  no?: string;
  title?: string;
  unit?: string;
  register?: { file: string; dwg_no: string; title: string }[];
}

export type Target = { kind: "sym" | "label" | "equip"; id: string };
export interface Field {
  label: string;
  value: string;
  src?: string;
}
export interface Rec {
  key: string;
  kind: string; // 레코드 종류 (Equipment, Line, Valve …)
  a: string; // 대표 (태그/번호)
  b?: string;
  b2?: string;
  c?: string;
  c2?: string;
  conf: number;
  status: ReviewStatus;
  fields: Field[];
  target?: Target;
  box?: { x: number; y: number; w: number; h: number };
  excludable?: string; // 파이프라인에서 제외 가능한 심볼 id
}

// ── 계기 태그 해석 (ISA 5.1) ─────────────────────
const VARIABLE: Record<string, string> = {
  A: "Analysis",
  F: "Flow",
  L: "Level",
  P: "Pressure",
  T: "Temperature",
  H: "Hand",
  S: "Speed",
  Z: "Position",
  W: "Weight",
  E: "Voltage",
  X: "Unclassified",
};
const FUNC: Record<string, string> = {
  A: "alarm",
  C: "controller",
  E: "element",
  G: "gauge",
  I: "indicator",
  R: "recorder",
  S: "switch",
  T: "transmitter",
  V: "valve",
  Y: "relay/converter",
  Z: "actuator",
  L: "light",
};

export interface ParsedTag {
  letters: string;
  number: string;
  suffix: string;
  variable: string;
  functions: string[];
}

export function parseInstrumentTag(tag: string): ParsedTag | null {
  const m = /^([A-Z]{1,5})\s*-?\s*(\d{3,5})\s*([A-Z]{0,2}\d?)$/.exec(tag.trim().toUpperCase());
  if (!m) return null;
  const [, letters, number, suffix] = m;
  let rest = letters;
  let variable: string;
  if (/^(SEL|APC)$/.test(letters)) {
    variable = "Control system";
    rest = "";
  } else if (/^(PD|TD|FQ|LD)/.test(letters)) {
    variable = { PD: "Pressure differential", TD: "Temperature differential", FQ: "Flow totalize", LD: "Level differential" }[letters.slice(0, 2)]!;
    rest = letters.slice(2);
  } else {
    variable = VARIABLE[letters[0]] ?? letters[0];
    rest = letters.slice(1);
  }
  const functions: string[] = [];
  if (/^SEL$/.test(letters)) functions.push("selector");
  else if (/^APC$/.test(letters)) functions.push("advanced process control");
  else {
    if (/VSV|SV/.test(rest)) functions.push("safety valve");
    else if (/SE/.test(rest)) functions.push("safety element");
    else if (/SD/.test(rest)) functions.push("shutdown");
    else if (/CV/.test(rest)) functions.push("control valve");
    for (const ch of rest.replace(/VSV|SV|SE|SD|CV/, "")) if (FUNC[ch]) functions.push(FUNC[ch]);
  }
  return { letters, number, suffix, variable, functions };
}

type Cls = "relief" | "interlock" | "control_valve" | "valve" | "fitting" | "instrument";

export function classifySymbol(s: PidSymbol): Cls {
  const t = parseInstrumentTag(s.tag);
  const ty = s.type.toLowerCase();
  if (/safety|relief|rupture/.test(ty) || (t && /(^|[A-Z])(SV|SE|RV)/.test(t.letters.slice(1)))) return "relief";
  if (/voting|logic|interlock|shutdown/.test(ty) || (t && (/SD/.test(t.letters) || t.letters === "HS"))) return "interlock";
  if (s.category === "valve") return /control/.test(ty) || (t && /CV$/.test(t.letters)) ? "control_valve" : "valve";
  if (s.category === "fitting") return "fitting";
  return "instrument";
}

// ── 공통 ───────────────────────────────────────
const conf2status = (c: number): ReviewStatus => (c >= 0.85 ? "Confirm" : c >= 0.6 ? "Review" : "Ask user");
const pct = (c: number) => `${Math.round(c * 100)} %`;
const REL_CONF = { inline: 0.95, branch: 0.7, manual: 1 } as const;
const REL_KO = { inline: "라인상", branch: "분기", manual: "수동" } as const;

function withReview(r: Omit<Rec, "status">, reviews: Reviews, fallback?: ReviewStatus): Rec {
  const rv = reviews[r.key];
  return { ...r, status: rv ? rv.status : (fallback ?? conf2status(r.conf)) };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const specOf = (e: Equipment, re: RegExp) => e.specs.find((x) => re.test(x.key))?.value;

// ── C: 양끝 해석 ───────────────────────────────
export interface EndPoint {
  kind: "Equipment" | "Connector" | "Open end";
  tag: string;
  detail: string;
  nozzle?: string;
  via?: string; // 커넥터 도면 번호
  resolved?: { file: string; title: string } | null;
  otherUnit?: boolean;
  dir?: "FROM" | "TO";
}

export function resolveRef(ref: string | undefined, drawing: DrawingInfo): { file: string; title: string } | null {
  if (!ref) return null;
  const hit = drawing.register?.find((d) => d.dwg_no === ref.trim());
  return hit ? { file: hit.file, title: hit.title } : null;
}

function endAt(P: Pt, eqs: EquipConnection[], connectors: LineLabel[], drawing: DrawingInfo): EndPoint {
  // 장비: 접촉 지점이 끝점 가까이
  let bestE: { c: EquipConnection; d: number; pt: Pt } | null = null;
  for (const c of eqs) {
    for (const pt of c.points) {
      const d = dist(pt, P);
      if (d < 80 && (!bestE || d < bestE.d)) bestE = { c, d, pt };
    }
  }
  if (bestE) {
    const e = bestE.c.equipment;
    let noz: string | undefined;
    let nd = 35;
    for (const n of e.nozzles) {
      const d = dist(n, bestE.pt);
      if (d < nd) {
        nd = d;
        noz = n.name;
      }
    }
    return { kind: "Equipment", tag: e.tag, detail: e.name, nozzle: noz };
  }
  // 커넥터
  let bestC: { l: LineLabel; d: number } | null = null;
  for (const l of connectors) {
    const a = l.anchor ?? { x: l.x + l.w / 2, y: l.y + l.h / 2 };
    const d = dist(a, P);
    // 커넥터(오각형)는 라인 끝 바로 너머에 그려지므로 여유를 크게 둔다
    if (d < 160 && (!bestC || d < bestC.d)) bestC = { l, d };
  }
  if (bestC) {
    const l = bestC.l;
    const ft = (l.fromTo ?? "").trim();
    const dir = /^FROM/i.test(ft) ? "FROM" : /^TO/i.test(ft) ? "TO" : undefined;
    const counterpart = ft.replace(/^(FROM|TO)\s*/i, "");
    const resolved = resolveRef(l.ref, drawing);
    const unitOf = (s?: string) => s?.split("-")[1];
    return {
      kind: "Connector",
      tag: counterpart || l.text,
      detail: l.text,
      via: l.ref,
      resolved,
      otherUnit: !!l.ref && !resolved && unitOf(l.ref) !== unitOf(drawing.no),
      dir,
    };
  }
  return { kind: "Open end", tag: "—", detail: "연결 대상 없음 (분기 또는 추적 미완)" };
}

export function pipelineEnds(p: Pipeline, eqs: EquipConnection[], connectors: LineLabel[], drawing: DrawingInfo) {
  const a = endAt(p.points[0], eqs, connectors, drawing);
  const b = endAt(p.points[p.points.length - 1], eqs, connectors, drawing);
  // 방향: 커넥터의 FROM/TO 가 있으면 그것을 따른다
  let from = a;
  let to = b;
  let directionKnown = false;
  if (a.dir === "TO" || b.dir === "FROM") {
    from = b;
    to = a;
    directionKnown = true;
  } else if (a.dir === "FROM" || b.dir === "TO") directionKnown = true;
  return { from, to, directionKnown };
}

export const endText = (e: EndPoint) =>
  e.kind === "Equipment"
    ? `${e.tag}${e.nozzle ? ` · ${e.nozzle}` : ""}`
    : e.kind === "Connector"
      ? `${e.tag}${e.via ? ` (via ${e.via})` : ""}`
      : "미연결";

// ── 전체 빌더 ──────────────────────────────────
export interface ReviewCtx {
  pipe: Pipeline;
  owned: Membership[];
  allSymbols: PidSymbol[];
  shared: { symbol: PidSymbol; ownerName: string }[];
  info: ChemicalInfo;
  labels: LineLabel[]; // 이 파이프라인에 귀속된 라벨
  eqs: EquipConnection[];
  drawing: DrawingInfo;
  reviews: Reviews;
}

export interface ServiceRow {
  key: string;
  code: string;
  legend: string;
  service: string | null;
  lineCount: number;
  candidates: string[];
  specified: string[];
  basis: string;
  conf: number;
  status: ReviewStatus;
}

export interface Check {
  id: string;
  text: string;
  ok: boolean;
  value: string;
  detail: string;
}

export function buildReview(ctx: ReviewCtx) {
  const { pipe, owned, allSymbols, info, labels, eqs, drawing, reviews } = ctx;
  const connectors = labels.filter((l) => l.kind === "service");
  const ends = pipelineEnds(pipe, eqs, connectors, drawing);
  const lineTag = info.lineNumbers[0]?.text ?? "(라인 번호 없음)";

  // ── B: Components ──
  const equipment = eqs.map((c) =>
    withReview(
      {
        key: `eq:${c.equipment.id}`,
        kind: "Equipment",
        a: c.equipment.tag,
        b: c.equipment.type,
        b2: c.nozzles.length ? `노즐 ${c.nozzles.join(", ")}` : "외곽 접촉 (노즐 미확인)",
        c: `DP ${specOf(c.equipment, /PRESSURE/) ?? "—"}`,
        c2: `DT ${specOf(c.equipment, /TEMPERATURE/) ?? "—"}`,
        conf: c.nozzles.length ? 0.9 : 0.6,
        fields: [
          { label: "Name", value: c.equipment.name },
          { label: "Class", value: c.equipment.type },
          { label: "Nozzles", value: c.nozzles.join(", ") || "—", src: "파이프라인 접촉 지점 → 가장 가까운 노즐" },
          ...c.equipment.specs.map((s) => ({ label: s.key, value: s.value, src: "도면 상단 장비 데이터 블록" })),
          { label: "Notes", value: c.equipment.notes?.join(", ") || "—" },
        ],
        target: { kind: "equip", id: c.equipment.id },
        box: c.equipment,
      },
      reviews,
    ),
  );

  const lines = info.lineNumbers.map((ln) => {
    const l = labels.find((x) => x.id === ln.labelId);
    return withReview(
      {
        key: `ln:${ln.labelId}`,
        kind: "Line",
        a: ln.text,
        b: `${endText(ends.from)} → ${endText(ends.to)}`,
        c: `${ln.fluidCode} · ${ln.fluidName}`,
        c2: `${ln.size} · ${ln.spec} · ${ln.insulation}`,
        conf: 0.9,
        fields: [
          { label: "From", value: endText(ends.from) },
          { label: "To", value: endText(ends.to) },
          { label: "Service code", value: `${ln.fluidCode} — ${ln.fluidName}`, src: "라인 번호 파싱 · 범례(일반 라이브러리)" },
          { label: "Unit · Seq", value: `${ln.unit} · ${ln.sequence}` },
          { label: "Size · class", value: `${ln.size} · ${ln.spec}` },
          { label: "Insulation", value: `${ln.insulation} (${ln.insulationName})` },
        ],
        target: { kind: "label", id: ln.labelId },
        box: l,
      },
      reviews,
    );
  });
  for (const t of info.unparsed)
    lines.push(withReview({ key: `lnx:${t}`, kind: "Line", a: t, b: "형식 불일치", conf: 0.4, fields: [{ label: "Raw text", value: t }] }, reviews));

  const symRec = (m: Membership, kind: string, extra: Partial<Rec>): Rec => {
    const s = m.symbol;
    const conf = Math.min(s.confidence ?? 0.8, REL_CONF[m.relation]);
    return withReview(
      {
        key: `sym:${s.id}`,
        kind,
        a: s.tag || `(태그 없음)`,
        conf,
        target: { kind: "sym", id: s.id },
        box: s,
        excludable: s.id,
        fields: [
          { label: "Type", value: s.type || "—" },
          { label: "Relation", value: REL_KO[m.relation], src: m.relation === "inline" ? "파이프라인이 심볼을 관통" : m.relation === "branch" ? "분기선/근접으로 연결" : "수동 지정" },
          { label: "Line", value: lineTag },
          { label: "Source", value: s.source === "llm" ? `LLM 판독 · 신뢰도 ${pct(s.confidence ?? 0.8)}` : "수동 입력" },
        ],
        ...extra,
      },
      reviews,
      !s.tag ? "Review" : undefined,
    );
  };

  const cls = new Map(owned.map((m) => [m.symbol.id, classifySymbol(m.symbol)]));
  const valves = owned
    .filter((m) => ["valve", "control_valve"].includes(cls.get(m.symbol.id)!))
    .map((m) =>
      symRec(m, cls.get(m.symbol.id) === "control_valve" ? "Control valve" : "Valve", {
        b: m.symbol.type,
        b2: `${REL_KO[m.relation]} · ${lineTag}`,
        c: "Fail — 데이터시트 필요",
        c2: parseInstrumentTag(m.symbol.tag) ? `Loop ${parseInstrumentTag(m.symbol.tag)!.number}` : m.symbol.tag || "",
      }),
    );
  const fittings = owned
    .filter((m) => cls.get(m.symbol.id) === "fitting")
    .map((m) => symRec(m, "Fitting", { b: m.symbol.type, b2: REL_KO[m.relation], c: m.symbol.tag || "—" }));
  const relief = owned
    .filter((m) => cls.get(m.symbol.id) === "relief")
    .map((m) =>
      symRec(m, "Relief", {
        b: m.symbol.type,
        b2: `보호 대상: ${eqs[0]?.equipment.tag ?? "확인 필요"}`,
        c: "Set pressure — 데이터시트 필요",
        c2: REL_KO[m.relation],
      }),
    );

  // Loops: 측정 변수 첫 글자 + 번호가 같은 계기·제어밸브를 묶는다 (도면 전체에서 멤버 수집)
  // 예) TT/TI/TDI 2411 → T-2411, PDT/PDI 2411 → P-2411 (번호만 같은 다른 루프를 분리)
  const loopKey = (s: PidSymbol) => {
    const t = parseInstrumentTag(s.tag);
    return t ? `${t.letters[0]}-${t.number}` : null;
  };
  const uniqTags = (arr: PidSymbol[]) => [...new Set(arr.map((s) => s.tag))];
  const loopKeys = new Set<string>();
  for (const m of owned) {
    const c = cls.get(m.symbol.id)!;
    const k = loopKey(m.symbol);
    if (k && (c === "instrument" || c === "control_valve")) loopKeys.add(k);
  }
  const loops: Rec[] = [];
  const interlocks: Rec[] = [];
  const ilDone = new Set<string>();
  for (const lk of loopKeys) {
    const num = lk.split("-")[1];
    const members = allSymbols.filter((s) => loopKey(s) === lk && classifySymbol(s) !== "interlock");
    const parsed = members.map((s) => parseInstrumentTag(s.tag)!);
    const variable = parsed[0]?.variable ?? "—";
    const fns = new Set(parsed.flatMap((p) => p.functions));
    const kind = fns.has("controller") || fns.has("control valve") ? "Control loop" : fns.has("alarm") || fns.has("switch") || fns.has("shutdown") ? "Alarm / trip" : "Indication";
    const onPipe = members.filter((s) => owned.some((m) => m.symbol.id === s.id));
    const first = onPipe[0] ?? members[0];
    const tags = uniqTags(members);
    loops.push(
      withReview(
        {
          key: `loop:${lk}`,
          kind: "Loop",
          a: `Loop ${lk}`,
          b: tags.join(" · "),
          c: `${variable} · ${kind}`,
          c2: `이 라인 ${uniqTags(onPipe).length} / 전체 ${tags.length}`,
          conf: tags.length > 1 ? 0.8 : 0.65,
          fields: [
            { label: "Signal net", value: tags.join(" ⇢ "), src: "측정 변수·번호가 같은 계기·제어밸브" },
            { label: "Variable", value: variable, src: "ISA 5.1 첫 문자" },
            { label: "Functions", value: [...fns].join(", ") || "—" },
            { label: "Kind", value: kind },
            { label: "On this line", value: uniqTags(onPipe).join(", ") || "—" },
            { label: "Evidence", value: "Control narrative / alarm·trip list 미등록" },
          ],
          target: first ? { kind: "sym", id: first.id } : undefined,
          box: first,
        },
        reviews,
      ),
    );
    // 같은 번호의 인터록(보팅 로직·셧다운·핸드 스위치)
    const ilMembers = allSymbols.filter((s) => parseInstrumentTag(s.tag)?.number === num && classifySymbol(s) === "interlock");
    if (ilMembers.length && !ilDone.has(num)) {
      ilDone.add(num);
      const initiators = uniqTags(allSymbols.filter((s) => parseInstrumentTag(s.tag)?.number === num && classifySymbol(s) === "instrument"));
      interlocks.push(
        withReview(
          {
            key: `il:${num}`,
            kind: "Interlock",
            a: uniqTags(ilMembers).join(" · "),
            b: initiators.join(", ") || "—",
            b2: `→ ${[...new Set(ilMembers.map((s) => s.type))].join(", ")}`,
            c: "C&E 미등록",
            conf: 0.6,
            fields: [
              { label: "Initiator", value: initiators.join(", ") || "—" },
              { label: "Action", value: ilMembers.map((s) => `${s.tag} (${s.type})`).join(", ") },
              { label: "Evidence", value: "Cause & Effect 차트 미등록 — 확인 필요" },
              { label: "SIF / SIL", value: "미지정 (SRS 미등록)" },
            ],
            target: { kind: "sym", id: ilMembers[0].id },
            box: ilMembers[0],
          },
          reviews,
          "Ask user",
        ),
      );
    }
  }
  // 이 라인에 직접 귀속된 인터록 심볼 (루프 번호 없음)
  for (const m of owned.filter((x) => cls.get(x.symbol.id) === "interlock")) {
    if (ilDone.has(parseInstrumentTag(m.symbol.tag)?.number ?? "")) continue;
    interlocks.push(symRec(m, "Interlock", { b: m.symbol.type, c: "C&E 미등록" }));
  }
  const instruments = owned.filter((m) => cls.get(m.symbol.id) === "instrument");

  // ── C: Connectivity ──
  const bothKnown = ends.from.kind !== "Open end" && ends.to.kind !== "Open end";
  const edge = withReview(
    {
      key: `conn:${pipe.id}`,
      kind: "Pipeline edge",
      a: pipe.name,
      b: `${endText(ends.from)} → ${endText(ends.to)}`,
      c: ends.directionKnown ? "흐름 방향: 커넥터 FROM/TO 기준" : "흐름 방향 미확정",
      conf: bothKnown ? (ends.directionKnown ? 0.9 : 0.75) : 0.5,
      fields: [
        { label: "From", value: `${endText(ends.from)} — ${ends.from.kind === "Equipment" ? ends.from.detail : ends.from.kind === "Connector" ? ends.from.detail : ends.from.detail}` },
        { label: "To", value: `${endText(ends.to)} — ${ends.to.detail}` },
        { label: "Direction", value: ends.directionKnown ? "확정 (커넥터 FROM/TO)" : "미확정 — 확인 필요" },
        { label: "Line", value: info.lineNumbers.map((l) => l.text).join(", ") || "—" },
      ],
    },
    reviews,
  );
  const opcs = connectors.map((l) => {
    const resolved = resolveRef(l.ref, drawing);
    const unitOf = (s?: string) => s?.split("-")[1];
    const other = !!l.ref && !resolved && unitOf(l.ref) !== unitOf(drawing.no);
    const dir = /^FROM/i.test(l.fromTo ?? "") ? "IN" : /^TO/i.test(l.fromTo ?? "") ? "OUT" : "—";
    return withReview(
      {
        key: `opc:${l.id}`,
        kind: "Off-page connector",
        a: l.ref ?? l.text,
        b: `${dir} · ${l.text}`,
        b2: l.fromTo,
        c: resolved ? `→ ${resolved.file.replace(/\.png$/, "")} · ${resolved.title}` : other ? "다른 Unit 도면 (미등록)" : "상대 도면 미확인",
        conf: resolved ? 0.9 : other ? 0.7 : 0.5,
        fields: [
          { label: "Service", value: l.text },
          { label: "Direction", value: dir === "IN" ? "들어옴 (FROM)" : dir === "OUT" ? "나감 (TO)" : "—" },
          { label: "Counterpart", value: l.fromTo || "—" },
          { label: "Sheet ref", value: l.ref || "—" },
          { label: "Resolved", value: resolved ? `${resolved.file} · ${resolved.title}` : other ? "다른 Unit — battery limit 로 처리 필요" : "No", src: "Unit 도면 목록(label.json)" },
        ],
        target: { kind: "label", id: l.id },
        box: l,
      },
      reviews,
      resolved ? undefined : other ? "Gap" : "Ask user",
    );
  });
  const branches = owned.filter((m) => m.relation === "branch");

  // ── D: Chemicals ──
  const cand = candidateChemicals(info.service, info.fluidCodes);
  const specified = pipe.chemicals ?? [];
  const svcKey = `svc:${pipe.id}`;
  const service: ServiceRow = {
    key: svcKey,
    code: info.fluidCodes.join(", ") || "—",
    legend: info.fluidNames.join(", ") || "—",
    service: info.service,
    lineCount: info.lineNumbers.length,
    candidates: cand.ids,
    specified,
    basis: cand.basis,
    conf: specified.length ? 1 : cand.ids.length ? 0.6 : 0.3,
    status: specified.length ? "Confirmed" : cand.ids.length ? "Review" : "Ask user",
  };
  const inventory = specified.map((id) => CHEMICALS[id]).filter(Boolean);

  // ── E: Conditions ──
  const conditions: Rec[] = eqs.map((c) =>
    withReview(
      {
        key: `cond:${pipe.id}:${c.equipment.id}`,
        kind: "Conditions",
        a: c.equipment.tag,
        b: "OP / OT — H&MB 미등록",
        c: `DP ${specOf(c.equipment, /PRESSURE/) ?? "—"}`,
        c2: `DT ${specOf(c.equipment, /TEMPERATURE/) ?? "—"}`,
        conf: specOf(c.equipment, /PRESSURE/) ? 0.85 : 0.4,
        fields: [
          { label: "OP / OT", value: "H&MB 미등록 — Ask user", src: "H&MB" },
          { label: "DP", value: specOf(c.equipment, /PRESSURE/) ?? "—", src: `${c.equipment.tag} 데이터 블록` },
          { label: "DT", value: specOf(c.equipment, /TEMPERATURE/) ?? "—", src: `${c.equipment.tag} 데이터 블록` },
          { label: "Safe limits", value: "기본값 (편집 가능) — safe-limit 레코드 없음" },
          { label: "Line insulation", value: info.insulations.join(", ") || "—", src: "라인 번호" },
        ],
        target: { kind: "equip", id: c.equipment.id },
        box: c.equipment,
      },
      reviews,
    ),
  );

  // ── F: Review ──
  const allRecs = [...equipment, ...lines, ...valves, ...fittings, ...loops, ...interlocks, ...relief, edge, ...opcs, ...conditions];
  const untagged = [...valves, ...fittings].filter((r) => r.a === "(태그 없음)").length;
  const confirmed = allRecs.filter((r) => r.status === "Confirmed").length;
  const checks: Check[] = [
    { id: "F1", text: "From / To 양끝 확인", ok: bothKnown, value: bothKnown ? "2/2" : `${[ends.from, ends.to].filter((e) => e.kind !== "Open end").length}/2`, detail: `${endText(ends.from)} → ${endText(ends.to)}` },
    { id: "F2", text: "흐름 방향 확정", ok: ends.directionKnown, value: ends.directionKnown ? "OK" : "—", detail: ends.directionKnown ? "커넥터 FROM/TO 기준" : "양끝이 모두 장비이거나 방향 정보 없음" },
    { id: "F3", text: "라인 번호 식별", ok: info.lineNumbers.length > 0, value: String(info.lineNumbers.length), detail: info.lineNumbers.map((l) => l.text).join(", ") || "라인 번호 없음" },
    { id: "F4", text: "화학물질 지정 (D)", ok: specified.length > 0, value: specified.length ? String(specified.length) : "0", detail: specified.length ? specified.map((i) => CHEMICALS[i]?.name ?? i).join(", ") : `후보: ${cand.ids.map((i) => CHEMICALS[i]?.name).join(", ") || "없음"}` },
    { id: "F5", text: "장비 연결 노즐 확인", ok: eqs.length === 0 || eqs.every((c) => c.nozzles.length > 0), value: `${eqs.filter((c) => c.nozzles.length).length}/${eqs.length}`, detail: eqs.map((c) => `${c.equipment.tag}(${c.nozzles.join(",") || "?"})`).join(", ") || "연결 장비 없음" },
    { id: "F6", text: "커넥터 상대 도면 해결", ok: opcs.every((o) => o.status !== "Ask user"), value: `${opcs.filter((o) => o.conf >= 0.9).length}/${opcs.length}`, detail: opcs.map((o) => `${o.a}: ${o.c}`).join(" · ") || "커넥터 없음" },
    { id: "F7", text: "컴포넌트 태그 확인", ok: untagged === 0, value: untagged ? `${untagged} 미확인` : "OK", detail: "태그 없는 밸브·피팅은 검토 필요" },
    { id: "F8", text: "운전 조건 (OP/OT)", ok: false, value: "Gap", detail: "H&MB 미등록 — 3.1 로 gap 으로 넘김" },
    { id: "F9", text: "레코드 검토 완료", ok: confirmed === allRecs.length && allRecs.length > 0, value: `${confirmed}/${allRecs.length}`, detail: "모든 레코드 Confirmed 시 통과" },
  ];

  const records = new Map<string, Rec>();
  for (const r of allRecs) records.set(r.key, r);

  return {
    ends,
    components: { equipment, lines, valves, fittings, loops, interlocks, relief },
    instruments,
    connectivity: { edge, opcs, branches },
    chemicals: { service, inventory },
    conditions,
    checks,
    records,
  };
}

export type PipelineReview = ReturnType<typeof buildReview>;
