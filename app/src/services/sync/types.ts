import type * as MediaLibrary from 'expo-media-library';

export type Listener = () => void;

export type SyncStatus = {
  running: boolean;
  pendingUploads: number;
  completedUploads: number;
  isDeleting: boolean;
  lastBatchTotal: number;
  lastBatchUploaded: number;
  lastBatchType: 'upload' | 'delete' | 'download' | null;
  lastError?: string | null;
};

export type UploadIndexEntry = {
  uploaded: boolean;
  repoPath: string | null;
  fileSize: number | null;
  creationTime: number | null;
  fingerprint: string;
  contentHash?: string | null;
  lastSeenAt?: number | null;
  lastUploadedAt?: number | null;
  lastError?: string | null;
};

export type UploadIndex = Record<string, UploadIndexEntry>;

export type MetaEntry = {
  fingerprint: string;
  repoPath: string;
  previewRepoPath?: string | null;
  createdAt: number | null;
  fileSize: number | null;
  contentHash: string | null;
  uploadedAt: number | null;
  assetId?: string | null;
  /** Base64 ThumbHash (~25 bytes) — renders the tile before any image loads. */
  thumbHash?: string | null;
};

export type PreparedAsset = {
  asset: MediaLibrary.Asset;
  /** Bytes to upload — the compressed file when one was produced. */
  localUri: string;
  /** Untouched source on device, kept so temp files can be distinguished. */
  originalUri?: string;
  /** Original byte size when compression actually ran, else null. */
  compressedFrom?: number | null;
  /** Base64 ThumbHash for the tile placeholder. */
  thumbHash?: string | null;
  repoPath: string;
  previewRepoPath?: string | null;
  /**
   * Tier-1 video only. A video blob cannot be drawn as an image, so without a
   * companion JPEG every video in the cloud grid renders as a broken tile.
   */
  previewBase64?: string | null;
  fingerprint: string;
  creationTime: number | null;
  fileSize: number | null;
  /**
   * Base64 bytes, present for tier 1 only.
   *
   * Tier-2 files are deliberately NOT read into memory — a 150 MB video becomes
   * a ~200 MB JS string and OOMs the app long before it reaches the network.
   * Those stream from `localUri` straight into a release asset instead.
   */
  contentBase64: string | null;
  contentHash?: string | null;
  /** 1 = git blob, 2 = release asset + pointer stub. See services/sync/tiering.ts. */
  tier: 1 | 2;
};

export type CompletionEvent = {
  type: 'upload' | 'download' | 'delete';
  total: number;
  failed: number;
  timestamp: number;
};

export type RepoInfo = {
  owner: string;
  name: string;
  branch: string;
};
