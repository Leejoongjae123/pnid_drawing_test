import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { IMAGES_ROOT } from "@/lib/paths";
import type { ImageFolder } from "@/lib/types";

export const runtime = "nodejs";

const IMG_EXT = /\.(png|jpe?g|bmp|tiff?)$/i;

export async function GET() {
  const out: ImageFolder[] = [];
  const entries = await fs.readdir(IMAGES_ROOT, { withFileTypes: true });
  const rootFiles = entries.filter((e) => e.isFile() && IMG_EXT.test(e.name)).map((e) => e.name);
  if (rootFiles.length) out.push({ folder: "", files: rootFiles.sort() });
  for (const e of entries.filter((e) => e.isDirectory())) {
    const files = (await fs.readdir(path.join(/*turbopackIgnore: true*/ IMAGES_ROOT, e.name))).filter((f) => IMG_EXT.test(f));
    if (files.length) out.push({ folder: e.name, files: files.sort() });
  }
  return NextResponse.json(out);
}
