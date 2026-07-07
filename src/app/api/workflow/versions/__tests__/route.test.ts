import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();

vi.mock("fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, POST } from "../route";

function getReq(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/workflow/versions");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url } as unknown as NextRequest;
}

function postReq(body: unknown): NextRequest {
  return { json: vi.fn().mockResolvedValue(body) } as unknown as NextRequest;
}

describe("GET /api/workflow/versions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists versions newest-first with size", async () => {
    mockReaddir.mockResolvedValue(["1000.json", "3000.json", "2000.json", "notes.txt"]);
    mockStat.mockResolvedValue({ size: 42 });

    const res = await GET(getReq({ directoryPath: "/work/proj", filename: "my flow" }));
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.versions.map((v: { id: string }) => v.id)).toEqual(["3000", "2000", "1000"]);
    expect(data.versions[0]).toMatchObject({ timestamp: 3000, size: 42 });
  });

  it("returns empty when the versions folder is absent", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const res = await GET(getReq({ directoryPath: "/work/proj", filename: "wf" }));
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.versions).toEqual([]);
  });

  it("rejects an invalid path without reading the filesystem", async () => {
    const res = await GET(getReq({ directoryPath: "relative", filename: "wf" }));
    expect(res.status).toBe(400);
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("requires directoryPath and filename", async () => {
    const res = await GET(getReq({ directoryPath: "/work/proj" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/workflow/versions (restore)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the parsed workflow for a valid version id", async () => {
    mockReadFile.mockResolvedValue('{"version":1,"nodes":[],"edges":[]}');

    const res = await POST(postReq({ directoryPath: "/work/proj", filename: "wf", versionId: "1700000000000" }));
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.workflow).toMatchObject({ version: 1 });
  });

  it("rejects a non-numeric versionId (path escape guard)", async () => {
    const res = await POST(postReq({ directoryPath: "/work/proj", filename: "wf", versionId: "../../etc/passwd" }));
    expect(res.status).toBe(400);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("rejects an invalid directory path", async () => {
    const res = await POST(postReq({ directoryPath: "relative", filename: "wf", versionId: "1000" }));
    expect(res.status).toBe(400);
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
