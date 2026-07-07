/**
 * Assets API Route
 *
 * Lists the media assets persisted on disk for a workflow — the files under
 * its `generations/` (AI output) and `inputs/` (user uploads) folders. Returns
 * lightweight metadata only (id, folder, type, size, mtime); the browser loads
 * the actual bytes on demand via /api/load-generation or /api/workflow-images.
 *
 * This is the durable, cross-session backing for the asset library panel — the
 * in-session GlobalImageHistory only remembers the current session.
 */
import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";
import { validateWorkflowPath } from "@/utils/pathValidation";

export type AssetType = "image" | "video" | "audio";

export interface AssetEntry {
  id: string; // filename without extension — the imageId used by load endpoints
  filename: string;
  folder: "generations" | "inputs";
  type: AssetType;
  ext: string;
  size: number;
  mtime: number; // epoch ms, for newest-first sorting
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "aac"]);

function classify(ext: string): AssetType | null {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

async function listFolder(
  workflowPath: string,
  folder: "generations" | "inputs"
): Promise<AssetEntry[]> {
  const dir = path.join(workflowPath, folder);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // folder may not exist yet
  }

  const entries = await Promise.all(
    names.map(async (filename): Promise<AssetEntry | null> => {
      const dot = filename.lastIndexOf(".");
      if (dot <= 0) return null;
      const ext = filename.slice(dot + 1).toLowerCase();
      const type = classify(ext);
      if (!type) return null;

      try {
        const stat = await fs.stat(path.join(dir, filename));
        if (!stat.isFile()) return null;
        return {
          id: filename.slice(0, dot),
          filename,
          folder,
          type,
          ext,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      } catch {
        return null;
      }
    })
  );

  return entries.filter((e): e is AssetEntry => e !== null);
}

export async function GET(request: NextRequest) {
  const workflowPath = request.nextUrl.searchParams.get("workflowPath");

  if (!workflowPath) {
    return NextResponse.json(
      { success: false, error: "workflowPath is required" },
      { status: 400 }
    );
  }

  const pathValidation = validateWorkflowPath(workflowPath);
  if (!pathValidation.valid) {
    logger.warn("file.error", "Asset list failed: invalid path", {
      workflowPath,
      error: pathValidation.error,
    });
    return NextResponse.json(
      { success: false, error: pathValidation.error || "Invalid path" },
      { status: 400 }
    );
  }

  try {
    const [generations, inputs] = await Promise.all([
      listFolder(workflowPath, "generations"),
      listFolder(workflowPath, "inputs"),
    ]);

    const assets = [...generations, ...inputs].sort((a, b) => b.mtime - a.mtime);

    return NextResponse.json({ success: true, assets });
  } catch (error) {
    logger.error(
      "file.error",
      "Failed to list assets",
      { workflowPath },
      error instanceof Error ? error : undefined
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "List failed" },
      { status: 500 }
    );
  }
}
