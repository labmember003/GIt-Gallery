import { extractExifDate } from '../services/sync/exifDate';
import { SessionError, sessionRequest } from './session';

export type UploadOptions = { chunkSize: number; maxFileSize: number; extensions: string[]; writable: boolean };
export type UploadResult = { id: string; repoPath: string; name: string; reused: boolean };
export type UploadProgress = { percent: number; label: string };
export type UploadFile = { file: File; uploadId?: string; prepared?: Prepared };
type Prepared = { name: string; size: number; createdAt: number; width: number; height: number; hashes: string[]; preview?: Blob };
export const ACCEPT_MEDIA = '.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.avif,.mp4,.mov,.m4v,.webm';

function preview(file: File, signal: AbortSignal): Promise<{ width: number; height: number; preview?: Blob }> {
  return new Promise(resolve => {
    const video = /\.(mp4|mov|m4v|webm)$/i.test(file.name);
    const media = video ? document.createElement('video') : new Image();
    const url = URL.createObjectURL(file);
    let finished = false;
    const done = (result: { width: number; height: number; preview?: Blob }) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      media.onload = null; media.onerror = null;
      if (media instanceof HTMLVideoElement) { media.onloadeddata = null; media.pause(); media.removeAttribute('src'); media.load(); }
      else media.src = '';
      URL.revokeObjectURL(url); resolve(result);
    };
    const abort = () => done({ width: 0, height: 0 });
    const timer = setTimeout(abort, 10_000);
    signal.addEventListener('abort', abort, { once: true });
    const draw = () => {
      const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
      const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
      if (!width || !height) return abort();
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      try {
        canvas.getContext('2d')!.drawImage(media, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => done({ width, height, ...(blob && blob.size <= 512 * 1024 ? { preview: blob } : {}) }), 'image/jpeg', .78);
      } catch { done({ width, height }); }
    };
    media.onerror = abort;
    if (media instanceof HTMLVideoElement) { media.muted = true; media.preload = 'auto'; media.onloadeddata = draw; }
    else media.onload = draw;
    media.src = url;
    if (signal.aborted) abort();
  });
}

async function sendBytes(path: string, bytes: Blob, csrf: string, signal: AbortSignal) {
  const response = await fetch(`/api/uploads/${path}`, { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/octet-stream', 'X-GitGallery-CSRF': csrf }, body: bytes });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new SessionError(result.error ?? 'The upload connection was interrupted. Retry to continue.', response.status);
}

/** The original is read in bounded slices. Credentials never enter this module. */
export async function uploadFile(item: UploadFile, options: UploadOptions, csrf: string, signal: AbortSignal,
  progress: (value: UploadProgress) => void): Promise<UploadResult> {
  const file = item.file;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!options.extensions.includes(extension)) throw new Error('This file type is not supported. Choose a photo or video listed above.');
  if (!file.size || file.size > options.maxFileSize) throw new Error('Choose a non-empty file up to 500 MB.');
  if (!item.prepared) {
    const hashes: string[] = [];
    for (let offset = 0; offset < file.size; offset += options.chunkSize) {
      signal.throwIfAborted();
      progress({ percent: Math.round(offset / file.size * 10), label: 'Preparing file…' });
      const digest = await crypto.subtle.digest('SHA-256', await file.slice(offset, offset + options.chunkSize).arrayBuffer());
      hashes.push(Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''));
    }
    const exif = extractExifDate(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
    item.prepared = { name: file.name, size: file.size, createdAt: exif?.getTime() ?? (file.lastModified || Date.now()), hashes,
      ...await preview(file, signal) };
  }
  signal.throwIfAborted();
  const { preview: thumbnail, ...metadata } = item.prepared;
  const started = await sessionRequest<{ id: string | null; received: number[]; result: UploadResult | null }>('/uploads/start', { csrf, body: metadata, signal });
  if (started.result) return started.result;
  if (!started.id) throw new Error('The upload could not start. Try again.');
  item.uploadId = started.id;
  const received = new Set(started.received);
  for (let index = 0; index < metadata.hashes.length; index++) {
    signal.throwIfAborted();
    progress({ percent: 10 + Math.round(index / metadata.hashes.length * 75), label: `Uploading part ${index + 1} of ${metadata.hashes.length}…` });
    if (!received.has(index)) await sendBytes(`${item.uploadId}/chunks/${index}`, file.slice(index * options.chunkSize, (index + 1) * options.chunkSize), csrf, signal);
  }
  if (thumbnail) {
    progress({ percent: 87, label: 'Saving preview…' });
    await sendBytes(`${item.uploadId}/preview`, thumbnail, csrf, signal);
  }
  progress({ percent: 92, label: 'Saving original to your library…' });
  // Finishing may stream a large original to GitHub. Progress stays below 100%
  // until GitHub confirms the file and the atomic library commit.
  const finished = await sessionRequest<{ result: UploadResult }>(`/uploads/${item.uploadId}/finish`, { csrf, body: {}, signal });
  return finished.result;
}
