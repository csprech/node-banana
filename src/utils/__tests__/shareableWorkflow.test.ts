import { describe, it, expect } from "vitest";
import { buildShareableWorkflow, shareableFilename } from "../shareableWorkflow";
import type { WorkflowNode, WorkflowEdge } from "@/types";

function node(id: string, data: Record<string, unknown>): WorkflowNode {
  return { id, type: "nanoBanana", position: { x: 0, y: 0 }, data } as WorkflowNode;
}

describe("buildShareableWorkflow", () => {
  const base = {
    name: "My Flow",
    edges: [] as WorkflowEdge[],
    edgeStyle: "curved" as const,
  };

  it("strips external refs but keeps inline base64 media", () => {
    const result = buildShareableWorkflow({
      ...base,
      nodes: [
        node("n1", {
          outputImage: "data:image/png;base64,AAAA",
          outputImageRef: "img-123",
          imageRefBasePath: "/local/path",
          prompt: "a cat",
        }),
      ],
    });

    const data = result.nodes[0].data as Record<string, unknown>;
    expect(data.outputImage).toBe("data:image/png;base64,AAAA");
    expect(data.prompt).toBe("a cat");
    expect(data.outputImageRef).toBeUndefined();
    expect(data.imageRefBasePath).toBeUndefined();
  });

  it("omits id and directoryPath so the file is portable", () => {
    const result = buildShareableWorkflow({ ...base, nodes: [] });
    expect(result.id).toBeUndefined();
    expect(result.directoryPath).toBeUndefined();
    expect(result.version).toBe(1);
    expect(result.name).toBe("My Flow");
  });

  it("does not mutate the input nodes", () => {
    const original = node("n1", { imageRef: "keep-me", outputImage: "data:x" });
    buildShareableWorkflow({ ...base, nodes: [original] });
    expect((original.data as Record<string, unknown>).imageRef).toBe("keep-me");
  });

  it("drops empty groups but keeps populated ones", () => {
    const withEmpty = buildShareableWorkflow({ ...base, nodes: [], groups: {} });
    expect(withEmpty.groups).toBeUndefined();

    const g = { g1: { id: "g1" } } as never;
    const withGroups = buildShareableWorkflow({ ...base, nodes: [], groups: g });
    expect(withGroups.groups).toBe(g);
  });
});

describe("export → serialize → import round-trip", () => {
  // Mirror of the drop-handler import guard in WorkflowCanvas.tsx:
  //   if (workflow.version && workflow.nodes && workflow.edges) loadWorkflow(workflow)
  function importGuardPasses(w: { version?: unknown; nodes?: unknown; edges?: unknown }): boolean {
    return !!(w.version && w.nodes && w.edges);
  }

  it("produces JSON the canvas drop handler accepts, media inline, no local path", () => {
    const exported = buildShareableWorkflow({
      name: "Portrait Pipeline",
      edgeStyle: "curved",
      edges: [{ id: "e1", source: "a", target: "b" } as unknown as WorkflowEdge],
      nodes: [
        node("a", { image: "data:image/png;base64,AAAA", imageRef: "local-123" }),
      ],
    });

    // What the browser downloads and someone else drops in:
    const reimported = JSON.parse(JSON.stringify(exported));

    expect(importGuardPasses(reimported)).toBe(true);
    expect(reimported.directoryPath).toBeUndefined(); // no foreign path → no hydration attempt
    expect(reimported.nodes[0].data.image).toBe("data:image/png;base64,AAAA");
    expect(reimported.nodes[0].data.imageRef).toBeUndefined();
    expect(reimported.edges).toHaveLength(1);
  });
});

describe("shareableFilename", () => {
  it("slugifies workflow names", () => {
    expect(shareableFilename("My Cool Flow!")).toBe("my-cool-flow");
    expect(shareableFilename("")).toBe("workflow");
    expect(shareableFilename("   ")).toBe("workflow");
  });
});
