import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { IMAGES_ROOT, PYTHON, safeJoin } from "@/lib/paths";

export const runtime = "nodejs";
export const maxDuration = 600;

const SCRIPT = path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "detect_symbols.py");

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))));
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { path: string };
  try {
    const file = safeJoin(IMAGES_ROOT, body.path);
    const raw = await run([SCRIPT, file]);
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
