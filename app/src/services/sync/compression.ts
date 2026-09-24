/**
 * Pre-upload image compression.
 *
 * A phone photo is routinely 3–8 MB; at 2048px/q80 the same image is a few
 * hundred KB with no visible difference on a phone screen. Since repo size is
 * effectively the sum of file sizes (git gets ~0% on already-compressed JPEG),
 * this is the single biggest lever on how much library fits in a repo.
 *
 * ⚠️ EXIF is not preserved. `expo-image-manipulator` re-encodes and drops all
 * metadata, and there is no supported way to re-inject it here. This is
 * acceptable *only* because the capture date is resolved from the original file
 * and encoded into the repo path before compression runs — so the timeline
 * stays correct. Camera model and GPS are genuinely lost. Users who care can
 * pick the `original` preset.
 */
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

export type CompressionPreset = 'original' | 'high' | 'balanced' | 'saver';

export const DEFAULT_PRESET: CompressionPreset = 'balanced';

type PresetConfig = {
  label: string;
  description: string;
  /** Longest edge in px; null means don't resize. */
  maxEdge: number | null;
  /** 0–1, passed to the JPEG encoder. */
  quality: number;
};

export const COMPRESSION_PRESETS: Record<CompressionPreset, PresetConfig> = {
  original: {
    label: 'Original',
    description: 'Upload untouched. Keeps EXIF and full resolution; uses the most space.',
    maxEdge: null,
    quality: 1,
  },
  high: {
    label: 'High quality',
    description: 'Up to 3072px. Near-indistinguishable from the original.',
    maxEdge: 3072,
    quality: 0.9,
  },
  balanced: {
    label: 'Balanced',
    description: 'Up to 2048px. Looks identical on a phone at a fraction of the size.',
    maxEdge: 2048,
    quality: 0.8,
  },
  saver: {
    label: 'Space saver',
    description: 'Up to 1440px. Smallest files; fine for browsing, soft when zoomed.',
    maxEdge: 1440,
    quality: 0.7,
  },
};

export type CompressionResult = {
  uri: string;
  size: number;
  /** Dimensions of the produced file — differs from the source when resized. */
  width: number | null;
  height: number | null;
  /** True when a new file was produced and the caller should clean it up. */
  isTemporary: boolean;
  /**
   * Extension of the produced bytes, or null on passthrough. Re-encoding is
   * hardcoded to JPEG, so a .heic or .png source comes back as 'jpg' and the
   * stored blob must be named accordingly.
   */
  outputExtension: string | null;
  originalSize: number;
};

/** Video is passed through — re-encoding it is out of scope (it goes to tier 2). */
function isCompressibleImage(filename: string | null | undefined, mediaType?: string | null): boolean {
  if (mediaType === 'video') return false;
  const ext = (filename ?? '').toLowerCase();
  return /\.(jpe?g|png|heic|heif|webp)$/.test(ext) || ext === '';
}

async function fileSize(uri: string): Promise<number> {
  try {
    const info = (await FileSystem.getInfoAsync(uri)) as any;
    return typeof info?.size === 'number' ? info.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Produce the bytes that should actually be uploaded.
 *
 * Falls back to the original on any failure — a compression problem must never
 * block an upload.
 */
export async function compressForUpload(params: {
  localUri: string;
  filename?: string | null;
  mediaType?: string | null;
  width?: number | null;
  height?: number | null;
  preset: CompressionPreset;
}): Promise<CompressionResult> {
  const originalSize = await fileSize(params.localUri);
  const passthrough: CompressionResult = {
    uri: params.localUri,
    size: originalSize,
    width: params.width ?? null,
    height: params.height ?? null,
    isTemporary: false,
    outputExtension: null,
    originalSize,
  };

  const config = COMPRESSION_PRESETS[params.preset] ?? COMPRESSION_PRESETS[DEFAULT_PRESET];
  if (params.preset === 'original' || config.maxEdge === null) return passthrough;
  if (!isCompressibleImage(params.filename, params.mediaType)) return passthrough;

  // Only resize when the image actually exceeds the target; upscaling a small
  // photo would add bytes for nothing.
  const longest = Math.max(params.width ?? 0, params.height ?? 0);
  const needsResize = longest > config.maxEdge;
  const actions = needsResize
    ? [
        (params.width ?? 0) >= (params.height ?? 0)
          ? { resize: { width: config.maxEdge } }
          : { resize: { height: config.maxEdge } },
      ]
    : [];

  try {
    const result = await manipulateAsync(params.localUri, actions, {
      compress: config.quality,
      format: SaveFormat.JPEG,
    });
    const outputUri = (result as any)?.uri as string | undefined;
    if (!outputUri) return passthrough;
    const size = await fileSize(outputUri);

    // Re-encoding can make an already-small or already-optimised file bigger.
    if (size <= 0 || size >= originalSize) {
      await FileSystem.deleteAsync(outputUri, { idempotent: true }).catch(() => {});
      return passthrough;
    }
    return {
      uri: outputUri,
      size,
      width: (result as any)?.width ?? null,
      height: (result as any)?.height ?? null,
      isTemporary: true,
      // manipulateAsync above is hardcoded to SaveFormat.JPEG.
      outputExtension: 'jpg',
      originalSize,
    };
  } catch (error) {
    console.warn('[compression] failed; uploading original', error);
    return passthrough;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
