/**
 * Shared task-polling primitives for submit+poll providers.
 *
 * Each provider exposes:
 *   submit*Task(...)    — submit the job, return a task handle immediately
 *   check*TaskOnce(...) — one short status check, fetching media on completion
 *
 * The client polls /api/generate/poll with short-lived requests instead of
 * holding one HTTP connection open for the whole generation.
 */

import { GenerationOutput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";

export type TaskCheckResult =
  | { status: "processing" }
  | { status: "failed"; error: string }
  | { status: "completed"; result: GenerationOutput };

const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB
const LARGE_VIDEO_THRESHOLD_MB = 20;

/**
 * Download a provider output URL and convert it to a typed GenerationOutput.
 * Shared by fal/Replicate/WaveSpeed completion paths:
 * - 3D models return the URL directly (binary GLB, never base64)
 * - videos over 20MB return the URL directly
 * - everything else is returned as a base64 data URL
 */
export async function fetchMediaOutput(
  requestId: string,
  mediaUrl: string,
  capabilities: string[]
): Promise<GenerationOutput> {
  if (capabilities.some((c) => c.includes("3d"))) {
    console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
    return { success: true, outputs: [{ type: "3d", data: "", url: mediaUrl }] };
  }

  // Validate URL before fetching (SSRF protection)
  const urlCheck = validateMediaUrl(mediaUrl);
  if (!urlCheck.valid) {
    return { success: false, error: `Invalid media URL: ${urlCheck.error}` };
  }

  console.log(`[API:${requestId}] Fetching output from: ${mediaUrl.substring(0, 80)}...`);
  const response = await fetch(mediaUrl);
  if (!response.ok) {
    return { success: false, error: `Failed to fetch output: ${response.status}` };
  }

  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  if (!isNaN(contentLength) && contentLength > MAX_MEDIA_SIZE) {
    return {
      success: false,
      error: `Media too large: ${(contentLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit`,
    };
  }

  const isVideoModel = capabilities.some((c) => c.includes("video"));
  const isAudioModel = capabilities.some((c) => c.includes("audio"));

  const rawContentType = response.headers.get("content-type") || "";
  const isConcreteMedia =
    rawContentType.startsWith("audio/") ||
    rawContentType.startsWith("video/") ||
    rawContentType.startsWith("image/");
  const contentType = isConcreteMedia
    ? rawContentType
    : isVideoModel
      ? "video/mp4"
      : isAudioModel
        ? "audio/mpeg"
        : "image/png";

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_MEDIA_SIZE) {
    return {
      success: false,
      error: `Media too large: ${(buffer.byteLength / (1024 * 1024)).toFixed(0)}MB > 500MB limit`,
    };
  }
  const sizeMB = buffer.byteLength / (1024 * 1024);
  console.log(`[API:${requestId}] Output: ${contentType}, ${sizeMB.toFixed(2)}MB`);

  const isVideo = contentType.startsWith("video/");
  if (isVideo && sizeMB > LARGE_VIDEO_THRESHOLD_MB) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return { success: true, outputs: [{ type: "video", data: "", url: mediaUrl }] };
  }

  const base64 = Buffer.from(buffer).toString("base64");
  const type = contentType.startsWith("audio/") ? "audio" : isVideo ? "video" : "image";
  console.log(`[API:${requestId}] SUCCESS - Returning ${type}`);
  return {
    success: true,
    outputs: [{ type, data: `data:${contentType};base64,${base64}`, url: mediaUrl }],
  };
}
