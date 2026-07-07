/**
 * Build a self-contained, portable workflow for sharing.
 *
 * A normal saved workflow stores media as external file refs relative to its
 * directory (imageRef, outputImageRef, …). Those refs are meaningless on
 * someone else's machine. In memory, though, nodes also carry the inline
 * base64 for their media, so a shareable copy is: current state, inline media
 * kept, external refs and the local directoryPath stripped.
 *
 * On import the drop handler calls loadWorkflow without a directory, so no
 * hydration is attempted and the inline base64 is used directly.
 */
import type { WorkflowNode, WorkflowEdge, NodeGroup } from "@/types";
import type { WorkflowFile, EdgeStyle } from "@/store/workflowStore";

// Fields that point at external files relative to a local save directory.
const REF_FIELDS = [
  "imageRef",
  "outputImageRef",
  "sourceImageRef",
  "inputImageRefs",
  "outputVideoRef",
  "outputAudioRef",
  "audioRef",
  "videoRef",
  "imageRefBasePath",
] as const;

function stripRefs(node: WorkflowNode): WorkflowNode {
  const data = { ...(node.data as Record<string, unknown>) };
  for (const field of REF_FIELDS) {
    delete data[field];
  }
  return { ...node, data } as WorkflowNode;
}

export interface ShareableWorkflowInput {
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeStyle: EdgeStyle;
  groups?: Record<string, NodeGroup>;
}

/**
 * Produce a portable WorkflowFile: no `id` (avoids localStorage collision on
 * the importer), no `directoryPath` (forces inline-media import), external
 * refs stripped so nothing dangles.
 */
export function buildShareableWorkflow(input: ShareableWorkflowInput): WorkflowFile {
  return {
    version: 1,
    name: input.name || "Shared Workflow",
    nodes: input.nodes.map(stripRefs),
    edges: input.edges,
    edgeStyle: input.edgeStyle,
    groups: input.groups && Object.keys(input.groups).length > 0 ? input.groups : undefined,
  };
}

/** Filesystem-safe filename (no extension) derived from a workflow name. */
export function shareableFilename(name: string): string {
  const base = (name || "workflow")
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
  return base || "workflow";
}
