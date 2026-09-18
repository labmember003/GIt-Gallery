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
};

export type PreparedAsset = {
  asset: MediaLibrary.Asset;
  localUri: string;
  repoPath: string;
  previewRepoPath?: string | null;
  fingerprint: string;
  creationTime: number | null;
  fileSize: number | null;
  contentBase64: string;
  contentHash?: string | null;
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
