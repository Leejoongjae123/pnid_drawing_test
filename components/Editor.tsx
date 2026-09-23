"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DetectParams, Equipment, ImageFolder, Line, LineDoc, LineLabel, PidSymbol, Pipeline, SymbolCategory } from "@/lib/types";
import { pipelineEquipment, type EquipConnection } from "@/lib/equipment";
import { clearLocal, hasLocal, imageUrlFor, listImages, loadDoc, saveDoc, STATIC_MODE } from "@/lib/source";
import { assignLabels, chemicalInfo, parseLineNumber, type ChemicalInfo } from "@/lib/labels";
import { CATEGORY_LABEL, pipelineMembers, resolveOwners, type Ownership, type PipeMembers, type Relation } from "@/lib/symbols";
import { lineLength, newId, ortho, project, round1 } from "@/lib/geometry";
import {
  buildGraph,
  continuationsAt,
  DEFAULT_GRAPH_OPTS,
  dist,
  distToPolyline,
  followChain,
  nearestNode,
  polyLength,
  simplify,
  tracePipelines,
  trimEnd,
  unit,
  type Continuation,
  type Graph,
  type Pt,
} from "@/lib/graph";

type Tool = "select" | "new" | "box" | "pan";
type View = { scale: number; tx: number; ty: number };
type Doc = { lines: Line[]; pipelines: Pipeline[]; symbols: PidSymbol[]; labels: LineLabel[]; equipment: Equipment[] };
type EndKey = "start" | "end";
type Drag =
  | { kind: "pan"; sx: number; sy: number; v: View }
  | { kind: "vertex"; pipeId: string; index: number; anchor: Pt | null; before: Doc; moved: boolean; temp: boolean }
  | { kind: "sym"; id: string; mode: "move" | "resize" | "create"; start: Pt; orig: PidSymbol; before: Doc; moved: boolean };

const REL_LABEL: Record<Relation, string> = { inline: "라인상", branch: "분기", manual: "수동" };
const SYM_GRAY = "#6b7280";

const DEFAULT_IMAGE = "Unit 232 (1)/page_002.png";
const DEFAULT_PARAMS: DetectParams = { minLen: 40, gap: 8, sensitivity: 8, hough: true };
const SNAP_PX = 12;
const HISTORY_MAX = 200;
const PALETTE = ["#e5484d", "#0091ff", "#30a46c", "#f76b15", "#8e4ec6", "#d6409f", "#12a594", "#ffb224"];
const EMPTY: Doc = { lines: [], pipelines: [], symbols: [], labels: [], equipment: [] };
const EQUIP_COLOR = "#0e7490";

const kindOf = (l: Line) => (l.id[0] === "h" ? "H" : l.id[0] === "v" ? "V" : l.id[0] === "d" ? "D" : "M");
const bounds = (pts: Pt[]) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

function makeCandidates(g: Graph, doc: Doc, size: { w: number; h: number }, count: number, skip: Pt[][]): Pipeline[] {
  const confirmed = doc.pipelines.filter((p) => p.status === "confirmed");
  const polys = tracePipelines(g, { count, width: size.w, height: size.h, exclude: confirmed.map((p) => p.points), skip });
  return polys.map((pts, i) => ({
    id: newId(),
    name: `후보 ${i + 1}`,
    color: PALETTE[(confirmed.length + i) % PALETTE.length],
    points: pts.map((p) => ({ x: round1(p.x), y: round1(p.y) })),
    status: "candidate",
    visible: true,
  }));
}

export default function Editor() {
  // ── 문서 ────────────────────────────────────
  const [folders, setFolders] = useState<ImageFolder[]>([]);
  const [imagePath, setImagePath] = useState(DEFAULT_IMAGE);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [doc, setDoc] = useState<Doc>(EMPTY);
  const [params, setParams] = useState<DetectParams>(DEFAULT_PARAMS);
  const [bridgeGap, setBridgeGap] = useState(DEFAULT_GRAPH_OPTS.bridgeGap);
  const [candCount, setCandCount] = useState(5);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  // ── 편집 상태 ───────────────────────────────
  const [tool, setTool] = useState<Tool>("select");
  const [selPipe, setSelPipe] = useState<string | null>(null);
  const [selVertex, setSelVertex] = useState<number | null>(null);
  const [selLine, setSelLine] = useState<string | null>(null);
  const [hoverChain, setHoverChain] = useState<Pt[] | null>(null);
  const [snapMark, setSnapMark] = useState<Pt | null>(null);
  const [view, setView] = useState<View>({ scale: 0.3, tx: 0, ty: 0 });
  const [orthoLock, setOrthoLock] = useState(true);
  const [snapOn, setSnapOn] = useState(true);
  const [bgOpacity, setBgOpacity] = useState(0.7);
  const [showLines, setShowLines] = useState(true);
  const [showBridges, setShowBridges] = useState(false);
  const [lineFilter, setLineFilter] = useState<"all" | "free" | "used">("all");
  const [minLenFilter, setMinLenFilter] = useState(30);
  const [spaceDown, setSpaceDown] = useState(false);
  const [selSym, setSelSym] = useState<string | null>(null);
  const [symBusy, setSymBusy] = useState(false);
  const [showSymbols, setShowSymbols] = useState(true);
  const [expandAll, setExpandAll] = useState(false);
  const [selLabel, setSelLabel] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [selEquip, setSelEquip] = useState<string | null>(null);
  const [showEquip, setShowEquip] = useState(true);

  const past = useRef<Doc[]>([]);
  const future = useRef<Doc[]>([]);
  const rejected = useRef<Pt[][]>([]);
  const drag = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const ownerRef = useRef<Map<string, Ownership>>(new Map());
  const labelOwnerRef = useRef<Map<string, string>>(new Map());

  const graphOpts = useMemo(() => ({ ...DEFAULT_GRAPH_OPTS, bridgeGap }), [bridgeGap]);
  const graph = useMemo(() => buildGraph(doc.lines, graphOpts), [doc.lines, graphOpts]);
  const joinTol = graphOpts.joinTol + 2;

  // ── 히스토리 ────────────────────────────────
  const pushHistory = useCallback((before: Doc) => {
    past.current.push(before);
    if (past.current.length > HISTORY_MAX) past.current.shift();
    future.current = [];
    setDirty(true);
  }, []);
  const commit = useCallback(
    (next: Doc) => {
      pushHistory(docRef.current);
      setDoc(next);
    },
    [pushHistory],
  );
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(docRef.current);
    setDoc(prev);
    setDirty(true);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(docRef.current);
    setDoc(next);
    setDirty(true);
  }, []);

  const updatePipe = useCallback(
    (id: string, fn: (p: Pipeline) => Pipeline, record = true) => {
      const next = { ...docRef.current, pipelines: docRef.current.pipelines.map((p) => (p.id === id ? fn(p) : p)) };
      if (record) commit(next);
      else setDoc(next);
    },
    [commit],
  );

  // ── 로드 ────────────────────────────────────
  useEffect(() => {
    listImages()
      .then(setFolders)
      .catch(() => setStatus("이미지 목록을 불러오지 못했습니다"));
  }, []);

  const imageUrl = imageUrlFor(imagePath);

  const loadImageSize = useCallback(
    () =>
      new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = reject;
        img.src = imageUrl;
      }),
    [imageUrl],
  );

  const runDetect = useCallback(
    async (path: string, p: DetectParams, keepConfirmed: boolean) => {
      setBusy(true);
      setStatus("CV 선 검출 중…");
      try {
        const r = await fetch("/api/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, params: p }),
        });
        const res = (await r.json()) as LineDoc & { error?: string };
        if (!r.ok) throw new Error(res.error);
        const sz = { w: res.width, h: res.height };
        const base: Doc = {
          lines: res.lines,
          pipelines: keepConfirmed ? docRef.current.pipelines.filter((x) => x.status === "confirmed") : [],
          symbols: docRef.current.symbols,
          labels: docRef.current.labels,
          equipment: docRef.current.equipment,
        };
        const g = buildGraph(res.lines, graphOpts);
        const cands = makeCandidates(g, base, sz, candCount, rejected.current);
        if (docRef.current.lines.length) pushHistory(docRef.current);
        setDoc({ ...base, pipelines: [...base.pipelines, ...cands] });
        setSelPipe(cands[0]?.id ?? null);
        setDirty(true);
        setStatus(`검출 ${res.lines.length}개 선 · 파이프라인 후보 ${cands.length}개`);
      } catch (e) {
        setStatus(`검출 실패: ${e}`);
      } finally {
        setBusy(false);
      }
    },
    [graphOpts, candCount, pushHistory],
  );

  useEffect(() => {
    let cancelled = false;
    setDoc(EMPTY);
    setSelPipe(null);
    setSelLine(null);
    setSize(null);
    past.current = [];
    future.current = [];
    rejected.current = [];
    setDirty(false);
    (async () => {
      const [sz, saved] = await Promise.all([
        loadImageSize().catch(() => null),
        loadDoc(imagePath).catch(() => null),
      ]);
      if (cancelled) return;
      if (!sz) return setStatus("이미지를 불러오지 못했습니다");
      setSize(sz);
      if (saved) {
        let pipelines = saved.pipelines ?? [];
        if (!saved.pipelines) {
          pipelines = makeCandidates(buildGraph(saved.lines, graphOpts), { ...EMPTY, lines: saved.lines }, sz, candCount, []);
        }
        const symbols = saved.symbols ?? [];
        const labels = saved.labels ?? [];
        const equipment = saved.equipment ?? [];
        setDoc({ lines: saved.lines, pipelines, symbols, labels, equipment });
        setStatus(
          `저장본 불러옴: 선 ${saved.lines.length} · 파이프라인 ${pipelines.length} · 장비 ${equipment.length} · 심볼 ${symbols.length} · 라벨 ${labels.length}`,
        );
      } else if (STATIC_MODE) {
        setStatus("정적 배포 모드: 이 도면의 시드 데이터가 없습니다 (CV 검출은 로컬 서버에서만 가능)");
      } else {
        runDetect(imagePath, params, false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 이미지가 바뀔 때만 다시 로드
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePath]);

  const save = useCallback(async () => {
    const sz = sizeRef.current;
    if (!sz) return;
    const cur = docRef.current;
    // 귀속 결과(pipelineId/relation)도 함께 저장 — 불러올 때는 다시 계산된다
    const symbols = cur.symbols.map((s) => {
      const o = ownerRef.current.get(s.id);
      return { ...s, pipelineId: o?.pipeId ?? null, relation: o?.relation ?? null };
    });
    const labels = cur.labels.map((l) => ({ ...l, pipelineId: labelOwnerRef.current.get(l.id) ?? null }));
    const body: LineDoc = { image: imagePath, width: sz.w, height: sz.h, ...cur, symbols, labels };
    try {
      const where = await saveDoc(body);
      setDirty(false);
      setStatus(`저장됨: ${where}`);
    } catch (e) {
      setStatus(`저장 실패: ${e instanceof Error ? e.message : e}`);
    }
  }, [imagePath]);

  const exportJson = () => {
    if (!size) return;
    // 파이프라인별 children: 유체(chemical) 정보 → 라인 번호 → 컴포넌트 → 계기
    const pipelines = doc.pipelines.map((p) => {
      const info = infoOf.get(p.id)!;
      const owned = ownedBy(p.id);
      const sym = (m: (typeof owned)[number]) => ({
        symbolId: m.symbol.id,
        category: m.symbol.category,
        type: m.symbol.type,
        tag: m.symbol.tag,
        relation: m.relation,
      });
      const children = [
        {
          kind: "chemical",
          service: info.service,
          fluidCodes: info.fluidCodes,
          fluidNames: info.fluidNames,
          sizes: info.sizes,
          specs: info.specs,
          insulations: info.insulations,
          connectors: info.connectors,
        },
        ...(equipOf.get(p.id) ?? []).map((c) => ({
          kind: "equipment",
          equipmentId: c.equipment.id,
          tag: c.equipment.tag,
          name: c.equipment.name,
          type: c.equipment.type,
          nozzles: c.nozzles,
          relation: c.relation,
          specs: c.equipment.specs,
        })),
        ...info.lineNumbers.map((ln) => ({ kind: "line_number", ...ln })),
        ...owned.filter((m) => m.symbol.category !== "instrument").map((m) => ({ kind: "component", ...sym(m) })),
        ...owned.filter((m) => m.symbol.category === "instrument").map((m) => ({ kind: "instrument", ...sym(m) })),
      ];
      return { ...p, children };
    });
    const symbols = doc.symbols.map((s) => ({ ...s, pipelineId: owner.get(s.id)?.pipeId ?? null, relation: owner.get(s.id)?.relation ?? null }));
    const labels = doc.labels.map((l) => ({ ...l, pipelineId: labelOwner.get(l.id) ?? null }));
    const body = { image: imagePath, width: size.w, height: size.h, ...doc, pipelines, symbols, labels };
    const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = imagePath.split("/").pop()!.replace(/\.\w+$/, "") + ".pipelines.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── 뷰 ──────────────────────────────────────
  const fit = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !size) return;
    const r = svg.getBoundingClientRect();
    const scale = Math.min(r.width / size.w, r.height / size.h) * 0.98;
    setView({ scale, tx: (r.width - size.w * scale) / 2, ty: (r.height - size.h * scale) / 2 });
  }, [size]);
  useEffect(() => fit(), [fit]);

  const focus = useCallback((pts: Pt[]) => {
    const svg = svgRef.current;
    if (!svg || !pts.length) return;
    const r = svg.getBoundingClientRect();
    const b = bounds(pts);
    const pad = 80;
    const scale = Math.min(1.2, (r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1));
    setView({ scale, tx: r.width / 2 - (b.x + b.w / 2) * scale, ty: r.height / 2 - (b.y + b.h / 2) * scale });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const scale = Math.min(8, Math.max(0.05, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const f = scale / v.scale;
        return { scale, tx: mx - (mx - v.tx) * f, ty: my - (my - v.ty) * f };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const toImage = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.tx) / view.scale, y: (e.clientY - r.top - view.ty) / view.scale };
  };

  /** 직교 고정 → 그래프 노드 스냅 → 선 위 스냅 */
  const resolvePoint = (raw: Pt, anchor: Pt | null, shift: boolean): Pt => {
    const useOrtho = !!anchor && orthoLock !== shift;
    let p = useOrtho ? ortho(anchor!, raw) : raw;
    if (snapOn) {
      const r = SNAP_PX / view.scale;
      const n = nearestNode(graph, p, r);
      if (n) {
        p = { x: n.x, y: n.y };
        setSnapMark(p);
        return p;
      }
      let best: Pt | null = null;
      let bd = r;
      for (const l of docRef.current.lines) {
        const { pt } = project(p, l);
        const d = dist(p, pt);
        if (d < bd) {
          bd = d;
          best = pt;
        }
      }
      if (best) {
        p = useOrtho ? (p.y === anchor!.y ? { x: best.x, y: anchor!.y } : { x: anchor!.x, y: best.y }) : best;
        setSnapMark(p);
        return p;
      }
    }
    setSnapMark(null);
    return p;
  };

  // ── 선택 파이프라인의 끝 연장 후보 ───────────
  const pipe = doc.pipelines.find((p) => p.id === selPipe) ?? null;
  const conts = useMemo(() => {
    if (!pipe || pipe.points.length < 1) return null;
    const pts = pipe.points;
    const n = pts.length;
    return {
      start: continuationsAt(graph, pts[0], n > 1 ? pts[1] : null, joinTol),
      end: continuationsAt(graph, pts[n - 1], n > 1 ? pts[n - 2] : null, joinTol),
    };
  }, [pipe, graph, joinTol]);

  const extend = (id: string, end: EndKey, c: Continuation) => {
    updatePipe(id, (p) => {
      const chain = c.chain.map((q) => ({ x: round1(q.x), y: round1(q.y) }));
      const points = end === "end" ? simplify([...p.points, ...chain]) : simplify([...chain.reverse(), ...p.points]);
      return { ...p, points };
    });
    setHoverChain(null);
    setSelVertex(null);
  };

  const trim = (id: string, end: EndKey) => {
    const p = docRef.current.pipelines.find((x) => x.id === id);
    if (!p) return;
    if (p.points.length <= 2 && polyLength(p.points) < 5) return;
    updatePipe(id, (x) => ({ ...x, points: simplify(trimEnd(graph, x.points, end === "start", joinTol)) }));
    setSelVertex(null);
  };

  const newPipeline = (points: Pt[]): Pipeline => {
    const n = docRef.current.pipelines.length;
    const confirmedCount = docRef.current.pipelines.filter((p) => p.status === "confirmed").length;
    return {
      id: newId(),
      name: `P-${String(confirmedCount + 1).padStart(2, "0")}`,
      color: PALETTE[n % PALETTE.length],
      points,
      status: "confirmed",
      visible: true,
    };
  };

  // ── 포인터 ──────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    const t = e.target as SVGElement;
    const ds = t.dataset;
    if (e.button === 1 || e.button === 2 || tool === "pan" || spaceDown) {
      svg.setPointerCapture(e.pointerId);
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, v: view };
      return;
    }
    const p = toImage(e);

    // 연장 화살표 / 되돌리기 버튼 (click 에서 처리)
    if (ds.arrow || ds.trim) return;

    // 끝점 핸들: 드래그로 자유 연장 (Alt: 끝점 자체 이동)
    if (ds.vertex) {
      const [id, idxS] = ds.vertex.split(":");
      const pl = docRef.current.pipelines.find((x) => x.id === id)!;
      const idx = +idxS;
      const isEnd = idx === 0 || idx === pl.points.length - 1;
      svg.setPointerCapture(e.pointerId);
      setSelVertex(idx);
      if (isEnd && !e.altKey) {
        const before = docRef.current;
        const P = pl.points[idx];
        const pts = idx === 0 ? [{ ...P }, ...pl.points] : [...pl.points, { ...P }];
        setDoc({ ...before, pipelines: before.pipelines.map((x) => (x.id === id ? { ...x, points: pts } : x)) });
        drag.current = { kind: "vertex", pipeId: id, index: idx === 0 ? 0 : pts.length - 1, anchor: P, before, moved: false, temp: true };
      } else {
        const nb = pl.points[idx - 1] ?? pl.points[idx + 1] ?? null;
        drag.current = { kind: "vertex", pipeId: id, index: idx, anchor: nb, before: docRef.current, moved: false, temp: false };
      }
      return;
    }

    // 심볼 박스: 크기 조절 핸들 / 본체
    if (ds.symresize || (ds.sym && tool === "select")) {
      const id = (ds.symresize ?? ds.sym)!;
      const sym = docRef.current.symbols.find((x) => x.id === id)!;
      if (ds.sym && e.shiftKey && selPipe) {
        const isOwned = owner.get(id)?.pipeId === selPipe;
        toggleMember(selPipe, id, !isOwned);
        setStatus(`${sym.tag || sym.type} → ${isOwned ? "제외" : "귀속"}`);
        return;
      }
      svg.setPointerCapture(e.pointerId);
      setSelSym(id);
      setSelLine(null);
      drag.current = { kind: "sym", id, mode: ds.symresize ? "resize" : "move", start: p, orig: sym, before: docRef.current, moved: false };
      return;
    }

    if (tool === "box") {
      svg.setPointerCapture(e.pointerId);
      const sym: PidSymbol = { id: newId(), category: "valve", type: "", tag: "", x: round1(p.x), y: round1(p.y), w: 0, h: 0, source: "manual" };
      const before = docRef.current;
      setDoc({ ...before, symbols: [...before.symbols, sym] });
      setSelSym(sym.id);
      drag.current = { kind: "sym", id: sym.id, mode: "create", start: p, orig: sym, before, moved: false };
      return;
    }

    if (tool === "new") {
      svg.setPointerCapture(e.pointerId);
      if (ds.line) {
        // 검출된 선을 클릭 → 그 선에서 분기점까지 이어진 구간으로 새 파이프라인
        let best = -1;
        let bd = Infinity;
        for (const ge of graph.edges) {
          if (ge.lineId !== ds.line) continue;
          const d = distToPolyline(p, [graph.nodes[ge.a], graph.nodes[ge.b]]);
          if (d < bd) {
            bd = d;
            best = ge.id;
          }
        }
        if (best >= 0) {
          const ge = graph.edges[best];
          const fwd = followChain(graph, ge.a, ge.id);
          const bwd = followChain(graph, ge.b, ge.id);
          const pts = simplify([...bwd.reverse(), ...fwd]).map((q) => ({ x: round1(q.x), y: round1(q.y) }));
          const np = newPipeline(pts);
          commit({ ...docRef.current, pipelines: [...docRef.current.pipelines, np] });
          setSelPipe(np.id);
          setSelVertex(null);
          setTool("select");
          setStatus(`${np.name} 생성 — 끝의 화살표로 연장하세요`);
        }
        return;
      }
      // 빈 곳 → 드래그로 첫 구간 그리기
      const s = resolvePoint(p, null, false);
      const np = newPipeline([s, { ...s }]);
      const before = docRef.current;
      setDoc({ ...before, pipelines: [...before.pipelines, np] });
      setSelPipe(np.id);
      drag.current = { kind: "vertex", pipeId: np.id, index: 1, anchor: s, before, moved: false, temp: true };
      return;
    }

    // select 도구
    if (ds.equip) {
      setSelEquip(ds.equip);
      setSelSym(null);
      setSelLabel(null);
      setSelLine(null);
      return;
    }
    if (ds.label) {
      setSelLabel(ds.label);
      setSelSym(null);
      setSelLine(null);
      return;
    }
    if (ds.pipe) {
      setSelPipe(ds.pipe);
      setSelVertex(null);
      setSelLine(null);
      return;
    }
    if (ds.line) {
      setSelLine(ds.line);
      setSelPipe(null);
      document.getElementById(`row-${ds.line}`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    setSelPipe(null);
    setSelVertex(null);
    setSelLine(null);
    setSelSym(null);
    setSelLabel(null);
    setSelEquip(null);
    svg.setPointerCapture(e.pointerId);
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, v: view };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView({ ...d.v, tx: d.v.tx + e.clientX - d.sx, ty: d.v.ty + e.clientY - d.sy });
      return;
    }
    if (d.kind === "sym") {
      const p = toImage(e);
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      const o = d.orig;
      const next =
        d.mode === "move"
          ? { x: o.x + dx, y: o.y + dy }
          : d.mode === "resize"
            ? { w: Math.max(4, o.w + dx), h: Math.max(4, o.h + dy) }
            : { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      const r = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, round1(v)]));
      d.moved = true;
      setDoc((cur) => ({ ...cur, symbols: cur.symbols.map((x) => (x.id === d.id ? { ...x, ...r } : x)) }));
      return;
    }
    const q = resolvePoint(toImage(e), d.anchor, e.shiftKey);
    d.moved = true;
    setDoc((cur) => ({
      ...cur,
      pipelines: cur.pipelines.map((p) =>
        p.id !== d.pipeId ? p : { ...p, points: p.points.map((pt, i) => (i === d.index ? { x: round1(q.x), y: round1(q.y) } : pt)) },
      ),
    }));
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setSnapMark(null);
    if (d?.kind === "sym") {
      const sym = docRef.current.symbols.find((x) => x.id === d.id);
      if (d.mode === "create" && (!sym || sym.w < 4 || sym.h < 4)) {
        setDoc(d.before);
        setSelSym(null);
      } else if (d.moved) {
        pushHistory(d.before);
        if (d.mode === "create") setTool("select");
      }
      return;
    }
    if (!d || d.kind !== "vertex") return;
    const pl = docRef.current.pipelines.find((x) => x.id === d.pipeId);
    if (!pl) return;
    const added = pl.points[d.index];
    if (d.temp && (!d.moved || !d.anchor || dist(added, d.anchor) < 3)) {
      setDoc(d.before); // 클릭만 하고 끝 → 취소
      if (!d.before.pipelines.some((x) => x.id === d.pipeId)) setSelPipe(null);
      return;
    }
    if (!d.moved) return;
    pushHistory(d.before);
    setDoc((cur) => ({ ...cur, pipelines: cur.pipelines.map((p) => (p.id === d.pipeId ? { ...p, points: simplify(p.points) } : p)) }));
    setSelVertex(null);
  };

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const ds = (e.target as SVGElement).dataset;
    if (ds.arrow) {
      const [id, end, k] = ds.arrow.split(":");
      const c = conts?.[end as EndKey][+k];
      if (c) extend(id, end as EndKey, c);
    } else if (ds.trim) {
      const [id, end] = ds.trim.split(":");
      trim(id, end as EndKey);
    }
  };

  /** 파이프라인 구간 더블클릭 → 꼭짓점 추가 */
  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const id = (e.target as SVGElement).dataset.pipe;
    if (!id) return;
    const pl = docRef.current.pipelines.find((x) => x.id === id);
    if (!pl) return;
    const p = toImage(e);
    let bi = 1;
    let bd = Infinity;
    for (let i = 1; i < pl.points.length; i++) {
      const d = distToPolyline(p, [pl.points[i - 1], pl.points[i]]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const a = pl.points[bi - 1];
    const b = pl.points[bi];
    const { pt } = project(p, { id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y, thickness: 1, source: "manual" });
    updatePipe(id, (x) => ({ ...x, points: [...x.points.slice(0, bi), { x: round1(pt.x), y: round1(pt.y) }, ...x.points.slice(bi)] }));
    setSelVertex(bi);
  };

  // ── 심볼 (LLM 인식 / 편집) ──────────────────
  const runSymbols = async () => {
    if (docRef.current.symbols.some((x) => x.source === "manual") && !confirm("수동으로 추가/수정한 심볼도 교체됩니다. 계속할까요? (실행취소 가능)")) return;
    setSymBusy(true);
    setStatus("LLM 심볼 인식 중… 도면을 타일로 나눠 분석합니다 (1~2분)");
    try {
      const r = await fetch("/api/symbols", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: imagePath }),
      });
      const res = (await r.json()) as {
        symbols?: PidSymbol[];
        labels?: LineLabel[];
        equipment?: Equipment[];
        errors?: string[];
        error?: string;
        model?: string;
      };
      if (!r.ok) throw new Error(res.error);
      const symbols = res.symbols ?? [];
      // 라인 번호/서비스 라벨·장비: 수동으로 추가한 것은 유지
      const labels = [...docRef.current.labels.filter((l) => l.source === "manual"), ...(res.labels ?? [])];
      const equipment = [...docRef.current.equipment.filter((x) => x.source === "manual"), ...(res.equipment ?? [])];
      // 이전 수동 포함/제외 지정은 id 가 바뀌므로 초기화
      commit({
        ...docRef.current,
        symbols,
        labels,
        equipment,
        pipelines: docRef.current.pipelines.map((p) => ({ ...p, include: [], exclude: [] })),
      });
      setSelSym(null);
      setStatus(`심볼 ${symbols.length}개 · 라벨 ${res.labels?.length ?? 0}개 인식 (${res.model})${res.errors?.length ? ` · 실패 타일 ${res.errors.length}` : ""}`);
    } catch (e) {
      setStatus(`심볼 인식 실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSymBusy(false);
    }
  };

  const updateEquip = (id: string, patch: Partial<Equipment>) =>
    commit({ ...docRef.current, equipment: docRef.current.equipment.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const deleteEquip = useCallback(
    (id: string) => {
      commit({ ...docRef.current, equipment: docRef.current.equipment.filter((x) => x.id !== id) });
      setSelEquip(null);
    },
    [commit],
  );

  const updateLabel = (id: string, patch: Partial<LineLabel>) =>
    commit({ ...docRef.current, labels: docRef.current.labels.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const deleteLabel = useCallback(
    (id: string) => {
      commit({ ...docRef.current, labels: docRef.current.labels.filter((x) => x.id !== id) });
      setSelLabel(null);
    },
    [commit],
  );

  /** 인식되지 않은 라인 번호를 선택 파이프라인에 직접 추가 (가장 긴 구간 중앙에 anchor) */
  const addLineNumber = (p: Pipeline) => {
    const text = prompt("라인 번호 (예: P-232-02203-3R1BD-20\"-IC-) 또는 서비스명(ETHANE PRODUCT)", "");
    if (!text?.trim()) return;
    let bi = 1;
    let bl = -1;
    for (let i = 1; i < p.points.length; i++) {
      const L = dist(p.points[i - 1], p.points[i]);
      if (L > bl) {
        bl = L;
        bi = i;
      }
    }
    const a = p.points[bi - 1];
    const b = p.points[bi];
    const anchor = { x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) };
    const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
    const t = text.trim();
    const w = t.length * 5.2;
    const label: LineLabel = {
      id: newId(),
      kind: parseLineNumber(t) ? "line_number" : "service",
      text: t,
      ...(vertical ? { x: anchor.x - 22, y: anchor.y - w / 2, w: 14, h: w } : { x: anchor.x - w / 2, y: anchor.y - 22, w, h: 14 }),
      vertical,
      anchor,
      source: "manual",
    };
    commit({ ...docRef.current, labels: [...docRef.current.labels, label] });
    setSelLabel(label.id);
  };

  const updateSym = (id: string, patch: Partial<PidSymbol>) =>
    commit({ ...docRef.current, symbols: docRef.current.symbols.map((x) => (x.id === id ? { ...x, ...patch } : x)) });

  const deleteSym = useCallback(
    (id: string) => {
      commit({ ...docRef.current, symbols: docRef.current.symbols.filter((x) => x.id !== id) });
      setSelSym(null);
    },
    [commit],
  );

  /** 선택 파이프라인에 대해 심볼 포함/제외를 수동 지정 */
  const toggleMember = (pipeId: string, symId: string, member: boolean) => {
    updatePipe(pipeId, (p) => {
      const inc = new Set(p.include ?? []);
      const exc = new Set(p.exclude ?? []);
      if (member) {
        exc.delete(symId);
        inc.add(symId);
      } else {
        inc.delete(symId);
        exc.add(symId);
      }
      return { ...p, include: [...inc], exclude: [...exc] };
    });
  };

  // ── 작업 ────────────────────────────────────
  const regenerate = () => {
    if (!size) return;
    const kept = { ...docRef.current, pipelines: docRef.current.pipelines.filter((p) => p.status === "confirmed") };
    const cands = makeCandidates(graph, kept, size, candCount, rejected.current);
    commit({ ...kept, pipelines: [...kept.pipelines, ...cands] });
    setSelPipe(cands[0]?.id ?? null);
    setStatus(`후보 ${cands.length}개 생성`);
  };

  const deletePipe = useCallback(
    (id: string) => {
      const p = docRef.current.pipelines.find((x) => x.id === id);
      if (!p) return;
      if (p.status === "candidate") rejected.current.push(p.points);
      commit({ ...docRef.current, pipelines: docRef.current.pipelines.filter((x) => x.id !== id) });
      if (selPipe === id) setSelPipe(null);
    },
    [commit, selPipe],
  );

  const splitAtVertex = () => {
    if (!pipe || selVertex === null || selVertex <= 0 || selVertex >= pipe.points.length - 1) return;
    const a = { ...pipe, points: pipe.points.slice(0, selVertex + 1) };
    const b = { ...newPipeline(pipe.points.slice(selVertex)), name: `${pipe.name}-2`, status: pipe.status };
    commit({ ...docRef.current, pipelines: docRef.current.pipelines.flatMap((x) => (x.id === pipe.id ? [a, b] : [x])) });
    setSelVertex(null);
  };

  const deleteVertex = useCallback(() => {
    if (!pipe || selVertex === null || pipe.points.length <= 2) return;
    updatePipe(pipe.id, (x) => ({ ...x, points: x.points.filter((_, i) => i !== selVertex) }));
    setSelVertex(null);
  }, [pipe, selVertex, updatePipe]);

  const deleteLine = useCallback(
    (id: string) => {
      commit({ ...docRef.current, lines: docRef.current.lines.filter((l) => l.id !== id) });
      if (selLine === id) setSelLine(null);
    },
    [commit, selLine],
  );

  const removeShort = () => {
    const next = doc.lines.filter((l) => lineLength(l) >= minLenFilter);
    setStatus(`짧은 선 ${doc.lines.length - next.length}개 삭제`);
    commit({ ...doc, lines: next });
  };

  // ── 키보드 ──────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === "z" && !e.shiftKey) return e.preventDefault(), undo();
      if (mod && (k === "y" || (k === "z" && e.shiftKey))) return e.preventDefault(), redo();
      if (mod && k === "s") return e.preventDefault(), void save();
      if (mod) return;
      if (k === " ") return e.preventDefault(), setSpaceDown(true);
      if (k === "v") setTool("select");
      else if (k === "n") setTool("new");
      else if (k === "b") setTool("box");
      else if (k === "h") setTool("pan");
      else if (k === "f") fit();
      else if (k === "o") setOrthoLock((x) => !x);
      else if (k === "escape") {
        setSelPipe(null);
        setSelVertex(null);
        setSelLine(null);
        setSelSym(null);
        setSelLabel(null);
        setSelEquip(null);
        setTool("select");
      } else if (k === "delete" || k === "backspace") {
        if (selEquip) deleteEquip(selEquip);
        else if (selLabel) deleteLabel(selLabel);
        else if (selSym) deleteSym(selSym);
        else if (selVertex !== null) deleteVertex();
        else if (selPipe) deletePipe(selPipe);
        else if (selLine) deleteLine(selLine);
      } else if (/^[1-9]$/.test(k)) {
        const p = docRef.current.pipelines[+k - 1];
        if (p) {
          setSelPipe(p.id);
          focus(p.points);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [undo, redo, save, fit, focus, selVertex, selPipe, selLine, selSym, selLabel, selEquip, deleteVertex, deletePipe, deleteLine, deleteSym, deleteLabel, deleteEquip]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ── 파생 데이터 ─────────────────────────────
  /** 파이프라인별 포함 심볼 (라인상/분기/수동) */
  const membersOf = useMemo(() => {
    const m = new Map<string, PipeMembers>();
    for (const p of doc.pipelines) m.set(p.id, pipelineMembers(graph, p, doc.symbols));
    return m;
  }, [graph, doc.pipelines, doc.symbols]);

  /** 심볼 → 소속 파이프라인들 */
  const symOwners = useMemo(() => {
    const m = new Map<string, { pipe: Pipeline; relation: Relation }[]>();
    for (const p of doc.pipelines) {
      if (!p.visible) continue;
      for (const mem of membersOf.get(p.id)?.members ?? []) {
        const arr = m.get(mem.symbol.id) ?? [];
        arr.push({ pipe: p, relation: mem.relation });
        m.set(mem.symbol.id, arr);
      }
    }
    return m;
  }, [doc.pipelines, membersOf]);

  /** 심볼 → 귀속 파이프라인 (하나) */
  const owner = useMemo(() => resolveOwners(doc.pipelines, membersOf), [doc.pipelines, membersOf]);
  ownerRef.current = owner;

  /** 파이프라인별 연결 장비(노즐 포함) */
  const equipOf = useMemo(() => {
    const m = new Map<string, EquipConnection[]>();
    for (const p of doc.pipelines) m.set(p.id, pipelineEquipment(p, doc.equipment));
    return m;
  }, [doc.pipelines, doc.equipment]);

  /** 라벨(라인 번호/서비스) → 귀속 파이프라인, 파이프라인별 유체 정보 */
  const labelOwner = useMemo(() => assignLabels(doc.pipelines, doc.labels), [doc.pipelines, doc.labels]);
  labelOwnerRef.current = labelOwner;
  const infoOf = useMemo(() => {
    const m = new Map<string, ChemicalInfo>();
    for (const p of doc.pipelines) m.set(p.id, chemicalInfo(doc.labels.filter((l) => labelOwner.get(l.id) === p.id)));
    return m;
  }, [doc.pipelines, doc.labels, labelOwner]);
  const ownedBy = useCallback(
    (pipeId: string) => (membersOf.get(pipeId)?.members ?? []).filter((m) => owner.get(m.symbol.id)?.pipeId === pipeId),
    [membersOf, owner],
  );

  // 파이프라인을 연장/되돌려 귀속이 바뀌면 상태줄에 알린다
  const prevOwner = useRef<Map<string, Ownership> | null>(null);
  useEffect(() => {
    const prev = prevOwner.current;
    prevOwner.current = owner;
    if (!prev || prev.size === 0) return; // 최초 로드 시에는 알리지 않음
    const pname = (id?: string) => docRef.current.pipelines.find((p) => p.id === id)?.name ?? "없음";
    const changes: string[] = [];
    for (const s of docRef.current.symbols) {
      const a = prev.get(s.id)?.pipeId;
      const b = owner.get(s.id)?.pipeId;
      if (a !== b) changes.push(`${s.tag || s.type}: ${pname(a)} → ${pname(b)}`);
    }
    if (changes.length && changes.length < 40) {
      setStatus(`귀속 변경 ${changes.length}건 — ${changes.slice(0, 4).join(" · ")}${changes.length > 4 ? " …" : ""}`);
    }
  }, [owner]);

  /** 검출선 → 이 선을 지나는 파이프라인 */
  const usedBy = useMemo(() => {
    const m = new Map<string, Pipeline>();
    for (const l of doc.lines) {
      const mid = { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 };
      const p = doc.pipelines.find((pl) => pl.visible && distToPolyline(mid, pl.points) < 4);
      if (p) m.set(l.id, p);
    }
    return m;
  }, [doc]);

  const listed = useMemo(
    () =>
      doc.lines
        .filter((l) => (lineFilter === "all" ? true : lineFilter === "used" ? usedBy.has(l.id) : !usedBy.has(l.id)))
        .sort((a, b) => lineLength(b) - lineLength(a)),
    [doc.lines, lineFilter, usedBy],
  );

  const s = view.scale;
  const cursor = tool === "pan" || spaceDown ? "grab" : tool === "new" || tool === "box" ? "crosshair" : "default";
  const sym = doc.symbols.find((x) => x.id === selSym) ?? null;

  const memberList = (p: Pipeline) => {
    const pm = membersOf.get(p.id);
    if (!pm) return null;
    const owned = ownedBy(p.id);
    const shared = pm.members.filter((m) => owner.get(m.symbol.id)?.pipeId !== p.id);
    const groups: [string, typeof pm.members][] = [
      ["파이프라인 컴포넌트", owned.filter((m) => m.symbol.category !== "instrument")],
      ["인스트루먼트", owned.filter((m) => m.symbol.category === "instrument")],
    ];
    const info = infoOf.get(p.id);
    return (
      <div className="members" onClick={(e) => e.stopPropagation()}>
        <div className="chem">
          <div className="members-title">
            유체 / 라인 정보
            <button className="icon" title="라인 번호·서비스명 직접 추가" onClick={() => addLineNumber(p)}>
              ＋
            </button>
          </div>
          {info && (info.service || info.lineNumbers.length || info.unparsed.length) ? (
            <>
              <div className="chem-head">
                <span className="chem-service">{info.service ?? "(서비스명 없음)"}</span>
                {info.fluidNames.map((f) => (
                  <span key={f} className="chip">
                    {f}
                  </span>
                ))}
                {info.sizes.map((x) => (
                  <span key={x} className="chip">
                    {x}
                  </span>
                ))}
                {info.specs.map((x) => (
                  <span key={x} className="chip muted-chip" title="배관 재질 등급">
                    {x}
                  </span>
                ))}
                {info.insulations.map((x) => (
                  <span key={x} className="chip muted-chip" title="보온">
                    {x}
                  </span>
                ))}
              </div>
              {info.connectors.map((c, i) => (
                <div key={i} className="muted">
                  ⇢ {c.service} {c.fromTo} {c.ref && `(${c.ref})`}
                </div>
              ))}
              {info.lineNumbers.map((ln) => (
                <div
                  key={ln.labelId}
                  className={`member ln ${ln.labelId === selLabel ? "sel" : ""}`}
                  onClick={() => {
                    setSelLabel(ln.labelId);
                    const l = doc.labels.find((x) => x.id === ln.labelId);
                    if (l) focus([{ x: l.x - 80, y: l.y - 80 }, { x: l.x + l.w + 80, y: l.y + l.h + 80 }]);
                  }}
                  title={`${ln.fluidCode}=${ln.fluidName} · Unit ${ln.unit} · Seq ${ln.sequence} · Spec ${ln.spec} · ${ln.size} · ${ln.insulationName}`}
                >
                  <span className="rel line">라인</span>
                  <span className="mtag mono">{ln.text}</span>
                </div>
              ))}
              {info.unparsed.map((t) => (
                <div key={t} className="member ln">
                  <span className="rel manual">형식?</span>
                  <span className="mtag mono">{t}</span>
                </div>
              ))}
            </>
          ) : (
            <div className="muted">근처에 라인 번호/커넥터가 없습니다</div>
          )}
        </div>
        <div>
          <div className="members-title">
            장비 <span className="muted">{(equipOf.get(p.id) ?? []).length}</span>
          </div>
          {(equipOf.get(p.id) ?? []).map((c) => (
            <div
              key={c.equipment.id}
              className={`member equip ${c.equipment.id === selEquip ? "sel" : ""}`}
              title={c.equipment.specs.map((x) => `${x.key}: ${x.value}`).join("\n")}
              onClick={() => {
                setSelEquip(c.equipment.id);
                const e = c.equipment;
                focus([
                  { x: e.x - 40, y: e.y - 40 },
                  { x: e.x + e.w + 40, y: e.y + e.h + 40 },
                ]);
              }}
            >
              <span className="rel equipment">장비</span>
              <span className="mtag">
                {c.equipment.tag} <span className="muted">{c.equipment.name}</span>
              </span>
              <span className="nozzles">
                {c.nozzles.length ? c.nozzles.map((n) => <span key={n} className="chip">{n}</span>) : <span className="muted">외곽</span>}
              </span>
            </div>
          ))}
          {!(equipOf.get(p.id) ?? []).length && <div className="muted">연결된 장비 없음</div>}
        </div>
        {groups.map(([title, list]) => (
          <div key={title}>
            <div className="members-title">
              {title} <span className="muted">{list.length}</span>
            </div>
            {list.map(({ symbol: m, relation }) => (
              <div
                key={m.id}
                className={`member ${m.id === selSym ? "sel" : ""}`}
                onClick={() => {
                  setSelSym(m.id);
                  focus([
                    { x: m.x - 60, y: m.y - 60 },
                    { x: m.x + m.w + 60, y: m.y + m.h + 60 },
                  ]);
                }}
              >
                <span className={`rel ${relation}`}>{REL_LABEL[relation]}</span>
                <span className="mtag">{m.tag || "(태그 없음)"}</span>
                <span className="muted mtype">{m.type || CATEGORY_LABEL[m.category]}</span>
                <button className="icon danger" title="이 파이프라인에서 제외" onClick={() => toggleMember(p.id, m.id, false)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        ))}
        {shared.length > 0 && (
          <div>
            <div className="members-title muted">다른 라인에 귀속됨 {shared.length}</div>
            {shared.map(({ symbol: m }) => {
              const o = doc.pipelines.find((x) => x.id === owner.get(m.id)?.pipeId);
              return (
                <div key={m.id} className="member shared" onClick={() => setSelSym(m.id)}>
                  <span className="mtag">{m.tag || m.type || m.id}</span>
                  <span className="muted mtype" style={{ color: o?.color }}>
                    → {o?.name}
                  </span>
                  <button className="icon" title="이 라인으로 가져오기" onClick={() => toggleMember(p.id, m.id, true)}>
                    ⇦
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {pm.excluded.length > 0 && (
          <div>
            <div className="members-title muted">제외됨 {pm.excluded.length}</div>
            {pm.excluded.map((m) => (
              <div key={m.id} className="member excluded">
                <span className="mtag">{m.tag || m.type || m.id}</span>
                <button className="icon" title="다시 포함" onClick={() => toggleMember(p.id, m.id, true)}>
                  ＋
                </button>
              </div>
            ))}
          </div>
        )}
        {!doc.symbols.length && <div className="muted">심볼이 없습니다. “LLM 심볼 인식”을 실행하세요.</div>}
      </div>
    );
  };
  const linesInteractive = !spaceDown && tool !== "pan";

  const arrowPoly = (P: Pt, d: Pt) => {
    const off = 16 / s;
    const len = 14 / s;
    const w = 8 / s;
    const b = { x: P.x + d.x * off, y: P.y + d.y * off };
    const tip = { x: b.x + d.x * len, y: b.y + d.y * len };
    const n = { x: -d.y, y: d.x };
    return `${tip.x},${tip.y} ${b.x + n.x * w},${b.y + n.y * w} ${b.x - n.x * w},${b.y - n.y * w}`;
  };

  return (
    <div className="app">
      {/* ── 왼쪽: 파이프라인 ── */}
      <aside className="panel">
        <h1>P&amp;ID 파이프라인 편집기</h1>
        <section>
          <select
            value={imagePath}
            onChange={(e) => {
              if (dirty && !confirm("저장하지 않은 변경사항이 있습니다. 이동할까요?")) return;
              setImagePath(e.target.value);
            }}
          >
            {folders.map((f) => (
              <optgroup key={f.folder} label={f.folder || "(root)"}>
                {f.files.map((file) => {
                  const p = f.folder ? `${f.folder}/${file}` : file;
                  return (
                    <option key={p} value={p}>
                      {file}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
          <div className="tools">
            {(
              [
                ["select", "선택 (V)"],
                ["new", "새 라인 (N)"],
                ["box", "심볼 (B)"],
                ["pan", "이동 (H)"],
              ] as const
            ).map(([t, label]) => (
              <button key={t} className={tool === t ? "active" : ""} onClick={() => setTool(t)}>
                {label}
              </button>
            ))}
          </div>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={orthoLock} onChange={(e) => setOrthoLock(e.target.checked)} /> 직교 (O)
            </label>
            <label className="check">
              <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> 스냅
            </label>
            <button onClick={undo} disabled={!past.current.length} title="Ctrl+Z">
              ↶
            </button>
            <button onClick={redo} disabled={!future.current.length} title="Ctrl+Y">
              ↷
            </button>
            <button onClick={fit} title="F">
              ⛶
            </button>
          </div>
        </section>

        <section>
          <div className="section-head">
            <span>장비 ({doc.equipment.length})</span>
            <label className="check">
              <input type="checkbox" checked={showEquip} onChange={(e) => setShowEquip(e.target.checked)} /> 표시
            </label>
          </div>
          {doc.equipment.map((e) => {
            const pipes = doc.pipelines.filter((p) => (equipOf.get(p.id) ?? []).some((c) => c.equipment.id === e.id));
            const sel = e.id === selEquip;
            return (
              <div key={e.id} className={`equip-card ${sel ? "sel" : ""}`}>
                <div
                  className="equip-head"
                  onClick={() => {
                    setSelEquip(sel ? null : e.id);
                    focus([
                      { x: e.x - 40, y: e.y - 40 },
                      { x: e.x + e.w + 40, y: e.y + e.h + 40 },
                    ]);
                  }}
                >
                  <b>{e.tag}</b> <span className="muted">{e.name}</span>
                </div>
                <div className="muted">
                  연결: {pipes.length ? pipes.map((p) => <b key={p.id} style={{ color: p.color }}>{p.name} </b>) : "없음"}
                </div>
                {sel && (
                  <div className="sym-edit">
                    <div className="row">
                      <input defaultValue={e.tag} key={`et${e.id}`} onBlur={(ev) => ev.target.value !== e.tag && updateEquip(e.id, { tag: ev.target.value })} />
                      <button className="icon danger" title="장비 삭제 (Del)" onClick={() => deleteEquip(e.id)}>
                        ✕
                      </button>
                    </div>
                    <input defaultValue={e.name} key={`en${e.id}`} onBlur={(ev) => ev.target.value !== e.name && updateEquip(e.id, { name: ev.target.value })} />
                    <table className="specs">
                      <tbody>
                        {e.specs.map((sp, i) => (
                          <tr key={i}>
                            <th>{sp.key}</th>
                            <td>{sp.value}</td>
                          </tr>
                        ))}
                        {e.notes?.length ? (
                          <tr>
                            <th>NOTES</th>
                            <td>{e.notes.join(", ")}</td>
                          </tr>
                        ) : null}
                        <tr>
                          <th>NOZZLES</th>
                          <td>{e.nozzles.map((n) => n.name).join(", ")}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
          {!doc.equipment.length && <div className="muted">장비가 없습니다. “LLM 심볼 인식”으로 함께 추출됩니다.</div>}
        </section>

        <section>
          <div className="section-head">
            <span>
              심볼 ({doc.symbols.length})
              {doc.symbols.length > 0 && (
                <span className="muted">
                  {" "}
                  밸브 {doc.symbols.filter((x) => x.category === "valve").length} · 피팅 {doc.symbols.filter((x) => x.category === "fitting").length} · 계기{" "}
                  {doc.symbols.filter((x) => x.category === "instrument").length}
                </span>
              )}
            </span>
            <label className="check">
              <input type="checkbox" checked={showSymbols} onChange={(e) => setShowSymbols(e.target.checked)} /> 표시
            </label>
          </div>
          <button
            className="primary"
            onClick={runSymbols}
            disabled={symBusy || !size || STATIC_MODE}
            title={STATIC_MODE ? "정적 배포 모드에서는 사용할 수 없습니다 (로컬 서버 + API 키 필요)" : undefined}
          >
            {symBusy ? "LLM 인식 중…" : "LLM 심볼 인식 (밸브·계기)"}
          </button>
          {sym && (
            <div className="sym-edit">
              <div className="row">
                <select value={sym.category} onChange={(e) => updateSym(sym.id, { category: e.target.value as SymbolCategory })}>
                  {(Object.keys(CATEGORY_LABEL) as SymbolCategory[]).map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
                <button className="icon danger" title="심볼 삭제 (Del)" onClick={() => deleteSym(sym.id)}>
                  ✕
                </button>
              </div>
              <input placeholder="태그 (예: PDT 2419)" defaultValue={sym.tag} key={`t${sym.id}`} onBlur={(e) => e.target.value !== sym.tag && updateSym(sym.id, { tag: e.target.value })} />
              <input placeholder="종류 (예: gate valve)" defaultValue={sym.type} key={`y${sym.id}`} onBlur={(e) => e.target.value !== sym.type && updateSym(sym.id, { type: e.target.value })} />
              <div className="muted">
                {sym.source === "llm" ? `LLM${sym.confidence !== undefined ? ` · 신뢰도 ${Math.round(sym.confidence * 100)}%` : ""}` : "수동"}
              </div>
              <div className="muted">
                귀속:{" "}
                {(() => {
                  const o = owner.get(sym.id);
                  const p = doc.pipelines.find((x) => x.id === o?.pipeId);
                  return p ? (
                    <b style={{ color: p.color }}>
                      {p.name} ({REL_LABEL[o!.relation]})
                    </b>
                  ) : (
                    "없음"
                  );
                })()}
                {(symOwners.get(sym.id) ?? []).length > 1 &&
                  ` · 후보: ${(symOwners.get(sym.id) ?? [])
                    .filter((x) => x.pipe.id !== owner.get(sym.id)?.pipeId)
                    .map((x) => x.pipe.name)
                    .join(", ")}`}
              </div>
              {pipe && (
                <button onClick={() => toggleMember(pipe.id, sym.id, owner.get(sym.id)?.pipeId !== pipe.id)}>
                  {owner.get(sym.id)?.pipeId === pipe.id ? `${pipe.name}에서 제외` : `${pipe.name}에 귀속`} (Shift+클릭)
                </button>
              )}
            </div>
          )}
          <div className="row">
            <span className="muted">
              라벨 {doc.labels.length} (라인 번호 {doc.labels.filter((l) => l.kind === "line_number").length} · 커넥터{" "}
              {doc.labels.filter((l) => l.kind === "service").length})
            </span>
            <label className="check">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> 표시
            </label>
          </div>
          {(() => {
            const l = doc.labels.find((x) => x.id === selLabel);
            if (!l) return null;
            const parsed = l.kind === "line_number" ? parseLineNumber(l.text) : null;
            const own = doc.pipelines.find((p) => p.id === labelOwner.get(l.id));
            return (
              <div className="sym-edit">
                <div className="row">
                  <select value={l.kind} onChange={(e) => updateLabel(l.id, { kind: e.target.value as LineLabel["kind"] })}>
                    <option value="line_number">라인 번호</option>
                    <option value="service">서비스(커넥터)</option>
                  </select>
                  <button className="icon danger" title="라벨 삭제 (Del)" onClick={() => deleteLabel(l.id)}>
                    ✕
                  </button>
                </div>
                <input className="mono" defaultValue={l.text} key={`l${l.id}`} onBlur={(e) => e.target.value !== l.text && updateLabel(l.id, { text: e.target.value.trim() })} />
                {parsed ? (
                  <div className="parsed">
                    <span>유체 <b>{parsed.fluidCode}</b> {parsed.fluidName}</span>
                    <span>Unit <b>{parsed.unit}</b></span>
                    <span>Seq <b>{parsed.sequence}</b></span>
                    <span>Spec <b>{parsed.spec}</b></span>
                    <span>Size <b>{parsed.size}</b></span>
                    <span>보온 <b>{parsed.insulation}</b> {parsed.insulationName}</span>
                  </div>
                ) : l.kind === "line_number" ? (
                  <div className="muted">형식 불일치: 알파벳-숫자3-숫자5-등급-사이즈-보온</div>
                ) : (
                  <div className="muted">
                    {l.ref} {l.fromTo}
                  </div>
                )}
                <div className="muted">
                  귀속: {own ? <b style={{ color: own.color }}>{own.name}</b> : "없음 (anchor 가 파이프라인 위에 있어야 함)"}
                </div>
              </div>
            );
          })()}
        </section>

        <section className="grow">
          <div className="section-head">
            <span>
              파이프라인 ({doc.pipelines.length})
              <label className="check inline">
                <input type="checkbox" checked={expandAll} onChange={(e) => setExpandAll(e.target.checked)} /> 모두 펼치기
              </label>
            </span>
            <span className="row">
              <input type="number" className="tiny" min={1} max={30} value={candCount} onChange={(e) => setCandCount(+e.target.value)} />
              <button onClick={regenerate} disabled={!size} title="확정된 라인은 유지하고 후보만 다시 뽑습니다">
                후보 다시 뽑기
              </button>
            </span>
          </div>
          <div className="pipe-list">
            {doc.pipelines.map((p, i) => (
              <div key={p.id} className={`pipe-item ${p.id === selPipe ? "sel" : ""}`}>
              <div
                className="pipe-row"
                onClick={() => {
                  setSelPipe(p.id);
                  setSelVertex(null);
                  focus(p.points);
                }}
              >
                <input
                  type="color"
                  value={p.color}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updatePipe(p.id, (x) => ({ ...x, color: e.target.value }))}
                />
                <div className="pipe-main">
                  <input
                    className="name"
                    value={p.name}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updatePipe(p.id, (x) => ({ ...x, name: e.target.value }), false)}
                    onBlur={() => setDirty(true)}
                  />
                  <span className="muted">
                    {i < 9 ? `[${i + 1}] ` : ""}
                    {Math.round(polyLength(p.points))}px · {p.points.length}점
                    {(() => {
                      const mm = ownedBy(p.id);
                      const inst = mm.filter((m) => m.symbol.category === "instrument").length;
                      return mm.length ? ` · 컴포넌트 ${mm.length - inst} · 계기 ${inst}` : "";
                    })()}
                  </span>
                  {(() => {
                    const info = infoOf.get(p.id);
                    const first = info?.lineNumbers[0];
                    const eqs = equipOf.get(p.id) ?? [];
                    if (!info?.service && !first && !eqs.length) return null;
                    return (
                      <span className="pipe-chem" title={info?.lineNumbers.map((x) => x.text).join("\n")}>
                        {eqs.map((c) => (
                          <span key={c.equipment.id} className="eq-tag">
                            {c.equipment.tag}
                            {c.nozzles.length ? `(${c.nozzles.join(",")})` : ""}
                          </span>
                        ))}
                        {info?.service && <b> {info.service}</b>}
                        {first && <span className="mono"> {first.text}</span>}
                        {info && info.lineNumbers.length > 1 && <span className="muted"> +{info.lineNumbers.length - 1}</span>}
                      </span>
                    );
                  })()}
                </div>
                <button
                  className={`badge ${p.status}`}
                  title="후보 ↔ 확정"
                  onClick={(e) => {
                    e.stopPropagation();
                    updatePipe(p.id, (x) => ({ ...x, status: x.status === "candidate" ? "confirmed" : "candidate" }));
                  }}
                >
                  {p.status === "candidate" ? "후보" : "확정"}
                </button>
                <button
                  className="icon"
                  title="표시/숨김"
                  onClick={(e) => {
                    e.stopPropagation();
                    updatePipe(p.id, (x) => ({ ...x, visible: !x.visible }));
                  }}
                >
                  {p.visible ? "◉" : "○"}
                </button>
                <button
                  className="icon danger"
                  title="삭제"
                  onClick={(e) => {
                    e.stopPropagation();
                    deletePipe(p.id);
                  }}
                >
                  ✕
                </button>
              </div>
              {(p.id === selPipe || expandAll) && memberList(p)}
              </div>
            ))}
            {!doc.pipelines.length && <div className="muted">파이프라인이 없습니다. 후보를 뽑거나 새 라인(N)을 그리세요.</div>}
          </div>
          {pipe && (
            <div className="pipe-actions">
              <div className="muted">
                선택: <b style={{ color: pipe.color }}>{pipe.name}</b>
                {selVertex !== null && ` · 점 #${selVertex}`}
              </div>
              <div className="row">
                <button onClick={() => trim(pipe.id, "start")}>시작 −</button>
                <button onClick={() => trim(pipe.id, "end")}>끝 −</button>
                <button onClick={splitAtVertex} disabled={selVertex === null || selVertex <= 0 || selVertex >= pipe.points.length - 1}>
                  점에서 분할
                </button>
                <button onClick={deleteVertex} disabled={selVertex === null || pipe.points.length <= 2}>
                  점 삭제
                </button>
              </div>
            </div>
          )}
        </section>

        <details>
          <summary>CV 검출 / 연결 설정</summary>
          <div className="params">
            <label>
              최소 길이 <b>{params.minLen}</b>
              <input type="range" min={10} max={200} value={params.minLen} onChange={(e) => setParams({ ...params, minLen: +e.target.value })} />
            </label>
            <label>
              끊김 허용 <b>{params.gap}</b>
              <input type="range" min={0} max={50} value={params.gap} onChange={(e) => setParams({ ...params, gap: +e.target.value })} />
            </label>
            <label>
              민감도 <b>{params.sensitivity}</b>
              <input type="range" min={1} max={30} value={params.sensitivity} onChange={(e) => setParams({ ...params, sensitivity: +e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={params.hough} onChange={(e) => setParams({ ...params, hough: e.target.checked })} /> 사선 검출
            </label>
            <button
              className="primary"
              disabled={busy || STATIC_MODE}
              title={STATIC_MODE ? "정적 배포 모드에서는 사용할 수 없습니다 (로컬 서버의 Python/OpenCV 필요)" : undefined}
              onClick={() => {
                if (!confirm("검출선을 다시 만들고 후보를 새로 뽑습니다. 확정 라인은 유지됩니다.")) return;
                runDetect(imagePath, params, true);
              }}
            >
              {busy ? "검출 중…" : "선 다시 검출"}
            </button>
            <label>
              밸브 끊김 연결 간격 <b>{bridgeGap}px</b>
              <input type="range" min={0} max={200} value={bridgeGap} onChange={(e) => setBridgeGap(+e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={showBridges} onChange={(e) => setShowBridges(e.target.checked)} /> 가상 연결 표시
            </label>
          </div>
        </details>

        <details>
          <summary>표시 / 단축키</summary>
          <label>
            배경 투명도 <b>{bgOpacity.toFixed(2)}</b>
            <input type="range" min={0} max={1} step={0.05} value={bgOpacity} onChange={(e) => setBgOpacity(+e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} /> 검출선 표시
          </label>
          <ul className="help">
            <li>
              <b>▶ 화살표</b> 클릭: 검출선을 따라 다음 분기점까지 연장 (마우스 올리면 미리보기)
            </li>
            <li>
              <b>● 끝점</b> 드래그: 자유 연장 · Alt+드래그: 끝점 이동
            </li>
            <li>
              <b>⊖</b> 클릭: 끝에서 한 구간 되돌리기
            </li>
            <li>구간 더블클릭: 꼭짓점 추가 · 꼭짓점 드래그: 이동</li>
            <li>새 라인(N): 검출선 클릭 → 그 구간으로 시작, 빈 곳 드래그 → 직접 그리기</li>
            <li>
              <b>심볼 박스</b>: 실선=라인상, 파선=분기(계기 탭 등), 점선=수동 · Shift+클릭: 선택 파이프라인에 포함/제외
            </li>
            <li>심볼(B): 드래그로 박스 추가 · 박스 드래그: 이동 · 모서리: 크기</li>
            <li>Shift: 직교 일시 반전 · 1~9: 파이프라인 선택 · Del: 삭제</li>
            <li>휠: 확대 · 빈 곳/스페이스 드래그: 이동 · Ctrl+Z/Y · Ctrl+S</li>
          </ul>
        </details>

        <div className="row">
          <button className="primary" onClick={save} title={STATIC_MODE ? "이 브라우저에 저장됩니다" : undefined}>
            저장{dirty ? " *" : ""}
          </button>
          <button onClick={exportJson}>JSON 내보내기</button>
          {STATIC_MODE && (
            <button
              title="브라우저에 저장된 편집본을 지우고 배포된 시드 데이터로 되돌립니다"
              onClick={() => {
                if (!hasLocal(imagePath) && !dirty) return setStatus("이미 시드 상태입니다");
                if (!confirm("브라우저에 저장된 편집 내용을 지우고 처음 상태로 되돌릴까요?")) return;
                clearLocal(imagePath);
                window.location.reload();
              }}
            >
              초기화
            </button>
          )}
        </div>
        {STATIC_MODE && <div className="muted">정적 배포 모드 · 저장은 이 브라우저에만 보관됩니다</div>}
        <div className="status">{status}</div>
      </aside>

      {/* ── 캔버스 ── */}
      <main className="stage">
        <svg
          ref={svgRef}
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${s})`}>
            {size && <image href={imageUrl} width={size.w} height={size.h} opacity={bgOpacity} pointerEvents="none" />}

            {/* 검출선 */}
            {showLines && (
              <g style={{ pointerEvents: linesInteractive ? "auto" : "none" }}>
                {doc.lines.map((l) => {
                  const sel = l.id === selLine;
                  return (
                    <g key={l.id}>
                      <line
                        x1={l.x1}
                        y1={l.y1}
                        x2={l.x2}
                        y2={l.y2}
                        stroke={sel ? "#00c2ff" : usedBy.has(l.id) ? "#9aa3ad" : "#e5484d"}
                        strokeOpacity={sel ? 1 : 0.55}
                        strokeWidth={sel ? 4 : 1.5}
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      <line data-line={l.id} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="transparent" strokeWidth={8} vectorEffect="non-scaling-stroke" />
                    </g>
                  );
                })}
              </g>
            )}
            {showBridges &&
              graph.edges
                .filter((e) => e.virtual)
                .map((e) => (
                  <line
                    key={`b${e.id}`}
                    x1={graph.nodes[e.a].x}
                    y1={graph.nodes[e.a].y}
                    x2={graph.nodes[e.b].x}
                    y2={graph.nodes[e.b].y}
                    stroke="#d000ff"
                    strokeWidth={3}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                ))}

            {/* 장비 박스 + 노즐 + 상단 데이터 블록 */}
            {showEquip && (
              <g style={{ pointerEvents: linesInteractive && tool === "select" ? "auto" : "none" }}>
                {doc.equipment.map((e) => {
                  const conn = pipe ? (equipOf.get(pipe.id) ?? []).find((c) => c.equipment.id === e.id) : undefined;
                  const color = conn ? pipe!.color : EQUIP_COLOR;
                  const sel = e.id === selEquip;
                  return (
                    <g key={e.id}>
                      {e.header && (
                        <>
                          <rect
                            x={e.header.x - 4}
                            y={e.header.y - 4}
                            width={e.header.w + 8}
                            height={e.header.h + 8}
                            fill={EQUIP_COLOR}
                            fillOpacity={sel ? 0.12 : 0.05}
                            stroke={EQUIP_COLOR}
                            strokeDasharray="4 3"
                            strokeWidth={sel ? 2 : 1}
                            vectorEffect="non-scaling-stroke"
                            data-equip={e.id}
                            style={{ cursor: "pointer" }}
                          />
                          {sel && (
                            <line
                              x1={e.header.x + e.header.w / 2}
                              y1={e.header.y + e.header.h + 4}
                              x2={e.x + e.w / 2}
                              y2={e.y}
                              stroke={EQUIP_COLOR}
                              strokeDasharray="6 4"
                              vectorEffect="non-scaling-stroke"
                              pointerEvents="none"
                            />
                          )}
                        </>
                      )}
                      <rect
                        x={e.x}
                        y={e.y}
                        width={e.w}
                        height={e.h}
                        fill={color}
                        fillOpacity={conn ? 0.08 : 0.04}
                        stroke={sel ? "#0070f3" : color}
                        strokeWidth={sel ? 3.5 : conn ? 3 : 2}
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      {/* 외곽선만 클릭 대상 (내부 배관 선택을 막지 않도록) */}
                      <rect data-equip={e.id} x={e.x} y={e.y} width={e.w} height={e.h} fill="none" stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" style={{ cursor: "pointer" }}>
                        <title>{`${e.tag} ${e.name}\n` + e.specs.map((x) => `${x.key}: ${x.value}`).join("\n")}</title>
                      </rect>
                      <text data-equip={e.id} x={e.x + 4 / s} y={e.y - 5 / s} fontSize={13 / s} fill={color} className="plabel" style={{ cursor: "pointer" }}>
                        {e.tag} · {e.name}
                      </text>
                      {e.nozzles.map((n) => {
                        const on = !!conn?.nozzles.includes(n.name);
                        return (
                          <g key={n.name} pointerEvents="none">
                            <circle cx={n.x} cy={n.y} r={(on ? 6 : 3.5) / s} fill={on ? color : "#fff"} stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                            {(on || sel || s > 0.6) && (
                              <text x={n.x + 7 / s} y={n.y - 5 / s} fontSize={(on ? 12 : 10) / s} fill={color} className="slabel">
                                {n.name}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            )}

            {/* 라인 번호 / 서비스 라벨 */}
            {showLabels && (
              <g style={{ pointerEvents: linesInteractive && tool === "select" ? "auto" : "none" }}>
                {doc.labels.map((l) => {
                  const ownP = doc.pipelines.find((p) => p.id === labelOwner.get(l.id));
                  const dim = !!selPipe && ownP?.id !== selPipe;
                  const color = ownP ? ownP.color : l.kind === "line_number" ? "#f76b15" : "#8e4ec6";
                  const sel = l.id === selLabel;
                  const cx = l.x + l.w / 2;
                  const cy = l.y + l.h / 2;
                  return (
                    <g key={l.id} opacity={dim ? 0.35 : 1}>
                      {l.anchor && (
                        <>
                          <line x1={cx} y1={cy} x2={l.anchor.x} y2={l.anchor.y} stroke={color} strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                          <circle cx={l.anchor.x} cy={l.anchor.y} r={3 / s} fill={color} pointerEvents="none" />
                        </>
                      )}
                      <rect
                        data-label={l.id}
                        x={l.x - 2}
                        y={l.y - 2}
                        width={l.w + 4}
                        height={l.h + 4}
                        rx={2}
                        fill={ownP ? color : "transparent"}
                        fillOpacity={ownP ? 0.1 : 1}
                        stroke={sel ? "#0070f3" : color}
                        strokeWidth={sel ? 2.5 : ownP ? 1.8 : 1.2}
                        strokeDasharray={l.kind === "service" ? "4 2" : undefined}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "pointer" }}
                      >
                        <title>
                          {`${l.kind === "line_number" ? "라인 번호" : "서비스"}: ${l.text}` +
                            (l.fromTo ? `\n${l.fromTo}` : "") +
                            `\n귀속: ${ownP?.name ?? "없음"}`}
                        </title>
                      </rect>
                    </g>
                  );
                })}
              </g>
            )}

            {/* 파이프라인 */}
            <g style={{ pointerEvents: linesInteractive && tool === "select" ? "auto" : "none" }}>
              {doc.pipelines
                .filter((p) => p.visible)
                .map((p) => {
                  const sel = p.id === selPipe;
                  const d = p.points.map((q) => `${q.x},${q.y}`).join(" ");
                  return (
                    <g key={p.id}>
                      <polyline
                        points={d}
                        fill="none"
                        stroke={p.color}
                        strokeOpacity={sel ? 0.85 : 0.55}
                        strokeWidth={sel ? 7 : 5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeDasharray={p.status === "candidate" ? "14 6" : undefined}
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      <polyline data-pipe={p.id} points={d} fill="none" stroke="transparent" strokeWidth={14} vectorEffect="non-scaling-stroke" style={{ cursor: "pointer" }} />
                      {p.points[0] && (
                        <text x={p.points[0].x + 8 / s} y={p.points[0].y - 8 / s} fontSize={13 / s} fill={p.color} className="plabel" pointerEvents="none">
                          {p.name}
                        </text>
                      )}
                    </g>
                  );
                })}
            </g>

            {/* 심볼 박스 (LLM 인식 / 수동) */}
            {showSymbols && (
              <g style={{ pointerEvents: linesInteractive && tool === "select" ? "auto" : "none" }}>
                {doc.symbols.map((m) => {
                  const owners = symOwners.get(m.id) ?? [];
                  const o = owner.get(m.id);
                  const ownPipe = o ? doc.pipelines.find((x) => x.id === o.pipeId) : undefined;
                  // 파이프라인을 선택했을 때 다른 라인 소속 심볼은 흐리게
                  const dim = !!selPipe && !!o && o.pipeId !== selPipe;
                  const own = ownPipe && !dim ? { pipe: ownPipe, relation: o!.relation } : undefined;
                  const excludedHere = !!pipe && !!pipe.exclude?.includes(m.id);
                  const color = ownPipe ? ownPipe.color : SYM_GRAY;
                  const sel = m.id === selSym;
                  // 태그 없는 밸브의 종류명까지 모두 띄우면 겹치므로, 태그가 있거나 선택된 것만 표시
                  const showLabel = sel || (!!m.tag && (!!own || s > 0.45));
                  return (
                    <g key={m.id}>
                      <rect
                        data-sym={m.id}
                        x={m.x}
                        y={m.y}
                        width={m.w}
                        height={m.h}
                        fill={own ? color : "transparent"}
                        fillOpacity={own ? 0.14 : 1}
                        stroke={sel ? "#0070f3" : color}
                        strokeOpacity={own || sel ? 1 : dim ? 0.35 : 0.75}
                        strokeWidth={sel ? 3 : own ? 2.5 : 1.2}
                        strokeDasharray={excludedHere ? "2 3" : own?.relation === "branch" ? "5 3" : own?.relation === "manual" ? "1 2" : undefined}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "pointer" }}
                      >
                        <title>
                          {`${CATEGORY_LABEL[m.category]} · ${m.tag || "(태그 없음)"} · ${m.type}\n` +
                            (owners.length ? owners.map((o) => `${o.pipe.name}: ${REL_LABEL[o.relation]}`).join("\n") : "소속 파이프라인 없음") +
                            (pipe ? `\nShift+클릭: ${pipe.name}에 포함/제외` : "")}
                        </title>
                      </rect>
                      {showLabel && (
                        <text x={m.x} y={m.y - 3 / s} fontSize={10 / s} fill={sel ? "#0070f3" : color} className="slabel" pointerEvents="none">
                          {m.tag || m.type}
                        </text>
                      )}
                      {sel && (
                        <rect
                          data-symresize={m.id}
                          x={m.x + m.w - 4 / s}
                          y={m.y + m.h - 4 / s}
                          width={8 / s}
                          height={8 / s}
                          fill="#fff"
                          stroke="#0070f3"
                          strokeWidth={2}
                          vectorEffect="non-scaling-stroke"
                          style={{ cursor: "nwse-resize" }}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            )}

            {hoverChain && pipe && (
              <polyline
                points={hoverChain.map((q) => `${q.x},${q.y}`).join(" ")}
                fill="none"
                stroke={pipe.color}
                strokeWidth={5}
                strokeDasharray="6 5"
                strokeOpacity={0.9}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}

            {/* 선택 파이프라인 핸들 */}
            {pipe && pipe.visible && tool !== "pan" && (
              <g>
                {pipe.points.map((q, i) => {
                  const isEnd = i === 0 || i === pipe.points.length - 1;
                  return (
                    <circle
                      key={i}
                      data-vertex={`${pipe.id}:${i}`}
                      cx={q.x}
                      cy={q.y}
                      r={(isEnd ? 7 : 4.5) / s}
                      fill={isEnd ? pipe.color : i === selVertex ? "#0070f3" : "#fff"}
                      stroke={i === selVertex ? "#0070f3" : isEnd ? "#fff" : pipe.color}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      style={{ cursor: isEnd ? "copy" : "move" }}
                    >
                      <title>{isEnd ? "드래그: 연장 · Alt+드래그: 이동" : "드래그: 이동 · Del: 삭제"}</title>
                    </circle>
                  );
                })}
                {conts &&
                  (["start", "end"] as const).map((end) => {
                    const n = pipe.points.length;
                    const P = end === "start" ? pipe.points[0] : pipe.points[n - 1];
                    const Q = end === "start" ? pipe.points[1] : pipe.points[n - 2];
                    const back = Q ? unit({ x: Q.x - P.x, y: Q.y - P.y }) : null;
                    return (
                      <g key={end}>
                        {conts[end].map((c, k) => (
                          <polygon
                            key={k}
                            data-arrow={`${pipe.id}:${end}:${k}`}
                            points={arrowPoly(P, c.dir)}
                            fill={pipe.color}
                            stroke="#fff"
                            strokeWidth={1.5}
                            vectorEffect="non-scaling-stroke"
                            className="arrow"
                            onPointerEnter={() => setHoverChain([P, ...c.chain])}
                            onPointerLeave={() => setHoverChain(null)}
                          >
                            <title>클릭: 이 방향으로 연장</title>
                          </polygon>
                        ))}
                        {back && (
                          <g className="trim">
                            <circle
                              data-trim={`${pipe.id}:${end}`}
                              cx={P.x + back.x * (24 / s)}
                              cy={P.y + back.y * (24 / s)}
                              r={7 / s}
                              fill="#fff"
                              stroke="#e5484d"
                              strokeWidth={2}
                              vectorEffect="non-scaling-stroke"
                            >
                              <title>클릭: 끝 한 구간 되돌리기</title>
                            </circle>
                            <line
                              x1={P.x + back.x * (24 / s) - 3.5 / s}
                              x2={P.x + back.x * (24 / s) + 3.5 / s}
                              y1={P.y + back.y * (24 / s)}
                              y2={P.y + back.y * (24 / s)}
                              stroke="#e5484d"
                              strokeWidth={2}
                              vectorEffect="non-scaling-stroke"
                              pointerEvents="none"
                            />
                          </g>
                        )}
                      </g>
                    );
                  })}
              </g>
            )}

            {snapMark && <circle cx={snapMark.x} cy={snapMark.y} r={9 / s} fill="none" stroke="#d000ff" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          </g>
        </svg>
        <div className="zoom">{Math.round(s * 100)}%</div>
      </main>

      {/* ── 오른쪽: 검출선 목록 ── */}
      <aside className="panel right">
        <div className="section-head">
          <span>검출선 ({doc.lines.length})</span>
          <select className="tiny-select" value={lineFilter} onChange={(e) => setLineFilter(e.target.value as typeof lineFilter)}>
            <option value="all">전체</option>
            <option value="free">미사용</option>
            <option value="used">사용중</option>
          </select>
        </div>
        <div className="row">
          <span className="muted">길이 &lt;</span>
          <input type="number" className="tiny" value={minLenFilter} onChange={(e) => setMinLenFilter(+e.target.value)} />
          <button onClick={removeShort}>짧은 선 삭제</button>
        </div>
        <div className="line-list" ref={listRef}>
          {listed.map((l) => {
            const u = usedBy.get(l.id);
            return (
              <div
                key={l.id}
                id={`row-${l.id}`}
                className={`line-row ${l.id === selLine ? "sel" : ""}`}
                onClick={() => {
                  setSelLine(l.id);
                  setSelPipe(null);
                  focus([
                    { x: l.x1, y: l.y1 },
                    { x: l.x2, y: l.y2 },
                  ]);
                }}
              >
                <span className="kind">{kindOf(l)}</span>
                <span className="lid">{l.id}</span>
                <span className="len">{Math.round(lineLength(l))}</span>
                <span className="use" title={u?.name}>
                  {u ? <i style={{ background: u.color }} /> : null}
                </span>
                <button
                  className="icon danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteLine(l.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
