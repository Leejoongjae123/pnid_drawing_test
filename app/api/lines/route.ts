import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { linesFileFor } from "@/lib/paths";
import type { LineDoc } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path");
  if (!rel) return NextResponse.json({ error: "path required" }, { status: 400 });
  try {
    const text = await fs.readFile(linesFileFor(rel), "utf-8");
    return NextResponse.json(JSON.parse(text));
  } catch {
    // 저장된 결과가 없음
    return NextResponse.json(null);
  }
}

export async function PUT(req: NextRequest) {
  const doc = (await req.json()) as LineDoc;
  if (!doc?.image) return NextResponse.json({ error: "image required" }, { status: 400 });
  const file = linesFileFor(doc.image);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const saved = { ...doc, updatedAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(saved, null, 2), "utf-8");
  return NextResponse.json({ ok: true, file, updatedAt: saved.updatedAt });
}
