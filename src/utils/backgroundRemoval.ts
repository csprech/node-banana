import type { BackgroundRemovalModel } from "@/types";

export interface BackgroundRemovalOptions {
  model?: BackgroundRemovalModel;
  onProgress?: (progress: number) => void;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to convert result to data URL"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Remove the background from an image using client-side AI (IMG.LY).
 * Returns a PNG data URL with transparency.
 */
export async function removeImageBackground(
  imageSrc: string,
  options?: BackgroundRemovalOptions,
): Promise<string> {
  const { removeBackground } = await import("@imgly/background-removal");

  const config = {
    model: options?.model ?? "isnet_fp16",
    output: {
      format: "image/png" as const,
      quality: 0.9,
    },
    progress: (_key: string, current: number, total: number) => {
      if (options?.onProgress && total > 0) {
        options.onProgress(Math.round((current / total) * 100));
      }
    },
  };

  const blob = await removeBackground(imageSrc, config);
  return blobToDataUrl(blob);
}
