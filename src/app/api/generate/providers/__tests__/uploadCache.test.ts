import { describe, it, expect, vi, beforeEach } from "vitest";
import { cachedUpload, clearUploadCache } from "../uploadCache";

describe("cachedUpload", () => {
  beforeEach(() => {
    clearUploadCache();
  });

  it("uploads identical content only once", async () => {
    const upload = vi.fn().mockResolvedValue("https://cdn.example.com/a.png");

    const url1 = await cachedUpload("fal", "key", "same-bytes", upload);
    const url2 = await cachedUpload("fal", "key", "same-bytes", upload);

    expect(url1).toBe("https://cdn.example.com/a.png");
    expect(url2).toBe("https://cdn.example.com/a.png");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent uploads of the same content", async () => {
    let resolveUpload!: (url: string) => void;
    const upload = vi.fn(
      () => new Promise<string>((resolve) => { resolveUpload = resolve; })
    );

    const p1 = cachedUpload("fal", "key", "same-bytes", upload);
    const p2 = cachedUpload("fal", "key", "same-bytes", upload);
    resolveUpload("https://cdn.example.com/a.png");

    expect(await p1).toBe("https://cdn.example.com/a.png");
    expect(await p2).toBe("https://cdn.example.com/a.png");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("uploads separately for different content, provider, or API key", async () => {
    const upload = vi.fn().mockResolvedValue("https://cdn.example.com/x.png");

    await cachedUpload("fal", "key", "bytes-a", upload);
    await cachedUpload("fal", "key", "bytes-b", upload);
    await cachedUpload("kie", "key", "bytes-a", upload);
    await cachedUpload("fal", "other-key", "bytes-a", upload);

    expect(upload).toHaveBeenCalledTimes(4);
  });

  it("retries after a failed upload", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("https://cdn.example.com/a.png");

    await expect(cachedUpload("fal", "key", "bytes", upload)).rejects.toThrow("network");
    await expect(cachedUpload("fal", "key", "bytes", upload)).resolves.toBe(
      "https://cdn.example.com/a.png"
    );
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
