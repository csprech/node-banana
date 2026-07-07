import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockReaddir = vi.fn();
const mockStat = vi.fn();

vi.mock("fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "../route";

function createGetRequest(workflowPath?: string): NextRequest {
  const url = new URL("http://localhost/api/assets");
  if (workflowPath !== undefined) url.searchParams.set("workflowPath", workflowPath);
  return { nextUrl: url } as unknown as NextRequest;
}

function fileStat(size = 100, mtimeMs = 1000) {
  return { isFile: () => true, size, mtimeMs };
}

describe("/api/assets route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists image/video/audio assets from both folders, newest first", async () => {
    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/generations")) return ["a_hash.png", "clip_hash.mp4", "notes.txt"];
      if (dir.endsWith("/inputs")) return ["ref_hash.jpg"];
      return [];
    });
    mockStat.mockImplementation(async (p: string) => {
      if (p.endsWith("clip_hash.mp4")) return fileStat(2048, 3000);
      if (p.endsWith("a_hash.png")) return fileStat(500, 2000);
      if (p.endsWith("ref_hash.jpg")) return fileStat(300, 1000);
      return fileStat();
    });

    const response = await GET(createGetRequest("/work/project"));
    const data = await response.json();

    expect(data.success).toBe(true);
    // .txt is ignored; 3 media files remain, sorted by mtime desc
    expect(data.assets.map((a: { id: string }) => a.id)).toEqual(["clip_hash", "a_hash", "ref_hash"]);
    expect(data.assets[0]).toMatchObject({ type: "video", folder: "generations", ext: "mp4" });
    expect(data.assets[2]).toMatchObject({ type: "image", folder: "inputs", ext: "jpg" });
  });

  it("returns empty list when folders do not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const response = await GET(createGetRequest("/work/project"));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.assets).toEqual([]);
  });

  it("requires workflowPath", async () => {
    const response = await GET(createGetRequest());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("rejects an invalid (relative) path without touching the filesystem", async () => {
    const response = await GET(createGetRequest("relative/path"));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(mockReaddir).not.toHaveBeenCalled();
  });
});
