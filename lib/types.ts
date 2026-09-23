export type LineSource = "cv" | "manual" | "edited";

export interface Line {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  source: LineSource;
}

export interface Pipeline {
  id: string;
  name: string;
  color: string;
  points: { x: number; y: number }[];
  status: "candidate" | "confirmed";
  visible: boolean;
  /** 자동 판정을 덮어쓰는 수동 포함/제외 심볼 id */
  include?: string[];
  exclude?: string[];
  /** D Chemicals: 엔지니어가 지정한 화학물질 id */
  chemicals?: string[];
}

export type SymbolCategory = "valve" | "fitting" | "instrument" | "other";

export interface PidSymbol {
  id: string;
  category: SymbolCategory;
  type: string;
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
  source: "llm" | "manual";
  /** 저장 시점의 귀속 파이프라인 (편집기에서는 매번 다시 계산) */
  pipelineId?: string | null;
  relation?: "inline" | "branch" | "manual" | null;
}

/** 배관 옆 텍스트: 라인 번호(P-232-02203-3R1BD-20"-IC-) 또는 오프페이지 커넥터의 서비스명 */
export interface LineLabel {
  id: string;
  kind: "line_number" | "service";
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  vertical?: boolean;
  /** 라벨이 가리키는 배관 위 지점 (지시선 끝) */
  anchor?: { x: number; y: number };
  /** service: 커넥터의 도면 번호 / 출처·목적지 */
  ref?: string;
  fromTo?: string;
  source: "llm" | "manual";
  pipelineId?: string | null;
}

/** 장비 (열교환기, 용기, 펌프 …). 사양은 도면 상단 장비 데이터 블록에서 읽는다 */
export interface Equipment {
  id: string;
  tag: string; // E-232-002
  name: string; // FEED-RESIDUE GAS EXCHANGER
  type: string; // heat exchanger
  x: number;
  y: number;
  w: number;
  h: number;
  specs: { key: string; value: string }[];
  notes?: string[];
  /** 상단 데이터 블록 위치 */
  header?: { x: number; y: number; w: number; h: number };
  nozzles: { name: string; x: number; y: number }[];
  source: "llm" | "manual";
}

export interface LineDoc {
  image: string;
  width: number;
  height: number;
  lines: Line[];
  pipelines?: Pipeline[];
  symbols?: PidSymbol[];
  labels?: LineLabel[];
  equipment?: Equipment[];
  /** 도면 정보 (A Documents) */
  drawing?: { no?: string; title?: string; unit?: string; register?: { file: string; dwg_no: string; title: string }[] };
  /** 레코드별 검토 상태 (key → Confirmed / Ask user) */
  reviews?: Record<string, { status: "Confirmed" | "Ask user"; at: string }>;
  updatedAt?: string;
}

export interface DetectParams {
  minLen: number;
  gap: number;
  sensitivity: number;
  hough: boolean;
}

export interface ImageFolder {
  folder: string;
  files: string[];
}
