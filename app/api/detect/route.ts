import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { DETECT_SCRIPT, IMAGES_ROOT, PYTHON, safeJoin } from "@/lib/paths";
import type { DetectParams, LineDoc } from "@/lib/types";

export const runtime = "nodejs";

function runPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { path: string; params: DetectParams };
  try {
    const file = safeJoin(IMAGES_ROOT, body.path);
    const p = body.params;
    const raw = await runPython([
      DETECT_SCRIPT,
      file,
      "--min-len", String(Math.round(p.minLen)),
      "--gap", String(Math.round(p.gap)),
      "--sensitivity", String(Math.round(p.sensitivity)),
      "--hough", p.hough ? "1" : "0",
    ]);
    const doc = JSON.parse(raw) as Omit<LineDoc, "image">;
    return NextResponse.json({ ...doc, image: body.path } satisfies LineDoc);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
