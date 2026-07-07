/**
 * Workflow Versions API
 *
 * Lists and restores the rolling snapshots the save route writes to
 * `<dir>/.versions/<name>/<epochMs>.json`. Gives workflows an on-disk,
 * cross-session history — undo/redo only lives in memory.
 */
import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";
import { validateWorkflowPath } from "@/utils/pathValidation";
import { VERSIONS_DIR } from "../route";

export interface WorkflowVersion {
  id: string; // epoch-ms filename stem — also the restore key
  timestamp: number;
  size: number;
}

function safeName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9-_]/g, "_");
}

// Reject a version id that isn't a plain epoch-ms stem (prevents path escape)
function isValidVersionId(id: string): boolean {
  return /^\d+$/.test(id);
}

// GET: list versions for a workflow, newest first
export async function GET(request: NextRequest) {
  const directoryPath = request.nextUrl.searchParams.get("directoryPath");
  const filename = request.nextUrl.searchParams.get("filename");

  if (!directoryPath || !filename) {
    return NextResponse.json(
      { success: false, error: "directoryPath and filename are required" },
      { status: 400 }
    );
  }

  const pathValidation = validateWorkflowPath(directoryPath);
  if (!pathValidation.valid) {
    return NextResponse.json(
      { success: false, error: pathValidation.error || "Invalid path" },
      { status: 400 }
    );
  }

  const versionsFolder = path.join(directoryPath, VERSIONS_DIR, safeName(filename));

  try {
    const names = await fs.readdir(versionsFolder);
    const versions = (
      await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .map(async (n): Promise<WorkflowVersion | null> => {
            const id = n.slice(0, -".json".length);
            if (!isValidVersionId(id)) return null;
            try {
              const stat = await fs.stat(path.join(versionsFolder, n));
              return { id, timestamp: Number(id), size: stat.size };
            } catch {
              return null;
            }
          })
      )
    )
      .filter((v): v is WorkflowVersion => v !== null)
      .sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ success: true, versions });
  } catch {
    // Folder doesn't exist yet → no versions
    return NextResponse.json({ success: true, versions: [] });
  }
}

// POST: return a specific version's workflow JSON for the client to load
export async function POST(request: NextRequest) {
  let directoryPath: string | undefined;
  try {
    const body = await request.json();
    directoryPath = body.directoryPath;
    const filename: string | undefined = body.filename;
    const versionId: string | undefined = body.versionId;

    if (!directoryPath || !filename || !versionId) {
      return NextResponse.json(
        { success: false, error: "directoryPath, filename, and versionId are required" },
        { status: 400 }
      );
    }

    const pathValidation = validateWorkflowPath(directoryPath);
    if (!pathValidation.valid) {
      return NextResponse.json(
        { success: false, error: pathValidation.error || "Invalid path" },
        { status: 400 }
      );
    }

    if (!isValidVersionId(versionId)) {
      return NextResponse.json(
        { success: false, error: "Invalid versionId" },
        { status: 400 }
      );
    }

    const versionPath = path.join(directoryPath, VERSIONS_DIR, safeName(filename), `${versionId}.json`);
    const contents = await fs.readFile(versionPath, "utf-8");
    const workflow = JSON.parse(contents);

    return NextResponse.json({ success: true, workflow });
  } catch (error) {
    logger.error(
      "file.error",
      "Failed to restore workflow version",
      { directoryPath },
      error instanceof Error ? error : undefined
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Restore failed" },
      { status: 500 }
    );
  }
}
