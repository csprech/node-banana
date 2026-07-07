import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to define mocks that work with hoisted vi.mock
const { mockGenerateVideos, mockGetVideosOperation, MockGoogleGenAI } = vi.hoisted(() => {
  const mockGenerateVideos = vi.fn();
  const mockGetVideosOperation = vi.fn();

  class MockGoogleGenAI {
    apiKey: string;
    models = {
      generateContent: vi.fn(),
      generateVideos: mockGenerateVideos,
    };
    operations = {
      getVideosOperation: mockGetVideosOperation,
    };

    constructor(config: { apiKey: string }) {
      this.apiKey = config.apiKey;
      MockGoogleGenAI.lastCalledWith = config;
    }

    static lastCalledWith: { apiKey: string } | null = null;
    static reset() {
      MockGoogleGenAI.lastCalledWith = null;
    }
  }

  return { mockGenerateVideos, mockGetVideosOperation, MockGoogleGenAI };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: MockGoogleGenAI,
}));

// Mock global fetch for video download
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { submitGeminiVideoTask, checkGeminiVideoTaskOnce } from "../gemini";

const OP_NAME = "models/veo-3.1/operations/abc123";

describe("submitGeminiVideoTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockGoogleGenAI.reset();
  });

  it("submits a text-to-video and returns the operation name as taskId", async () => {
    mockGenerateVideos.mockResolvedValue({ name: OP_NAME, done: false });

    const { taskId } = await submitGeminiVideoTask(
      "test-001",
      "test-api-key",
      "veo-3.1/text-to-video",
      "A cat playing piano",
      [],
      { aspectRatio: "16:9", durationSeconds: "8" }
    );

    expect(taskId).toBe(OP_NAME);
    expect(mockGenerateVideos).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "veo-3.1-generate-preview",
        prompt: "A cat playing piano",
        config: expect.objectContaining({ numberOfVideos: 1, aspectRatio: "16:9", durationSeconds: 8 }),
      })
    );
  });

  it("passes a base64 image for image-to-video models", async () => {
    mockGenerateVideos.mockResolvedValue({ name: OP_NAME });

    await submitGeminiVideoTask(
      "test-003",
      "test-api-key",
      "veo-3.1/image-to-video",
      "Animate this image",
      ["data:image/png;base64,iVBORw0KGgo="],
      {}
    );

    expect(mockGenerateVideos).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.objectContaining({ imageBytes: "iVBORw0KGgo=", mimeType: "image/png" }),
      })
    );
  });

  it("maps veo-3.1-fast models to the correct API model ID", async () => {
    mockGenerateVideos.mockResolvedValue({ name: OP_NAME });

    await submitGeminiVideoTask(
      "test-007",
      "test-api-key",
      "veo-3.1-fast/image-to-video",
      "test",
      ["data:image/jpeg;base64,abc123"],
      {}
    );

    expect(mockGenerateVideos).toHaveBeenCalledWith(
      expect.objectContaining({ model: "veo-3.1-fast-generate-preview" })
    );
  });

  it("passes seed, negativePrompt, and resolution parameters", async () => {
    mockGenerateVideos.mockResolvedValue({ name: OP_NAME });

    await submitGeminiVideoTask(
      "test-008",
      "test-api-key",
      "veo-3.1/text-to-video",
      "test",
      [],
      { seed: 42, negativePrompt: "blurry, low quality", resolution: "1080p" }
    );

    expect(mockGenerateVideos).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ seed: 42, negativePrompt: "blurry, low quality", resolution: "1080p" }),
      })
    );
  });

  it("throws on an unknown model", async () => {
    await expect(
      submitGeminiVideoTask("test-004", "test-api-key", "unknown-model", "p", [], {})
    ).rejects.toThrow("Unknown Veo model");
  });

  it("throws when an image-to-video model has no image", async () => {
    await expect(
      submitGeminiVideoTask("test-009", "test-api-key", "veo-3.1/image-to-video", "p", [], {})
    ).rejects.toThrow("Image required");
  });

  it("throws when submission returns no operation name", async () => {
    mockGenerateVideos.mockResolvedValue({ done: false });
    await expect(
      submitGeminiVideoTask("test-010", "test-api-key", "veo-3.1/text-to-video", "p", [], {})
    ).rejects.toThrow("no operation name");
  });
});

describe("checkGeminiVideoTaskOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockGoogleGenAI.reset();
  });

  it("resumes the operation by name and returns processing while not done", async () => {
    mockGetVideosOperation.mockResolvedValue({ done: false });

    const result = await checkGeminiVideoTaskOnce("test-p1", "test-api-key", OP_NAME);

    expect(result.status).toBe("processing");
    expect(mockGetVideosOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: expect.objectContaining({ name: OP_NAME }) })
    );
  });

  it("downloads the video and returns completed when done", async () => {
    mockGetVideosOperation.mockResolvedValue({
      done: true,
      response: { generatedVideos: [{ video: { uri: "https://example.com/video?id=456" } }] },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([0x00, 0x01]).buffer),
    });

    const result = await checkGeminiVideoTaskOnce("test-p2", "test-api-key", OP_NAME);

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.outputs![0].type).toBe("video");
      expect(result.result.outputs![0].data).toMatch(/^data:video\/mp4;base64,/);
    }
  });

  it("returns failed when the operation errors", async () => {
    mockGetVideosOperation.mockResolvedValue({ done: true, error: { message: "safety filtered" } });

    const result = await checkGeminiVideoTaskOnce("test-p3", "test-api-key", OP_NAME);

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("safety filtered");
  });

  it("returns failed when no videos are generated", async () => {
    mockGetVideosOperation.mockResolvedValue({ done: true, response: { generatedVideos: [] } });

    const result = await checkGeminiVideoTaskOnce("test-p4", "test-api-key", OP_NAME);

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("No video generated");
  });

  it("throws when the video download fails (so the client can retry)", async () => {
    mockGetVideosOperation.mockResolvedValue({
      done: true,
      response: { generatedVideos: [{ video: { uri: "https://example.com/video?id=fail" } }] },
    });
    mockFetch.mockResolvedValue({ ok: false, status: 403 });

    await expect(
      checkGeminiVideoTaskOnce("test-p5", "test-api-key", OP_NAME)
    ).rejects.toThrow("Failed to download generated video");
  });
});
