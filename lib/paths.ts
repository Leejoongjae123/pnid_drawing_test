import path from "node:path";

// 기본값: line-editor 의 상위 폴더에 있는 images/
// 로컬 서버 전용 경로 (정적 배포에서는 쓰지 않음) — 번들러가 프로젝트 전체를 추적하지 않도록 무시 주석을 단다
export const IMAGES_ROOT = path.resolve(/*turbopackIgnore: true*/ process.env.IMAGES_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "..", "images"));
export const DATA_ROOT = path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data"));
export const PYTHON = process.env.PYTHON ?? "python";
export const DETECT_SCRIPT = path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "detect_lines.py");

/** root 밖으로 벗어나는 경로(../ 등)를 차단한다. */
export function safeJoin(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("invalid path");
  }
  return full;
}

export function linesFileFor(imageRel: string): string {
  return safeJoin(DATA_ROOT, imageRel.replace(/\.[^.\\/]+$/, "") + ".lines.json");
}
