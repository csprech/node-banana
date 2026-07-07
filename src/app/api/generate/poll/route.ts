/**
 * Poll API Route
 *
 * Handles status polling for long-running provider tasks (Kie, fal,
 * Replicate, WaveSpeed). The client calls this endpoint repeatedly with
 * short-lived requests instead of holding a single connection open for
 * minutes.
 */
import { NextRequest, NextResponse } from "next/server";
import type { GenerateResponse } from "@/types";
import { checkKieTaskOnce, fetchKieMediaResult, isVeoModel } from "../providers/kie";
import { checkReplicateTaskOnce } from "../providers/replicate";
import { checkFalTaskOnce, isValidFalQueueUrl } from "../providers/fal";
import { checkWaveSpeedTaskOnce, buildWaveSpeedPollUrl } from "../providers/wavespeed";
import { buildMediaResponse, capabilitiesForMediaType } from "../route";
import type { TaskCheckResult } from "../providers/taskPolling";

export const maxDuration = 120; // 2 min — enough for media fetch, not for polling
export const dynamic = 'force-dynamic';

interface PollRequest {
  taskId: string;
  provider: string;
  modelId: string;
  modelName: string;
  mediaType: string;
  pollContext?: Record<string, string>;
}

function stillPolling(body: PollRequest): NextResponse {
  return NextResponse.json<GenerateResponse>({
    success: true,
    polling: true,
    taskId: body.taskId,
    pollProvider: body.provider,
    pollModelId: body.modelId,
    pollModelName: body.modelName,
    pollMediaType: body.mediaType,
    pollContext: body.pollContext,
  });
}

function missingKeyResponse(providerLabel: string): NextResponse {
  return NextResponse.json<GenerateResponse>(
    { success: false, error: `${providerLabel} API key not configured` },
    { status: 401 }
  );
}

function finishTask(body: PollRequest, check: TaskCheckResult): NextResponse {
  if (check.status === "processing") {
    return stillPolling(body);
  }
  if (check.status === "failed") {
    return NextResponse.json<GenerateResponse>(
      { success: false, error: check.error },
      { status: 500 }
    );
  }
  const output = check.result.outputs?.[0];
  if (!output?.data && !output?.url) {
    return NextResponse.json<GenerateResponse>(
      { success: false, error: "No output in generation result" },
      { status: 500 }
    );
  }
  return buildMediaResponse(output);
}

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const body: PollRequest = await request.json();
    const { taskId, provider, modelId, modelName, mediaType, pollContext } = body;

    if (!taskId || !provider) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: "taskId and provider are required" },
        { status: 400 }
      );
    }

    const capabilities = capabilitiesForMediaType(mediaType);

    if (provider === 'replicate') {
      const apiKey = request.headers.get("X-Replicate-API-Key") || process.env.REPLICATE_API_KEY;
      if (!apiKey) return missingKeyResponse("Replicate");

      const check = await checkReplicateTaskOnce(requestId, apiKey, taskId, modelName, capabilities);
      return finishTask(body, check);
    }

    if (provider === 'fal') {
      const apiKey = request.headers.get("X-Fal-API-Key") || process.env.FAL_API_KEY || null;

      // Client echoes the queue URLs from submission; re-validate them (SSRF protection),
      // falling back to URLs constructed from the model ID.
      let statusUrl = pollContext?.statusUrl;
      let responseUrl = pollContext?.responseUrl;
      if (!statusUrl || !isValidFalQueueUrl(statusUrl)) {
        statusUrl = `https://queue.fal.run/${modelId}/requests/${taskId}/status`;
      }
      if (!responseUrl || !isValidFalQueueUrl(responseUrl)) {
        responseUrl = `https://queue.fal.run/${modelId}/requests/${taskId}`;
      }

      const check = await checkFalTaskOnce(requestId, apiKey, statusUrl, responseUrl, modelName, capabilities);
      return finishTask(body, check);
    }

    if (provider === 'wavespeed') {
      const apiKey = request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY;
      if (!apiKey) return missingKeyResponse("WaveSpeed");

      // Re-validate the echoed poll URL (SSRF protection); falls back to the constructed URL
      const pollUrl = buildWaveSpeedPollUrl(taskId, pollContext?.pollUrl);

      const check = await checkWaveSpeedTaskOnce(requestId, apiKey, pollUrl, modelName, capabilities);
      return finishTask(body, check);
    }

    if (provider !== 'kie') {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: `Unsupported poll provider: ${provider}` },
        { status: 400 }
      );
    }

    // Get API key (same pattern as route.ts)
    const apiKey = request.headers.get("X-Kie-Key") || process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: "Kie.ai API key not configured" },
        { status: 401 }
      );
    }

    const isVeo = isVeoModel(modelId);
    const pollResult = await checkKieTaskOnce(requestId, apiKey, taskId, isVeo);

    if (pollResult.status === "processing") {
      return stillPolling(body);
    }

    if (pollResult.status === "failed") {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: `${modelName}: ${pollResult.error}` },
        { status: 500 }
      );
    }

    // completed — fetch media and return final result
    const result = await fetchKieMediaResult(requestId, {
      pollData: pollResult.data!,
      isVeo,
      modelName,
      capabilities,
    });

    if (!result.success) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: result.error || "Failed to fetch result" },
        { status: 500 }
      );
    }

    const output = result.outputs?.[0];
    if (!output?.data && !output?.url) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: "No output in generation result" },
        { status: 500 }
      );
    }

    return buildMediaResponse(output);
  } catch (error) {
    console.error(`[API:${requestId}] Poll error:`, error);
    return NextResponse.json<GenerateResponse>(
      { success: false, error: error instanceof Error ? error.message : "Poll failed" },
      { status: 500 }
    );
  }
}
