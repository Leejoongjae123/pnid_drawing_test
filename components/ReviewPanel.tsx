"use client";

// SERiD HAZOP Step 2.2 (Process interpretation & review) 구성을 따른 파이프라인 검토 패널
// A Documents & legend · B Components · C Connectivity · D Chemicals · E Streams & conditions · F Review & sign-off
import { useState } from "react";
import { CHEMICALS } from "@/lib/chemicals";
import { endText, type DrawingInfo, type PipelineReview, type Rec, type ReviewStatus, type Target } from "@/lib/hazop";
import { FLUID_CODES, INSULATION_CODES, type ChemicalInfo } from "@/lib/labels";
import type { PidSymbol, Pipeline } from "@/lib/types";

type Step = "A" | "B" | "C" | "D" | "E" | "F";
type CompTab = "equipment" | "lines" | "valves" | "fittings" | "loops" | "interlocks" | "relief";

const STEPS: { id: Step; title: string; sub: string }[] = [
  { id: "A", title: "Documents", sub: "도면 · 범례" },
  { id: "B", title: "Components", sub: "장비·라인·밸브·루프" },
  { id: "C", title: "Connectivity", sub: "From→To · 커넥터" },
  { id: "D", title: "Chemicals", sub: "서비스 → 화학물질" },
  { id: "E", title: "Conditions", sub: "OP/OT · DP/DT" },
  { id: "F", title: "Review", sub: "완료 기준 · 승인" },
];

const COMP_TABS: { id: CompTab; label: string; cols: [string, string, string] }[] = [
  { id: "equipment", label: "Equipment", cols: ["Tag", "Class · nozzles", "Design conditions"] },
  { id: "lines", label: "Lines", cols: ["Line number", "From → To", "Service · class"] },
  { id: "valves", label: "Valves", cols: ["Valve", "Type · line", "Fail · loop"] },
  { id: "fittings", label: "Fittings", cols: ["Fitting", "Type", "Size / tag"] },
  { id: "loops", label: "Loops", cols: ["Loop", "Elements", "Function · kind"] },
  { id: "interlocks", label: "Interlocks", cols: ["Interlock", "Initiator → action", "Evidence"] },
  { id: "relief", label: "Relief", cols: ["Device", "Protects", "Set · relation"] },
];

const STATUS_CLS: Record<ReviewStatus, string> = {
  Confirmed: "st-confirmed",
  Confirm: "st-confirm",
  Review: "st-review",
  "Ask user": "st-ask",
  Gap: "st-gap",
};

const confCls = (c: number) => (c >= 0.85 ? "conf-hi" : c >= 0.6 ? "conf-mid" : "conf-lo");

export interface ReviewPanelProps {
  pipe: Pipeline;
  review: PipelineReview;
  info: ChemicalInfo;
  drawing: DrawingInfo;
  shared: { symbol: PidSymbol; ownerName: string; ownerColor: string }[];
  excluded: PidSymbol[];
  selRec: string | null;
  onSelectRec: (r: Rec | null) => void;
  onHover: (t: Target | null) => void;
  onFocusBox: (b: { x: number; y: number; w: number; h: number }) => void;
  onSetReview: (key: string, status: "Confirmed" | "Ask user" | null) => void;
  onToggleMember: (symId: string, member: boolean) => void;
  onSpecifyChemicals: (ids: string[]) => void;
  onSetStatus: (status: Pipeline["status"]) => void;
  onAddLabel: () => void;
  actions: React.ReactNode;
}

export default function ReviewPanel(p: ReviewPanelProps) {
  const [step, setStep] = useState<Step>("B");
  const [tab, setTab] = useState<CompTab>("equipment");
  const { review: R, pipe, info } = p;
  const C = R.components;
  const counts: Record<CompTab, number> = {
    equipment: C.equipment.length,
    lines: C.lines.length,
    valves: C.valves.length,
    fittings: C.fittings.length,
    loops: C.loops.length,
    interlocks: C.interlocks.length,
    relief: C.relief.length,
  };
  const passCount = R.checks.filter((k) => k.ok).length;
  const allRecs = [...R.records.values()];
  const reviewOpen = allRecs.filter((r) => r.status !== "Confirmed").length;
  const stepBadge: Record<Step, string> = {
    A: "",
    B: `${allRecs.filter((r) => r.kind !== "Pipeline edge" && r.kind !== "Off-page connector" && r.kind !== "Conditions" && r.status !== "Confirmed").length} review`,
    C: `${[R.connectivity.edge, ...R.connectivity.opcs].filter((r) => r.status !== "Confirmed").length} open`,
    D: R.chemicals.service.specified.length ? "specified" : "specify",
    E: `${R.conditions.length + 1} confirm`,
    F: `${passCount}/${R.checks.length}`,
  };
  const rec = p.selRec ? R.records.get(p.selRec) ?? null : null;

  const row = (r: Rec) => (
    <button
      key={r.key}
      className={`rv-row ${p.selRec === r.key ? "sel" : ""}`}
      onClick={() => p.onSelectRec(r)}
      onMouseEnter={() => r.target && p.onHover(r.target)}
      onMouseLeave={() => p.onHover(null)}
    >
      <span className="rv-a">{r.a}</span>
      <span className="rv-b">
        {r.b}
        {r.b2 && <small>{r.b2}</small>}
      </span>
      <span className="rv-c">
        {r.c}
        {r.c2 && <small>{r.c2}</small>}
      </span>
      <span className={`rv-conf ${confCls(r.conf)}`}>{Math.round(r.conf * 100)}%</span>
      <span className={`rv-status ${STATUS_CLS[r.status]}`}>{r.status}</span>
    </button>
  );

  const table = (cols: [string, string, string], rows: Rec[], empty = "없음") => (
    <div className="rv-table">
      <div className="rv-head">
        <span>{cols[0]}</span>
        <span>{cols[1]}</span>
        <span>{cols[2]}</span>
        <span>Conf.</span>
        <span>Status</span>
      </div>
      {rows.length ? rows.map(row) : <div className="rv-empty">{empty}</div>}
    </div>
  );

  const tabRows: Record<CompTab, Rec[]> = {
    equipment: C.equipment,
    lines: C.lines,
    valves: C.valves,
    fittings: C.fittings,
    loops: C.loops,
    interlocks: C.interlocks,
    relief: C.relief,
  };

  return (
    <div className="rv">
      {/* ── 헤더: 파이프라인 · From → To ── */}
      <div className="rv-top" style={{ borderTopColor: pipe.color }}>
        <div className="rv-title">
          <i className="swatch" style={{ background: pipe.color }} />
          <span>{pipe.name}</span>
          <button className={`badge ${pipe.status}`} onClick={() => p.onSetStatus(pipe.status === "candidate" ? "confirmed" : "candidate")} title="후보 ↔ 확정">
            {pipe.status === "candidate" ? "후보" : "확정"}
          </button>
        </div>
        <div className="rv-service">
          {info.service ?? <span className="muted">(서비스명 없음)</span>}
          {info.lineNumbers[0] && <span className="mono"> · {info.lineNumbers[0].text}</span>}
        </div>
        <div className="rv-edge">
          <span className="rv-end from">
            <small>FROM</small>
            {endText(R.ends.from)}
          </span>
          <span className="rv-arrow">{R.ends.directionKnown ? "→" : "↔"}</span>
          <span className="rv-end to">
            <small>TO</small>
            {endText(R.ends.to)}
          </span>
        </div>
        <div className="rv-meta">
          <span>
            <b>{passCount}</b>/{R.checks.length} criteria
          </span>
          <span>
            <b>{reviewOpen}</b> records to review
          </span>
        </div>
        {p.actions}
      </div>

      {/* ── 단계 탭 A–F ── */}
      <div className="rv-steps">
        {STEPS.map((s) => (
          <button key={s.id} className={`rv-step ${step === s.id ? "on" : ""}`} onClick={() => setStep(s.id)} title={s.sub}>
            <b>{s.id}</b>
            <span>{s.title}</span>
            {stepBadge[s.id] && <em>{stepBadge[s.id]}</em>}
          </button>
        ))}
      </div>

      <div className="rv-body">
        {/* A · Documents & legend */}
        {step === "A" && (
          <>
            <h3>Documents &amp; legend</h3>
            <dl className="rv-kv">
              <dt>Drawing</dt>
              <dd>{p.drawing.no ?? "—"}</dd>
              <dt>Title</dt>
              <dd>{p.drawing.title ?? "—"}</dd>
              <dt>Unit</dt>
              <dd>{p.drawing.unit ?? "—"}</dd>
            </dl>
            <h4>이 라인에 쓰인 범례 규칙</h4>
            <div className="rv-note">범례 의미는 일반 라이브러리 후보입니다. 프로젝트 범례(DWG 5-231-2.00-4103~4107)로 확인해야 규칙이 됩니다.</div>
            <div className="rv-table">
              <div className="rv-head legend">
                <span>Code</span>
                <span>Meaning</span>
                <span>Status</span>
              </div>
              {[...info.fluidCodes.map((c) => [c, FLUID_CODES[c] ?? "?"]), ...info.insulations.map((c) => [c, `보온 · ${INSULATION_CODES[c] ?? "?"}`])].map(([c, m]) => (
                <div key={c} className="rv-row static legend">
                  <span className="rv-a">{c}</span>
                  <span className="rv-b">{m}</span>
                  <span className="rv-status st-review">To confirm</span>
                </div>
              ))}
              {!info.fluidCodes.length && <div className="rv-empty">라인 번호가 없어 범례 규칙 없음</div>}
            </div>
            <h4>Unit 도면 목록 (커넥터 해석용)</h4>
            <div className="rv-reg">
              {(p.drawing.register ?? []).map((d) => (
                <div key={d.dwg_no} className={d.dwg_no === p.drawing.no ? "cur" : ""}>
                  <span className="mono">{d.dwg_no}</span> <span>{d.title}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* B · Components */}
        {step === "B" && (
          <>
            <h3>Components</h3>
            <div className="rv-seg">
              {COMP_TABS.map((t) => (
                <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
                  {t.label} <b>{counts[t.id]}</b>
                </button>
              ))}
            </div>
            {table(COMP_TABS.find((t) => t.id === tab)!.cols, tabRows[tab])}
            {tab === "loops" && R.instruments.length > 0 && (
              <div className="rv-note">
                이 라인의 계기 {R.instruments.length}개를 태그 번호로 묶었습니다: {R.instruments.map((m) => m.symbol.tag || m.symbol.type).join(", ")}
              </div>
            )}
            <div className="rv-legend">신뢰도 ≥ 85% 확인 후보 · 60–84% 검토 · &lt; 60% 사용자 확인 · Fail 위치·보호 기능은 근거 문서 필요</div>
          </>
        )}

        {/* C · Connectivity */}
        {step === "C" && (
          <>
            <h3>Connectivity</h3>
            {table(["Pipeline", "From → To", "Direction"], [R.connectivity.edge])}
            <h4>Off-page connectors</h4>
            {table(["Sheet ref", "Dir · service", "Counterpart"], R.connectivity.opcs, "이 라인에 연결된 커넥터 없음")}
            <h4>본선에 딸린 분기 · 보조 요소</h4>
            {R.connectivity.branches.length ? (
              <ul className="rv-bullets">
                {R.connectivity.branches.map((m) => (
                  <li key={m.symbol.id} onMouseEnter={() => p.onHover({ kind: "sym", id: m.symbol.id })} onMouseLeave={() => p.onHover(null)} onClick={() => p.onFocusBox(m.symbol)}>
                    <b>{m.symbol.tag || m.symbol.type}</b> — {m.symbol.type}, 본선에서 분기/근접 연결 → 이 라인과 함께 유지
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rv-empty">분기 요소 없음</div>
            )}
            {(p.shared.length > 0 || p.excluded.length > 0) && (
              <>
                <h4>다른 라인 귀속 / 제외</h4>
                <ul className="rv-bullets">
                  {p.shared.map((s) => (
                    <li key={s.symbol.id} onMouseEnter={() => p.onHover({ kind: "sym", id: s.symbol.id })} onMouseLeave={() => p.onHover(null)}>
                      <b>{s.symbol.tag || s.symbol.type}</b> → <b style={{ color: s.ownerColor }}>{s.ownerName}</b> 귀속{" "}
                      <button className="link" onClick={() => p.onToggleMember(s.symbol.id, true)}>
                        이 라인으로
                      </button>
                    </li>
                  ))}
                  {p.excluded.map((s) => (
                    <li key={s.id} className="excluded">
                      <b>{s.tag || s.type}</b> 수동 제외{" "}
                      <button className="link" onClick={() => p.onToggleMember(s.id, true)}>
                        복원
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {/* D · Chemicals */}
        {step === "D" &&
          (() => {
            const S = R.chemicals.service;
            const toggle = (id: string) => p.onSpecifyChemicals(S.specified.includes(id) ? S.specified.filter((x) => x !== id) : [...S.specified, id]);
            return (
              <>
                <h3>Chemicals</h3>
                <div className="rv-note">라인 번호에서 서비스 코드를 읽고, 서비스명·범례로 후보 화학물질을 제안합니다. 엔지니어가 지정한 것만 확정 정보로 사용됩니다.</div>
                <div className="rv-card">
                  <div className="rv-card-head">
                    <span className="code">{S.code}</span>
                    <span className="rv-card-title">{S.service ?? "(서비스명 없음)"}</span>
                    <span className={`rv-status ${STATUS_CLS[S.status]}`}>{S.specified.length ? "Specified" : S.candidates.length ? "Specify" : "Ask user"}</span>
                  </div>
                  <dl className="rv-kv">
                    <dt>Legend</dt>
                    <dd>{S.legend}</dd>
                    <dt>Lines</dt>
                    <dd>{info.lineNumbers.map((l) => l.text).join(", ") || "—"}</dd>
                    <dt>Candidates</dt>
                    <dd>
                      <span className="muted">{S.basis}</span>
                    </dd>
                  </dl>
                  <div className="chem-chips">
                    {S.candidates.map((id) => (
                      <button key={id} className={`chem-chip ${S.specified.includes(id) ? "on" : ""}`} onClick={() => toggle(id)}>
                        {S.specified.includes(id) ? "✓ " : "+ "}
                        {CHEMICALS[id]?.name ?? id}
                      </button>
                    ))}
                    {Object.keys(CHEMICALS)
                      .filter((id) => !S.candidates.includes(id) && S.specified.includes(id))
                      .map((id) => (
                        <button key={id} className="chem-chip on" onClick={() => toggle(id)}>
                          ✓ {CHEMICALS[id].name}
                        </button>
                      ))}
                    <select
                      className="chem-add"
                      value=""
                      onChange={(e) => e.target.value && p.onSpecifyChemicals([...new Set([...S.specified, e.target.value])])}
                    >
                      <option value="">+ 다른 물질</option>
                      {Object.values(CHEMICALS)
                        .filter((c) => !S.specified.includes(c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
                <h4>Inventory (지정된 물질)</h4>
                {R.chemicals.inventory.length ? (
                  <div className="rv-inv">
                    <div className="rv-inv-head">
                      <span>Chemical · CAS</span>
                      <span>LFL/UFL %</span>
                      <span>Flash</span>
                      <span>AIT</span>
                      <span>BP</span>
                      <span>TWA</span>
                    </div>
                    {R.chemicals.inventory.map((c) => (
                      <div key={c.id} className="rv-inv-row">
                        <span>
                          <b>{c.name}</b>
                          <small>
                            {c.formula} · {c.cas}
                          </small>
                          <span className="hz">
                            {c.hazards.map((h) => (
                              <i key={h} className={/Toxic/.test(h) ? "tox" : /Flammable/.test(h) ? "flam" : ""}>
                                {h}
                              </i>
                            ))}
                          </span>
                        </span>
                        <span>
                          {c.lfl} / {c.ufl}
                        </span>
                        <span>{c.flash}</span>
                        <span>{c.ait}</span>
                        <span>{c.bp}</span>
                        <span>{c.twa}</span>
                      </div>
                    ))}
                    <div className="rv-legend">물성은 문헌 참고값(°C) — SERiD DB(DIPPR)·KOSHA 노출기준 확인 전까지 확정값 아님</div>
                  </div>
                ) : (
                  <div className="rv-empty">지정된 화학물질이 없습니다 — 위 후보를 눌러 지정하세요</div>
                )}
              </>
            );
          })()}

        {/* E · Streams & conditions */}
        {step === "E" && (
          <>
            <h3>Streams &amp; conditions</h3>
            <div className="rv-note">OP/OT 는 H&amp;MB, DP/DT 는 장비 데이터 블록, 안전 한계는 safe-limit 레코드(없으면 편집 가능한 기본값)에서 가져옵니다.</div>
            {table(["Equipment", "OP / OT", "DP / DT"], R.conditions, "연결 장비가 없어 설계 조건 없음")}
            <dl className="rv-kv">
              <dt>H&amp;MB stream</dt>
              <dd>
                <span className="rv-status st-ask">Ask user</span> H&amp;MB 미등록 — 스트림 매칭 불가
              </dd>
              <dt>Line class</dt>
              <dd>{info.specs.join(", ") || "—"} (배관 등급표 필요)</dd>
              <dt>Insulation</dt>
              <dd>{info.lineNumbers.map((l) => `${l.insulation} ${l.insulationName}`).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "—"}</dd>
            </dl>
          </>
        )}

        {/* F · Review & sign-off */}
        {step === "F" && (
          <>
            <h3>Review &amp; sign-off</h3>
            <div className="rv-checks">
              {R.checks.map((k) => (
                <div key={k.id} className={`rv-check ${k.ok ? "ok" : ""}`}>
                  <i />
                  <b>{k.id}</b>
                  <span className="t">{k.text}</span>
                  <span className="v">{k.value}</span>
                  <span className="d">{k.detail}</span>
                </div>
              ))}
            </div>
            <div className="rv-note">미충족 항목이 있어도 승인할 수 있으며, 열린 항목은 다음 단계(노드 선정)로 gap 으로 넘어갑니다.</div>
            <div className="row">
              <button
                onClick={() => {
                  for (const r of allRecs) if (r.status === "Confirm") p.onSetReview(r.key, "Confirmed");
                }}
              >
                신뢰도 높은 레코드 일괄 확인
              </button>
              <button className="primary" onClick={() => p.onSetStatus("confirmed")}>
                {pipe.status === "confirmed" ? "✓ 승인됨" : `승인 (${R.checks.length - passCount} gap)`}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── 레코드 상세 ── */}
      <div className={`rv-rec ${rec ? "" : "empty"}`}>
        {rec ? (
          <>
            <div className="rv-rec-head">
              <div>
                <small>{rec.kind}</small>
                <b>{rec.a}</b>
              </div>
              <span className={`rv-status ${STATUS_CLS[rec.status]}`}>{rec.status}</span>
              <button className="icon" onClick={() => p.onSelectRec(null)} title="닫기">
                ✕
              </button>
            </div>
            <div className="rv-fields">
              {rec.fields.map((f, i) => (
                <div key={i}>
                  <span className="l">{f.label}</span>
                  <span className="v">
                    {f.value}
                    {f.src && <small>{f.src}</small>}
                  </span>
                </div>
              ))}
            </div>
            <div className="row">
              <button className="primary" onClick={() => p.onSetReview(rec.key, "Confirmed")}>
                Confirm
              </button>
              <button onClick={() => p.onSetReview(rec.key, "Ask user")}>Ask user</button>
              {rec.status === "Confirmed" || rec.status === "Ask user" ? <button onClick={() => p.onSetReview(rec.key, null)}>초기화</button> : null}
              {rec.box && <button onClick={() => p.onFocusBox(rec.box!)}>도면에서 보기</button>}
              {rec.excludable && (
                <button
                  className="danger-btn"
                  onClick={() => {
                    p.onToggleMember(rec.excludable!, false);
                    p.onSelectRec(null);
                  }}
                >
                  이 라인에서 제외
                </button>
              )}
              {rec.kind === "Line" && (
                <button className="link" onClick={p.onAddLabel}>
                  + 라인 번호 추가
                </button>
              )}
            </div>
          </>
        ) : (
          <span className="muted">목록에서 레코드를 선택하면 근거(출처)와 함께 상세가 표시됩니다. 검토자가 Confirm 한 것만 확정 정보로 취급합니다.</span>
        )}
      </div>
    </div>
  );
}
