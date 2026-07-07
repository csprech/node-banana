/**
 * Replicate Provider for Generate API Route
 *
 * Handles image/video generation using Replicate's prediction API.
 * Uses submit + client-poll: submitReplicateTask creates the prediction and
 * returns immediately; the client polls /api/generate/poll which calls
 * checkReplicateTaskOnce until the prediction settles.
 */

import { GenerationInput } from "@/lib/providers/types";
import { fetchMediaOutput, TaskCheckResult } from "./taskPolling";
import {
  getParameterTypesFromSchema,
  coerceParameterTypes,
  getInputMappingFromSchema,
} from "../schemaUtils";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/**
 * Submit a Replicate prediction and return its ID immediately.
 * Throws on submission failure.
 */
export async function submitReplicateTask(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<{ taskId: string }> {
  console.log(`[API:${requestId}] Replicate generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  // Get the latest version of the model
  const modelId = input.model.id;
  const [owner, name] = modelId.split("/");

  if (!owner || !name) {
    throw new Error(`Invalid Replicate model ID "${modelId}": expected "owner/name" format`);
  }

  // First, get the model to find the latest version
  const modelResponse = await fetch(
    `${REPLICATE_API_BASE}/models/${owner}/${name}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!modelResponse.ok) {
    throw new Error(`Failed to get model info: ${modelResponse.status}`);
  }

  const modelData = await modelResponse.json();
  const version = modelData.latest_version?.id;

  if (!version) {
    throw new Error("Model has no available version");
  }

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Model version: ${version}, Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Get schema for type coercion and input mapping
  const schema = modelData.latest_version?.openapi_schema as Record<string, unknown> | undefined;
  const parameterTypes = getParameterTypesFromSchema(schema);

  // Build input for the prediction - parameters are applied per-path below to avoid double-spreading
  const predictionInput: Record<string, unknown> = {};

  // Add dynamic inputs if provided (these come from schema-mapped connections)
  if (hasDynamicInputs) {
    // Apply coerced parameters first, then dynamic inputs override
    Object.assign(predictionInput, coerceParameterTypes(input.parameters, parameterTypes));
    const { paramMap, schemaArrayParams } = getInputMappingFromSchema(schema);

    // Apply array wrapping based on schema type
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        if (schemaArrayParams.has(key) && !Array.isArray(value)) {
          predictionInput[key] = [value];  // Wrap in array
        } else if (!schemaArrayParams.has(key) && Array.isArray(value)) {
          predictionInput[key] = value[0];  // Unwrap array to single value
        } else {
          predictionInput[key] = value;
        }
      }
    }

    // Ensure prompt is included even when dynamicInputs are present
    // (executor sends prompt as top-level field, not in dynamicInputs)
    const promptParam = paramMap.prompt || "prompt";
    if (input.prompt && !predictionInput[promptParam]) {
      predictionInput[promptParam] = input.prompt;
    }
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names
    const { paramMap, arrayParams } = getInputMappingFromSchema(schema);

    // Map prompt input
    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      predictionInput[promptParam] = input.prompt;
    }

    // Map image input - use array or string format based on schema
    if (input.images && input.images.length > 0) {
      const imageParam = paramMap.image || "image";
      if (arrayParams.has("image")) {
        predictionInput[imageParam] = input.images;
      } else {
        predictionInput[imageParam] = input.images[0];
      }
    }

    // Map any parameters that might need renaming (use coerced values)
    const coercedParams = coerceParameterTypes(input.parameters, parameterTypes);
    for (const [key, value] of Object.entries(coercedParams)) {
      const mappedKey = paramMap[key] || key;
      predictionInput[mappedKey] = value;
    }
  }

  // Create a prediction
  const createResponse = await fetch(`${REPLICATE_API_BASE}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version,
      input: predictionInput,
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    let errorDetail = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.detail || errorJson.message || errorJson.error || errorText;
    } catch {
      // Keep original text if not JSON
    }

    // Handle rate limits
    if (createResponse.status === 429) {
      throw new Error(`${input.model.name}: Rate limit exceeded. Try again in a moment.`);
    }

    throw new Error(`${input.model.name}: ${errorDetail}`);
  }

  const prediction = await createResponse.json();
  console.log(`[API:${requestId}] Prediction created: ${prediction.id}`);

  if (!prediction.id) {
    throw new Error(`${input.model.name}: No prediction ID returned from API`);
  }

  return { taskId: prediction.id };
}

/**
 * Check a Replicate prediction once. Fetches media on success.
 * Throws on transient poll failures so the client can retry.
 */
export async function checkReplicateTaskOnce(
  requestId: string,
  apiKey: string,
  taskId: string,
  modelName: string,
  capabilities: string[]
): Promise<TaskCheckResult> {
  const pollResponse = await fetch(
    `${REPLICATE_API_BASE}/predictions/${taskId}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!pollResponse.ok) {
    throw new Error(`Failed to poll prediction: ${pollResponse.status}`);
  }

  const prediction = await pollResponse.json();
  console.log(`[API:${requestId}] Prediction status: ${prediction.status}`);

  if (prediction.status === "failed") {
    return { status: "failed", error: prediction.error || "Prediction failed" };
  }

  if (prediction.status === "canceled") {
    return { status: "failed", error: "Prediction was canceled" };
  }

  if (prediction.status !== "succeeded") {
    return { status: "processing" };
  }

  // Extract output — can be a single URL string or an array
  const output = prediction.output;
  const rawOutputs = Array.isArray(output) ? output : [output];
  const outputUrls: string[] = rawOutputs.filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );

  if (outputUrls.length === 0) {
    return { status: "failed", error: "No output from prediction" };
  }

  const result = await fetchMediaOutput(requestId, outputUrls[0], capabilities);
  if (!result.success) {
    return { status: "failed", error: `${modelName}: ${result.error}` };
  }
  return { status: "completed", result };
}
