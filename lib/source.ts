// 데이터 출처: 로컬 서버(API + 파이썬) 또는 정적 배포(public/drawings + 브라우저 저장소)
import type { ImageFolder, LineDoc } from "./types";

/** Amplify 등 정적 배포: NEXT_PUBLIC_STATIC_MODE=1 로 빌드 */
export const STATIC_MODE = process.env.NEXT_PUBLIC_STATIC_MODE === "1";

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const storageKey = (p: string) => `pnid-editor:${p}`;

export async function listImages(): Promise<ImageFolder[]> {
  const r = await fetch(STATIC_MODE ? "/drawings/manifest.json" : "/api/images");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export const imageUrlFor = (p: string) => (STATIC_MODE ? `/drawings/${enc(p)}` : `/api/image?path=${encodeURIComponent(p)}`);

/** 정적 모드: 브라우저에 저장된 편집본 → 없으면 배포에 포함된 시드 */
export async function loadDoc(p: string): Promise<LineDoc | null> {
  if (!STATIC_MODE) {
    const r = await fetch(`/api/lines?path=${encodeURIComponent(p)}`);
    return r.ok ? r.json() : null;
  }
  try {
    const local = localStorage.getItem(storageKey(p));
    if (local) return JSON.parse(local);
  } catch {
    // 저장소 접근 불가(사생활 보호 모드 등) → 시드 사용
  }
  const r = await fetch(`/drawings/${enc(p.replace(/\.[^.]+$/, ""))}.lines.json`);
  return r.ok ? r.json() : null;
}

export async function saveDoc(doc: LineDoc): Promise<string> {
  if (!STATIC_MODE) {
    const r = await fetch("/api/lines", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error);
    return res.file;
  }
  try {
    localStorage.setItem(storageKey(doc.image), JSON.stringify({ ...doc, updatedAt: new Date().toISOString() }));
  } catch (e) {
    throw new Error(`브라우저 저장소에 저장하지 못했습니다 (${e instanceof Error ? e.message : e}). JSON 내보내기를 사용하세요`);
  }
  return "브라우저 저장소";
}

/** 정적 모드: 브라우저 편집본을 지우고 시드로 되돌린다 */
export function clearLocal(p: string) {
  try {
    localStorage.removeItem(storageKey(p));
  } catch {
    // 무시
  }
}

export function hasLocal(p: string): boolean {
  try {
    return !!localStorage.getItem(storageKey(p));
  } catch {
    return false;
  }
}
