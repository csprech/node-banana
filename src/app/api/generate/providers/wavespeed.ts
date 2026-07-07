/**
 * WaveSpeed Provider for Generate API Route
 *
 * Handles image/video generation using WaveSpeed API.
 * Uses submit + client-poll: submitWaveSpeedTask creates the task and returns
 * immediately; the client polls /api/generate/poll which calls
 * checkWaveSpeedTaskOnce until the task settles.
 */

import { GenerationInput } from "@/lib/providers/types";
import { validateMediaUrl } from "@/utils/urlValidation";
import { fetchMediaOutput, TaskCheckResult } from "./taskPolling";

const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";

type WaveSpeedStatus = "created" | "pending" | "processing" | "completed" | "failed";

/**
 * WaveSpeed submit response
 * Format: { code: 200, message: "success", data: { id, model, status, urls, created_at } }
 */
interface WaveSpeedSubmitResponse {
  code?: number;
  message?: string;
  data?: {
    id: string;
    model?: string;
    status?: WaveSpeedStatus;
    urls?: {
      get?: string;
    };
    created_at?: string;
  };
  // Fallback fields for other response formats
  id?: string;
  status?: WaveSpeedStatus;
  error?: string;
}

/**
 * WaveSpeed prediction/poll response (inner data object)
 */
interface WaveSpeedPredictionData {
  id: string;
  status: WaveSpeedStatus;
  outputs?: string[];
  output?: {
    images?: string[];
    videos?: string[];
  };
  timings?: {
    inference?: number;
  };
  created_at?: string;
  error?: string;
}

/**
 * WaveSpeed prediction/poll response wrapper
 * Format: { code: 200, message: "success", data: { id, status, outputs, ... } }
 */
interface WaveSpeedPredictionResponse {
  code?: number;
  message?: string;
  data?: WaveSpeedPredictionData;
  // Fallback: some responses might have fields at top level
  id?: string;
  status?: WaveSpeedStatus;
  outputs?: string[];
  error?: string;
}

/**
 * Build the poll URL for a WaveSpeed task, preferring the API-provided URL
 * when it passes SSRF validation.
 */
export function buildWaveSpeedPollUrl(taskId: string, providedPollUrl?: string): string {
  if (providedPollUrl) {
    const pollUrlCheck = validateMediaUrl(providedPollUrl);
    if (pollUrlCheck.valid && providedPollUrl.startsWith("https://api.wavespeed.ai")) {
      return providedPollUrl;
    }
  }
  return `${WAVESPEED_API_BASE}/predictions/${taskId}/result`;
}

/**
 * Submit a WaveSpeed task and return its ID immediately.
 * Throws on submission failure.
 */
export async function submitWaveSpeedTask(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<{ taskId: string; pollUrl: string }> {
  console.log(`[API:${requestId}] WaveSpeed generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;

  // Validate modelId to prevent path traversal
  if (/[^a-zA-Z0-9\-_/.]/.test(modelId) || modelId.includes('..')) {
    throw new Error(`Invalid model ID: ${modelId}`);
  }

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Build WaveSpeed payload — spread parameters first so explicit prompt wins
  const payload: Record<string, unknown> = {
    ...input.parameters,
    prompt: input.prompt,
  };

  // Apply dynamic inputs (schema-mapped connections)
  // These have the correct parameter names from the schema (e.g., "images" for edit models)
  if (hasDynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        // If the key is "images" and value is not an array, wrap it
        if (key === "images" && !Array.isArray(value)) {
          payload[key] = [value];
        } else if (key !== "images" && Array.isArray(value)) {
          // Unwrap array to single value for non-array params
          payload[key] = value[0];
        } else {
          payload[key] = value;
        }
      }
    }
  } else if (input.images && input.images.length > 0) {
    // Fallback: if no dynamic inputs but images array is provided
    // Use "image" for single image (default WaveSpeed format)
    payload.image = input.images[0];
  }

  console.log(`[API:${requestId}] Submitting to WaveSpeed with inputs: ${Object.keys(payload).join(", ")}`);

  // Submit task
  // Model ID goes directly in the URL path (slashes are part of the path)
  const submitUrl = `${WAVESPEED_API_BASE}/${modelId}`;
  console.log(`[API:${requestId}] WaveSpeed submit URL: ${submitUrl}`);

  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.error || errorJson.message || errorJson.detail || errorText || `HTTP ${submitResponse.status}`;
    } catch {
      // Keep original text
    }

    console.error(`[API:${requestId}] WaveSpeed submit failed: ${submitResponse.status} - ${errorDetail}`);

    if (submitResponse.status === 429) {
      throw new Error(`${input.model.name || 'WaveSpeed'}: Rate limit exceeded. Try again in a moment.`);
    }

    throw new Error(`${input.model.name || 'WaveSpeed'}: ${errorDetail}`);
  }

  const submitResult: WaveSpeedSubmitResponse = await submitResponse.json();
  console.log(`[API:${requestId}] WaveSpeed submit response:`, JSON.stringify(submitResult).substring(0, 500));

  const taskId = submitResult.data?.id || submitResult.id;
  if (!taskId) {
    console.error(`[API:${requestId}] No task ID in WaveSpeed submit response`);
    throw new Error("WaveSpeed: No task ID returned from API");
  }

  const pollUrl = buildWaveSpeedPollUrl(taskId, submitResult.data?.urls?.get);
  console.log(`[API:${requestId}] WaveSpeed task submitted: ${taskId}, poll URL: ${pollUrl}`);

  return { taskId, pollUrl };
}

/**
 * Check a WaveSpeed task once. Fetches media on completion.
 * Throws on transient poll failures so the client can retry.
 * Status flow: created → processing → completed/failed (404 = not ready yet).
 */
export async function checkWaveSpeedTaskOnce(
  requestId: string,
  apiKey: string,
  pollUrl: string,
  modelName: string,
  capabilities: string[]
): Promise<TaskCheckResult> {
  const pollResponse = await fetch(pollUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  console.log(`[API:${requestId}] WaveSpeed poll: ${pollResponse.status} from ${pollUrl}`);

  // 404 means result not ready yet - continue polling
  if (pollResponse.status === 404) {
    return { status: "processing" };
  }

  if (!pollResponse.ok) {
    const errorText = await pollResponse.text();
    let errorDetail = errorText || `HTTP ${pollResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.error || errorJson.message || errorJson.detail || errorDetail;
    } catch {
      // Keep original text
    }
    console.error(`[API:${requestId}] WaveSpeed poll failed: ${pollResponse.status} - ${errorDetail}`);
    throw new Error(`${modelName}: ${errorDetail}`);
  }

  const pollData: WaveSpeedPredictionResponse = await pollResponse.json();
  console.log(`[API:${requestId}] WaveSpeed poll data:`, JSON.stringify(pollData).substring(0, 300));

  // Extract status from nested data object (WaveSpeed wraps response in { code, message, data: {...} })
  const currentStatus = pollData.data?.status || pollData.status;
  const currentError = pollData.data?.error || pollData.error;

  if (currentStatus === "failed") {
    const failureReason = currentError || pollData.message || "Generation failed";
    console.error(`[API:${requestId}] WaveSpeed task failed: ${failureReason}`);
    return { status: "failed", error: `${modelName}: ${failureReason}` };
  }

  if (currentStatus !== "completed") {
    // "created", "pending", "processing" — keep polling
    return { status: "processing" };
  }

  // Extract outputs - WaveSpeed wraps response in { code, message, data: { outputs: [...] } }
  const isVideoModel = capabilities.some((c) => c.includes("video"));
  let outputUrls: string[] = [];
  const resultDataInner = pollData.data;

  // Format 1: data.outputs array (standard WaveSpeed format)
  if (resultDataInner?.outputs && Array.isArray(resultDataInner.outputs) && resultDataInner.outputs.length > 0) {
    outputUrls = resultDataInner.outputs;
  }
  // Format 2: data.output object with images/videos arrays
  else if (resultDataInner?.output) {
    if (isVideoModel && resultDataInner.output.videos && resultDataInner.output.videos.length > 0) {
      outputUrls = resultDataInner.output.videos;
    } else if (resultDataInner.output.images && resultDataInner.output.images.length > 0) {
      outputUrls = resultDataInner.output.images;
    }
  }
  // Format 3: Fallback - outputs at top level (unlikely but safe)
  else if (pollData.outputs && Array.isArray(pollData.outputs) && pollData.outputs.length > 0) {
    outputUrls = pollData.outputs;
  }

  if (outputUrls.length === 0) {
    console.error(`[API:${requestId}] No outputs in WaveSpeed result. Response:`, JSON.stringify(pollData).substring(0, 500));
    return { status: "failed", error: `${modelName}: No outputs in generation result` };
  }

  const result = await fetchMediaOutput(requestId, outputUrls[0], capabilities);
  if (!result.success) {
    return { status: "failed", error: `${modelName}: ${result.error}` };
  }
  return { status: "completed", result };
}
