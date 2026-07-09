"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useWorkflowStore } from "@/store/workflowStore";
import type { AssetEntry, AssetType } from "@/app/api/assets/route";

type TypeFilter = "all" | AssetType;

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "image", label: "Images" },
  { key: "video", label: "Videos" },
  { key: "audio", label: "Audio" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Load an asset's bytes on demand via the existing per-file load endpoint.
// Returns a data URL. Kept lightweight — no caching layer, the browser caches
// the underlying request and the panel unmounts when closed.
async function loadAssetDataUrl(
  workflowPath: string,
  asset: AssetEntry
): Promise<string | null> {
  const res = await fetch("/api/load-generation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directoryPath: `${workflowPath}/${asset.folder}`, imageId: asset.id }),
  });
  const data = await res.json();
  if (!data.success) return null;
  return data.image || data.video || data.audio || null;
}

/** One grid cell — lazy-loads its own bytes when first scrolled into view. */
function AssetCell({
  asset,
  workflowPath,
  onOpen,
  onDragStart,
}: {
  asset: AssetEntry;
  workflowPath: string;
  onOpen: (asset: AssetEntry, dataUrl: string) => void;
  onDragStart: (e: React.DragEvent, asset: AssetEntry, dataUrl: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || dataUrl) return;
    let cancelled = false;
    loadAssetDataUrl(workflowPath, asset).then((url) => {
      if (!cancelled && url) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, dataUrl, workflowPath, asset]);

  const isImage = asset.type === "image";

  return (
    <button
      ref={ref}
      draggable={isImage && !!dataUrl}
      onDragStart={(e) => dataUrl && onDragStart(e, asset, dataUrl)}
      onClick={() => dataUrl && onOpen(asset, dataUrl)}
      className="relative aspect-square rounded-md overflow-hidden border border-neutral-700 hover:border-blue-500 bg-neutral-900 transition-colors group"
      title={`${asset.filename}\n${formatSize(asset.size)}${isImage ? "\nDrag onto canvas" : ""}`}
    >
      {dataUrl && isImage && (
        <img
          src={dataUrl}
          alt={asset.filename}
          className="w-full h-full object-cover pointer-events-none"
          draggable={false}
        />
      )}
      {dataUrl && asset.type === "video" && (
        <video src={dataUrl} className="w-full h-full object-cover pointer-events-none" muted />
      )}
      {(!dataUrl || asset.type === "audio") && (
        <div className="w-full h-full flex items-center justify-center text-neutral-600">
          {asset.type === "audio" ? (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19a3 3 0 11-6 0 3 3 0 016 0zm12-3a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          ) : (
            <div className="w-4 h-4 border-2 border-neutral-600 border-t-neutral-400 rounded-full animate-spin" />
          )}
        </div>
      )}
      {/* Type badge for non-images */}
      {asset.type !== "image" && (
        <span className="absolute top-1 left-1 px-1 rounded bg-black/60 text-[9px] uppercase text-neutral-300">
          {asset.type}
        </span>
      )}
      {/* Source badge */}
      <span className="absolute bottom-1 right-1 px-1 rounded bg-black/60 text-[9px] text-neutral-400">
        {asset.folder === "generations" ? "gen" : "in"}
      </span>
    </button>
  );
}

/** Lightbox preview for a clicked asset. */
function AssetLightbox({
  asset,
  dataUrl,
  onClose,
}: {
  asset: AssetEntry;
  dataUrl: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div className="max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {asset.type === "image" && (
          <img src={dataUrl} alt={asset.filename} className="max-w-full max-h-[80vh] object-contain rounded-lg" />
        )}
        {asset.type === "video" && (
          <video src={dataUrl} className="max-w-full max-h-[80vh] rounded-lg" controls autoPlay />
        )}
        {asset.type === "audio" && (
          <div className="bg-neutral-800 rounded-lg p-6">
            <audio src={dataUrl} controls autoPlay />
          </div>
        )}
        <div className="flex items-center gap-4">
          <span className="text-xs text-neutral-400">{asset.filename} · {formatSize(asset.size)}</span>
          <a
            href={dataUrl}
            download={asset.filename}
            className="text-xs text-blue-400 hover:text-blue-300"
            onClick={(e) => e.stopPropagation()}
          >
            Download
          </a>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function AssetLibrary() {
  const workflowPath = useWorkflowStore((state) => state.saveDirectoryPath);
  const [isOpen, setIsOpen] = useState(false);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [lightbox, setLightbox] = useState<{ asset: AssetEntry; dataUrl: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!workflowPath) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/assets?workflowPath=${encodeURIComponent(workflowPath)}`);
      const data = await res.json();
      if (data.success) {
        setAssets(data.assets);
      } else {
        setError(data.error || "Failed to load assets");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assets");
    } finally {
      setLoading(false);
    }
  }, [workflowPath]);

  // Load whenever the panel opens
  useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  const handleDragStart = useCallback(
    (e: React.DragEvent, asset: AssetEntry, dataUrl: string) => {
      // Reuse the existing canvas drop contract for history images
      e.dataTransfer.setData(
        "application/history-image",
        JSON.stringify({ image: dataUrl, prompt: "", timestamp: asset.mtime })
      );
      e.dataTransfer.effectAllowed = "copy";
    },
    []
  );

  const filtered = assets.filter((a) => {
    if (typeFilter !== "all" && a.type !== typeFilter) return false;
    if (search && !a.filename.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // No saved directory → nothing to browse. Hide entirely.
  if (!workflowPath) return null;

  return (
    <>
      {/* Trigger button — sits left of the session history button */}
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="absolute bottom-4 right-80 z-10 w-8 h-8 rounded-lg flex items-center justify-center bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 text-neutral-400 hover:text-neutral-100 shadow-lg transition-colors"
        title="Asset library"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </button>

      {isOpen &&
        createPortal(
          <div className="fixed top-0 right-0 h-full w-96 iris-glass shadow-2xl z-[200] flex flex-col">
            {/* Header */}
            <div className="px-4 py-3 border-b border-neutral-700 flex items-center justify-between shrink-0">
              <span className="text-sm font-medium text-neutral-200">Asset Library</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={refresh}
                  className="text-[11px] text-neutral-500 hover:text-neutral-200 transition-colors"
                  title="Refresh"
                >
                  Refresh
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  className="w-5 h-5 rounded hover:bg-neutral-700 flex items-center justify-center text-neutral-400 hover:text-neutral-100 transition-colors"
                  title="Close"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Controls */}
            <div className="px-4 py-2 border-b border-neutral-700 shrink-0 space-y-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by filename…"
                className="w-full px-2 py-1.5 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-blue-500"
              />
              <div className="flex gap-1">
                {TYPE_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setTypeFilter(f.key)}
                    className={`px-2 py-1 text-[11px] rounded transition-colors ${
                      typeFilter === f.key
                        ? "bg-blue-600 text-white"
                        : "bg-neutral-900 text-neutral-400 hover:text-neutral-200"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto p-3">
              {loading && <p className="text-xs text-neutral-500 text-center py-8">Loading…</p>}
              {error && <p className="text-xs text-red-400 text-center py-8">{error}</p>}
              {!loading && !error && filtered.length === 0 && (
                <p className="text-xs text-neutral-500 text-center py-8">
                  {assets.length === 0 ? "No saved assets yet. Run a workflow to generate some." : "No assets match your filter."}
                </p>
              )}
              <div className="grid grid-cols-3 gap-2">
                {filtered.map((asset) => (
                  <AssetCell
                    key={`${asset.folder}/${asset.filename}`}
                    asset={asset}
                    workflowPath={workflowPath}
                    onOpen={(a, dataUrl) => setLightbox({ asset: a, dataUrl })}
                    onDragStart={handleDragStart}
                  />
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-neutral-700 bg-neutral-900/50 shrink-0">
              <span className="text-[10px] text-neutral-500">
                {filtered.length} of {assets.length} · drag images onto canvas
              </span>
            </div>
          </div>,
          document.body
        )}

      {lightbox && (
        <AssetLightbox asset={lightbox.asset} dataUrl={lightbox.dataUrl} onClose={() => setLightbox(null)} />
      )}
    </>
  );
}
