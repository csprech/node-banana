import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockStat = vi.fn();
const mockAccess = vi.fn();
const mockReadFile = vi.fn();

vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  access: (...args: unknown[]) => mockAccess(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST } from "../route";

function createMockPostRequest(body: unknown): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe("/api/load-generation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should load a file by id from a valid directory", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    // First candidate extension (png) exists
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from("image-bytes"));

    const response = await POST(
      createMockPostRequest({ directoryPath: "/test/generations", imageId: "abc123" })
    );
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.contentType).toBe("image");
    expect(data.image).toContain("data:image/png;base64,");
  });

  it("should reject a relative directoryPath", async () => {
    const response = await POST(
      createMockPostRequest({ directoryPath: "generations", imageId: "abc123" })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("should reject a directoryPath in a blocked system directory", async () => {
    const response = await POST(
      createMockPostRequest({ directoryPath: "/etc", imageId: "abc123" })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("should reject an imageId containing path traversal", async () => {
    const response = await POST(
      createMockPostRequest({
        directoryPath: "/test/generations",
        imageId: "../../secrets/key",
      })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
