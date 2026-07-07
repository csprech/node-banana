/**
 * Content-hash-keyed cache for provider media uploads.
 *
 * The same reference image often feeds many nodes and is re-run repeatedly;
 * without this, every run re-uploads identical bytes to the provider CDN.
 * Caching the upload promise (not just the URL) also dedupes concurrent
 * uploads of the same asset within a parallel workflow level.
 *
 * In-memory, per-process — cleared on server restart, same trade-off as the
 * existing fal schema-mapping cache.
 */

import crypto from "crypto";

const uploadCache = new Map<string, { url: Promise<string>; timestamp: number }>();
const UPLOAD_CACHE_TTL = 30 * 60 * 1000; // 30 minutes, matches fal schema cache
const MAX_ENTRIES = 500; // ponytail: coarse full-clear eviction; LRU if this ever matters

/** Clear the upload cache (exported for testing) */
export function clearUploadCache() {
  uploadCache.clear();
}

/**
 * Run `upload` once per unique (provider, apiKey, content) and reuse the
 * resulting URL for subsequent calls. Failed uploads are evicted so the
 * next call retries.
 */
export function cachedUpload(
  provider: string,
  apiKey: string | null,
  content: string,
  upload: () => Promise<string>
): Promise<string> {
  // apiKey is part of the key: different keys may map to different provider accounts
  const key = crypto
    .createHash("sha256")
    .update(`${provider}:${apiKey ?? ""}:`)
    .update(content)
    .digest("hex");

  const cached = uploadCache.get(key);
  if (cached && Date.now() - cached.timestamp < UPLOAD_CACHE_TTL) {
    return cached.url;
  }

  if (uploadCache.size >= MAX_ENTRIES) {
    uploadCache.clear();
  }

  const promise = upload().catch((error) => {
    uploadCache.delete(key);
    throw error;
  });
  uploadCache.set(key, { url: promise, timestamp: Date.now() });
  return promise;
}
