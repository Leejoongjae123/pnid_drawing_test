# P&ID 파이프라인 편집기

`../images/` 의 도면 이미지에서 OpenCV로 선을 검출해 배경 위에 겹쳐 보여주고,
검출선을 연결 그래프로 만들어 **파이프라인 후보(기본 5개)** 를 자동으로 뽑은 뒤
끝의 화살표/점으로 연장·되돌리기 하며 다듬는 Next.js 캔버스 툴.

## 파이프라인 검토 패널 (HAZOP Step 2.2 분류)

오른쪽 패널은 SERiD HAZOP Step 2.2 "Process interpretation & review" 구성을 따른다 (`components/ReviewPanel.tsx`, `lib/hazop.ts`).

| 단계 | 내용 |
| --- | --- |
| A Documents | 도면 번호·제목, 이 라인에 쓰인 범례 규칙(유체·보온 코드, 확인 필요), Unit 도면 목록 |
| B Components | Equipment · Lines · Valves · Fittings · Loops · Interlocks · Relief — 행마다 신뢰도(Conf.)와 상태 |
| C Connectivity | From → To (장비 노즐 / 오프페이지 커넥터, 커넥터 FROM/TO 로 흐름 방향), 커넥터 상대 도면 해결, 분기 요소 |
| D Chemicals | 서비스 코드·서비스명 → 후보 화학물질 → 엔지니어 지정 → 참고 물성 |
| E Conditions | 장비 데이터 블록의 DP/DT, OP/OT(H&MB 미등록 → Ask user) |
| F Review | 완료 기준 F1–F9, 신뢰도 높은 레코드 일괄 확인, 승인 |

- 계기 태그를 ISA 5.1 로 해석해 **측정 변수 첫 글자 + 번호**로 루프를 묶는다 (TT/TI/TIC 2415 + TCV 2415 → Loop T-2415, Control loop)
- 인터록: 보팅 로직·셧다운·핸드 스위치 (PSD, HS …), 릴리프: 안전밸브·파열판 (PSV, PVSV, PSE …)
- 상태: 신뢰도 ≥ 85% Confirm(확인 후보) · 60–84% Review · < 60% Ask user, 검토자가 누르면 Confirmed. `reviews` 로 저장
- 커넥터 도면 번호는 `drawing.register`(Unit 도면 목록)로 해결, 다른 Unit 도면이면 Gap
- 화학물질 물성은 문헌 참고값 — SERiD DB(DIPPR)·KOSHA 노출기준으로 확인 전까지 확정값 아님
- JSON 내보내기: 파이프라인마다 `hazop` (from/to, components, connectivity, chemicals, conditions, checks)

## 배포 (AWS Amplify, 정적 데모 모드)

`amplify.yml` 이 `NEXT_PUBLIC_STATIC_MODE=1` 로 빌드한다. 이 모드에서는

- 도면·시드 데이터: `public/drawings/manifest.json`, `public/drawings/<폴더>/<파일>.png`, `<파일>.lines.json`
- 저장: 브라우저 localStorage (**초기화** 버튼으로 시드 복원), 결과 공유는 **JSON 내보내기**
- CV 선 재검출 / LLM 심볼 인식은 비활성 (Python·OpenCV·API 키가 있는 로컬 서버에서만 동작)

도면을 추가하려면 로컬에서 편집·저장한 `data/<폴더>/<파일>.lines.json` 과 이미지를 `public/drawings/` 에 넣고
`manifest.json` 에 파일명을 추가한다.

> 이 저장소에는 프론트엔드만 있다. 로컬 서버 모드에 필요한 `scripts/`(Python 검출·시드 스크립트)는 포함하지 않았다.

## 실행 (로컬 서버 모드)

```bash
pip install opencv-python numpy   # 최초 1회
npm install
npm run dev                        # http://localhost:3000
```

환경 변수(선택): `IMAGES_DIR`(이미지 루트), `DATA_DIR`(저장 위치, 기본 `./data`), `PYTHON`(파이썬 실행 파일).

## 화면

- **왼쪽**: 파이프라인 목록(후보/확정, 색, 이름, 표시, 삭제), 후보 다시 뽑기, 검출/연결 설정
- **가운데**: 도면 + 검출선(빨강=미사용, 회색=파이프라인에 포함) + 파이프라인(점선=후보, 실선=확정)
- **오른쪽**: 검출선 전체 목록(길이순, 사용중/미사용 필터, 개별 삭제)

## 편집

| 조작 | 동작 |
| --- | --- |
| 끝의 **▶ 화살표** 클릭 | 검출선 그래프를 따라 다음 분기점까지 연장 (hover 시 미리보기) |
| 끝의 **● 점** 드래그 | 자유 연장 (직교 고정 + 노드/선 스냅), Alt+드래그는 끝점 이동 |
| 끝 안쪽 **⊖** 클릭 | 끝에서 한 구간(그래프 노드 하나) 되돌리기 |
| 구간 더블클릭 / 꼭짓점 드래그 | 꼭짓점 추가 / 이동, Del 로 점 삭제, "점에서 분할" |
| 새 라인(N) | 검출선 클릭 → 그 구간으로 시작, 빈 곳 드래그 → 직접 그리기 |
| 후보 삭제 | 삭제한 후보는 "후보 다시 뽑기" 에서 다시 나오지 않음 |

## 심볼(밸브·피팅·계기) 인식

`.env.local.example` → `.env.local` 로 복사해 `ANTHROPIC_API_KEY` 를 넣은 뒤 서버를 재시작하고, 왼쪽의 **LLM 심볼 인식** 을 누른다.

- `scripts/detect_symbols.py`: 도면을 1000px 타일(150px 겹침, page_002 기준 12장)로 나눠 Claude 비전(기본 `claude-opus-5-5`, `LLM_MODEL` 로 변경)에
  tool-use(JSON 스키마)로 질의 → 타일 좌표를 전체 좌표로 변환 → 겹침 구간 중복 제거(잘린 박스보다 온전한 박스 우선)
- 결과는 저장 파일의 `symbols` 에 들어가므로 한 번만 돌리면 된다. 박스는 이동/크기조절/삭제/추가(B)·태그/종류 수정 가능

**page_002 시드**: API 키 없이 바로 쓸 수 있도록 `data/Unit 232 (1)/page_002.lines.json` 에 심볼 190개
(밸브·피팅·계기)가 미리 들어 있다. 비전 LLM(Claude)이 격자 타일을 직접 판독한 목록(`scripts/seed_symbols_page002.py`)을
CV 로 실제 잉크 픽셀에 맞춰 보정한 것. 다시 만들려면
`python scripts/seed_symbols_page002.py <page_002.png> <out.json>`.

**귀속**: 심볼 하나는 파이프라인 하나에만 귀속된다. 우선순위 수동 > 라인상 > 분기, 같으면 확정 > 후보.
파이프라인을 연장/되돌리면 자동으로 다시 계산되고 상태줄에 "귀속 변경" 이 표시된다.
다른 라인에 귀속된 심볼은 목록의 "다른 라인에 귀속됨" 에서 ⇦ 로 가져올 수 있다.
저장/내보내기 파일의 각 심볼에는 `pipelineId`, `relation` 이 기록된다.

### 장비 (EQUIPMENT)

도면 상단 장비 데이터 블록(태그·명칭·SURFACE AREA·DESIGN PRESSURE·DESIGN TEMPERATURE·NOTE)을 읽고,
도면 내부에서 그 태그를 품은 사각형 외곽을 검출선에서 찾아 박스로 만든다(page_002 시드: E-232-002, E-232-003,
`scripts/seed_equipment_page002.py`). 노즐(B1, B4, A2A, A2B, B2A, B2B, A4 / A1, A3, B3, MW …)도 함께 저장.
LLM 인식 시에는 `equipment`(외곽+노즐) · `equipment_data`(상단 블록)를 태그로 합쳐 추출한다.

- 연결 판정 (`lib/equipment.ts`): 파이프라인이 장비 외곽을 지나는 지점 또는 외곽 25px 이내에서 끝나는 지점 →
  30px 이내의 가장 가까운 노즐. 장비는 여러 파이프라인에 동시에 연결될 수 있다
- 왼쪽: 장비 카드(사양 표·노즐·연결 파이프라인), 파이프라인 펼치면 "장비" 항목에 태그 + 노즐 칩
- 캔버스: 청록 박스 + 노즐 점(연결된 노즐은 크게), 선택 시 상단 데이터 블록과 점선으로 연결
- 내보내기 `children` 에 `{kind:"equipment", tag, name, type, nozzles, relation, specs}` 추가

### 라인 번호 / 유체(chemical) 정보

배관 옆의 `알파벳-숫자3-숫자5-등급-사이즈-보온` 라벨(예: `P-232-02203-3R1BD-20"-IC-`)과
오프페이지 커넥터의 서비스명(예: `ETHANE PRODUCT … TO E-235-002`)을 라벨로 저장한다
(page_002 시드: 라인 번호 19 + 커넥터 13, `scripts/seed_labels_page002.py`; LLM 인식 시 `labels` 로 함께 추출).

- 파싱 (`lib/labels.ts`): 유체 코드(P=Process, CHL=Chemical liquid, NG=Nitrogen …) · Unit · Seq · Spec · Size · 보온(IC/N …)
- 귀속: 라벨의 anchor(지시선 끝)가 파이프라인 위 10px 이내면 그 파이프라인. 커넥터는 파이프라인 끝점 60px 이내도 인정
- 왼쪽 파이프라인 목록: 서비스명 + 대표 라인 번호, 펼치면 "유체 / 라인 정보"(칩: 유체·사이즈·등급·보온, 커넥터 FROM/TO)
- ＋ 로 누락된 라인 번호/서비스명을 직접 추가
- 내보내기: 파이프라인마다 `children` = `[{kind:"chemical",…}, {kind:"equipment",…}, {kind:"line_number",…}, {kind:"component",…}, {kind:"instrument",…}]`

포함 판정 (`lib/symbols.ts`):

| 관계 | 조건 | 캔버스 |
| --- | --- | --- |
| 라인상 | 파이프라인 폴리라인이 박스를 관통 (밸브, 리듀서 …) | 실선 박스, 라인 색 |
| 분기 | 파이프라인 밖 검출선을 따라 계기 150px / 밸브·피팅 60px 이내로 닿음, 또는 박스가 파이프라인에서 계기 32px / 밸브 18px 이내 | 파선 박스 |
| 수동 | Shift+클릭 / 목록에서 직접 포함 | 점선 박스 |

파이프라인을 연장/되돌리면 포함 요소가 즉시 다시 계산되고, 왼쪽 목록에서 파이프라인을 선택하면
**파이프라인 컴포넌트 / 인스트루먼트** 로 나뉘어 진행 순서대로 표시된다. ✕ 로 제외, ＋ 로 복원.
JSON 내보내기에는 파이프라인별 `components` 가 포함된다.

## 구조

| 경로 | 역할 |
| --- | --- |
| `scripts/detect_lines.py` | 적응형 이진화 → 수평/수직 모폴로지 추출 → 동일 축 선분 병합 → (옵션) Hough 사선 |
| `lib/graph.ts` | 검출선 → 그래프(끝점/T자 접점 병합, 밸브로 끊긴 구간 가상 연결), 후보 추적, 연장/되돌리기 |
| `components/Editor.tsx` | SVG 캔버스 편집기 |
| `app/api/*` | 이미지 목록/파일, 검출 실행, 저장/불러오기 (`data/<폴더>/<파일>.lines.json`) |

후보 추적 규칙: 긴 선분을 씨앗으로 양방향 추적(분기점에서는 직진만), 닫힌 도형(장비 외곽·도면 틀)과
꺾임/밸브가 없는 직선(표 칸선)은 제외, 길이×꺾임 수로 점수화.

테스트: `node scripts/test_graph.ts <lines.json> <out.json>`
