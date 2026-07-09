"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { OutputGalleryNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { downloadMedia as downloadMediaUtil } from "@/utils/downloadMedia";
import { useShowHandleLabels } from "@/hooks/useShowHandleLabels";
import { HandleLabel } from "./HandleLabel";

type MediaItem = { type: "image" | "video"; src: string };

function AdaptiveGalleryThumbnail({ src, alt, nodeId }: { src: string; alt: string; nodeId: string }) {
  const adaptiveSrc = useAdaptiveImageSrc(src, nodeId);
  return (
    <img
      src={adaptiveSrc ?? undefined}
      alt={alt}
      className="w-full h-full object-cover"
    />
  );
}

type OutputGalleryNodeType = Node<OutputGalleryNodeData, "outputGallery">;

export function OutputGalleryNode({ id, data, selected }: NodeProps<OutputGalleryNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const { getNodes, setNodes } = useReactFlow();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const showLabels = useShowHandleLabels(selected);

  // Display stored media only — items are accumulated during workflow execution
  const displayMedia = useMemo(() => {
    const media: MediaItem[] = [
      ...(nodeData.images || []).map((src): MediaItem => ({ type: "image", src })),
      ...(nodeData.videos || []).map((src): MediaItem => ({ type: "video", src })),
    ];
    return media;
  }, [nodeData.images, nodeData.videos]);

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const navigateLightbox = useCallback(
    (direction: "prev" | "next") => {
      if (lightboxIndex === null) return;

      if (direction === "prev" && lightboxIndex > 0) {
        setLightboxIndex(lightboxIndex - 1);
      } else if (direction === "next" && lightboxIndex < displayMedia.length - 1) {
        setLightboxIndex(lightboxIndex + 1);
      }
    },
    [lightboxIndex, displayMedia.length]
  );

  const downloadMedia = useCallback(() => {
    if (lightboxIndex === null) return;

    const item = displayMedia[lightboxIndex];
    if (!item) return;

    downloadMediaUtil(item.src, item.type).catch((err) =>
      console.error("Gallery download failed:", err)
    );
  }, [lightboxIndex, displayMedia]);

  const removeMedia = useCallback((index: number) => {
    const item = displayMedia[index];
    if (!item) return;

    if (item.type === "image") {
      const images = [...(nodeData.images || [])];
      const imageRefs = [...(nodeData.imageRefs || [])];
      const imgIndex = images.indexOf(item.src);
      if (imgIndex !== -1) {
        images.splice(imgIndex, 1);
        if (imgIndex < imageRefs.length) imageRefs.splice(imgIndex, 1);
      }
      updateNodeData(id, { images, imageRefs });
    } else {
      const videos = [...(nodeData.videos || [])];
      const videoRefs = [...(nodeData.videoRefs || [])];
      const vidIndex = videos.indexOf(item.src);
      if (vidIndex !== -1) {
        videos.splice(vidIndex, 1);
        if (vidIndex < videoRefs.length) videoRefs.splice(vidIndex, 1);
      }
      updateNodeData(id, { videos, videoRefs });
    }

    // Adjust lightbox after removal
    if (lightboxIndex !== null) {
      const newLength = displayMedia.length - 1;
      if (newLength <= 0) {
        setLightboxIndex(null);
      } else if (lightboxIndex >= newLength) {
        setLightboxIndex(newLength - 1);
      }
    }
  }, [displayMedia, nodeData.images, nodeData.imageRefs, nodeData.videos, nodeData.videoRefs, updateNodeData, id, lightboxIndex]);

  const handleExtractToInputNodes = useCallback(() => {
    const galleryNode = getNodes().find((n) => n.id === id);
    if (!galleryNode) return;

    const galleryWidth = galleryNode.measured?.width ?? defaultNodeDimensions.outputGallery.width;
    const startX = galleryNode.position.x + galleryWidth + 100;
    let currentY = galleryNode.position.y;
    const gap = 20;

    const newNodeIds: string[] = [];
    const images = nodeData.images || [];
    const videos = nodeData.videos || [];

    // Reverse so oldest items (end of array) appear at top, newest at bottom
    const reversedImages = [...images].reverse();
    const reversedVideos = [...videos].reverse();

    for (let i = 0; i < reversedImages.length; i++) {
      const nodeId = addNode("imageInput", { x: startX, y: currentY }, { image: reversedImages[i], filename: `gallery-image-${i + 1}.png` });
      newNodeIds.push(nodeId);
      currentY += defaultNodeDimensions.imageInput.height + gap;
    }

    for (let i = 0; i < reversedVideos.length; i++) {
      const nodeId = addNode("videoInput", { x: startX, y: currentY }, { video: reversedVideos[i], filename: `gallery-video-${i + 1}.mp4` });
      newNodeIds.push(nodeId);
      currentY += defaultNodeDimensions.videoInput.height + gap;
    }

    if (newNodeIds.length > 0) {
      setNodes((nodes) =>
        nodes.map((n) => ({
          ...n,
          selected: newNodeIds.includes(n.id),
        }))
      );
    }
  }, [id, nodeData.images, nodeData.videos, getNodes, addNode, setNodes]);

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          closeLightbox();
          break;
        case "ArrowLeft":
          navigateLightbox("prev");
          break;
        case "ArrowRight":
          navigateLightbox("next");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxIndex, closeLightbox, navigateLightbox]);

  const currentItem = lightboxIndex !== null ? displayMedia[lightboxIndex] : null;

  return (
    <>
      <BaseNode
        id={id}
        selected={selected}
        className="min-w-[200px]"
      >
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          data-handletype="image"
          style={{ top: "40%" }}
        />
        <HandleLabel label="Image" side="target" color="rgb(59, 130, 246)" top="calc(40% - 18px)" visible={showLabels} />

        <Handle
          type="target"
          position={Position.Left}
          id="video"
          data-handletype="video"
          style={{ top: "60%" }}
        />
        <HandleLabel label="Video" side="target" color="var(--handle-color-video)" top="calc(60% - 18px)" visible={showLabels} />

        {displayMedia.length > 0 && (
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-neutral-400 text-[10px]">
              {displayMedia.length} {displayMedia.length === 1 ? "item" : "items"}
            </span>
            <button
              onClick={handleExtractToInputNodes}
              className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors"
              title="Extract each item as an input node"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
              Extract
            </button>
          </div>
        )}

        {displayMedia.length === 0 ? (
          <div className="w-full flex-1 min-h-[200px] border border-dashed border-neutral-600 rounded flex items-center justify-center">
            <span className="text-neutral-500 text-[10px] text-center px-4">
              Connect image or video nodes to view gallery
            </span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto nodrag nopan nowheel">
            <div className="grid grid-cols-3 gap-1.5 p-1">
              {displayMedia.map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => openLightbox(idx)}
                  aria-label={item.type === "video" ? `Open video ${idx + 1}` : `Open image ${idx + 1}`}
                  className="aspect-square rounded border border-neutral-700 hover:border-neutral-500 overflow-hidden transition-colors relative"
                >
                  {item.type === "video" ? (
                    <>
                      <video
                        src={item.src}
                        className="w-full h-full object-cover"
                        muted
                        playsInline
                        preload="metadata"
                      />
                      {/* Video play icon overlay */}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                        <svg className="w-5 h-5 text-white drop-shadow" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    </>
                  ) : (
                    <AdaptiveGalleryThumbnail src={item.src} alt={`Image ${idx + 1}`} nodeId={id} />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </BaseNode>

      {/* Lightbox Portal */}
      {lightboxIndex !== null && currentItem && typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/90 backdrop-blur-sm z-[100] flex items-center justify-center p-8"
            onClick={closeLightbox}
          >
            <div className="relative max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
              {currentItem.type === "video" ? (
                <video
                  src={currentItem.src}
                  className="max-w-full max-h-[90vh] object-contain rounded"
                  controls
                  autoPlay
                  playsInline
                />
              ) : (
                <img
                  src={currentItem.src}
                  alt={`Gallery image ${lightboxIndex + 1}`}
                  className="max-w-full max-h-[90vh] object-contain rounded"
                />
              )}

              {/* Close button */}
              <button
                onClick={closeLightbox}
                className="absolute top-4 right-4 w-8 h-8 bg-white/10 hover:bg-white/20 rounded text-white text-sm transition-colors flex items-center justify-center"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              {/* Download + Remove buttons */}
              <div className="absolute top-4 left-4 flex gap-1.5">
                <button
                  onClick={downloadMedia}
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-white text-xs font-medium transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download
                </button>
                <button
                  onClick={() => removeMedia(lightboxIndex)}
                  className="px-3 py-1.5 bg-white/10 hover:bg-red-600/80 rounded text-white text-xs font-medium transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                  Remove
                </button>
              </div>

              {/* Left arrow */}
              {lightboxIndex > 0 && (
                <button
                  onClick={() => navigateLightbox("prev")}
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors flex items-center justify-center"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}

              {/* Right arrow */}
              {lightboxIndex < displayMedia.length - 1 && (
                <button
                  onClick={() => navigateLightbox("next")}
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors flex items-center justify-center"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}

              {/* Media counter */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-black/50 rounded text-white text-xs font-medium">
                {lightboxIndex + 1} / {displayMedia.length}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
