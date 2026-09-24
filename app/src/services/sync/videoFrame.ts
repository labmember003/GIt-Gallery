/**
 * Extract a still frame from a video as a JPEG.
 *
 * A video file cannot be handed to an image decoder — doing so fails with
 * `Error decoding image data <NSData 62006315 bytes>`, i.e. it tries to decode
 * the whole movie as a picture. That single mistake cost videos both their
 * cloud-grid preview and their ThumbHash placeholder, so the extractor lives
 * here and both callers share it.
 *
 * `expo-video` is already a dependency for playback, and its `VideoThumbnail`
 * is a `SharedRef<'image'>` that the image manipulator's contextual API
 * accepts directly, so no new dependency is needed.
 */
import * as ImageManipulatorModule from 'expo-image-manipulator';
import { SaveFormat } from 'expo-image-manipulator';
import { createVideoPlayer } from 'expo-video';

/**
 * `ImageManipulator` is exported as both a type and a value, which defeats a
 * named import. Reach it through the namespace and pin the one call we use
 * rather than casting to `any` and losing the shape.
 */
type ManipulatorCtx = {
  resize(size: { width?: number | null; height?: number | null }): ManipulatorCtx;
  renderAsync(): Promise<{
    saveAsync(options: { format: string; compress?: number; base64?: boolean }): Promise<{ base64?: string | null }>;
  }>;
};

function contextualManipulator(): { manipulate(source: unknown): ManipulatorCtx } {
  return (ImageManipulatorModule as unknown as {
    ImageManipulator: { manipulate(source: unknown): ManipulatorCtx };
  }).ImageManipulator;
}

/**
 * Resolve once the player can actually produce frames. Asking too early
 * returns an EMPTY array rather than throwing — which is exactly how this
 * failed silently the first time.
 */
async function waitForPlayerReady(player: any, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = player?.status;
    if (status === 'readyToPlay') return true;
    if (status === 'error') throw new Error('video player failed to load source');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** True when this asset is a movie rather than a still. */
export function isVideoAsset(contentType?: string, localUri?: string): boolean {
  if (contentType && contentType.toLowerCase().startsWith('video/')) return true;
  return /\.(mp4|mov|m4v|3gp|avi|mkv)(\?|$)/i.test(localUri ?? '');
}

/** A frame from the video, resized to `width`, as base64 JPEG. Null if unavailable. */
export async function extractVideoFrameBase64(
  localUri: string,
  width: number,
  compress = 0.72,
): Promise<string | null> {
  let player: any = null;
  try {
    player = createVideoPlayer(null as any);
    // `replaceAsync` is the documented way to load a source and know when it
    // is loaded; the constructor form returns immediately and thumbnails then
    // come back empty. iOS `ph://` URIs also require this path.
    await player.replaceAsync({ uri: localUri } as any);
    const ready = await waitForPlayerReady(player);
    // Frame 0 is black on some encoders; a fraction of a second in is more
    // representative and still costs one seek.
    const thumbs = await player.generateThumbnailsAsync([0.1]);
    const thumb = Array.isArray(thumbs) ? thumbs[0] : null;
    if (!thumb) {
      console.warn(
        '[videoFrame] no frame produced (status=' + String(player?.status) +
        ', ready=' + ready + ', thumbs=' + (Array.isArray(thumbs) ? thumbs.length : typeof thumbs) + ')',
      );
      return null;
    }
    const rendered = await contextualManipulator().manipulate(thumb).resize({ width }).renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
    return (saved as any)?.base64 ?? null;
  } catch (error) {
    console.warn('[videoFrame] extraction failed', error);
    return null;
  } finally {
    try { player?.release?.(); } catch {}
  }
}
