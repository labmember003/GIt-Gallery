import * as SQLite from 'expo-sqlite';

const DB_NAME = 'gitgallery_v2.db';
const LEGACY_MIGRATION_KEY = 'legacy:migrationCompleted';

let dbInstance: SQLite.SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export type AssetRecord = {
  fingerprint: string;
  assetId?: string | null;
  repoPath?: string | null;
  uploaded?: boolean;
  fileSize?: number | null;
  createdAt?: number | null;
  contentHash?: string | null;
  previewHash?: string | null;
  lastSeenAt?: number | null;
  lastUploadedAt?: number | null;
  lastError?: string | null;
};

export type AssetFilter = {
  uploaded?: boolean;
  cursor?: { lastSeenAt: number; fingerprint: string };
  limit?: number;
};

export type LocalStoreKey =
  | 'legacy:migrationCompleted'
  | 'sync:lastCursor'
  | 'sync:lastManifestSha'
  | 'sync:lastUploadRun'
  | 'sync:lastDownloadRun'
  | 'downloads:directoryUri';

type AssetRow = {
  fingerprint: string;
  asset_id: string | null;
  repo_path: string | null;
  uploaded: number;
  file_size: number | null;
  created_at: number | null;
  content_hash: string | null;
  preview_hash: string | null;
  last_seen_at: number | null;
  last_uploaded_at: number | null;
  last_error: string | null;
};

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    const database = await SQLite.openDatabaseAsync(DB_NAME);
    await database.execAsync('PRAGMA journal_mode = WAL;');
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS assets (
        fingerprint TEXT PRIMARY KEY,
        asset_id TEXT,
        repo_path TEXT,
        uploaded INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER,
        created_at INTEGER,
        content_hash TEXT,
        preview_hash TEXT,
        last_seen_at INTEGER,
        last_uploaded_at INTEGER,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_assets_uploaded ON assets(uploaded);
      CREATE INDEX IF NOT EXISTS idx_assets_last_seen ON assets(last_seen_at);

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS auto_sync_blocklist (
        fingerprint TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auto_sync_blocklist_blocked_at ON auto_sync_blocklist(blocked_at);
    `);

    await runLegacyMigration(database);

    dbInstance = database;
    return database;
  })();

  return dbInitPromise;
}

async function runLegacyMigration(database: SQLite.SQLiteDatabase): Promise<void> {
  const flagRow = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM kv_store WHERE key = ?',
    [LEGACY_MIGRATION_KEY]
  );
  if (flagRow?.value === '1') {
    return;
  }

  const assetsCount = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM assets'
  );
  if ((assetsCount?.count ?? 0) > 0) {
    await database.runAsync(
      'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
      [LEGACY_MIGRATION_KEY, '1']
    );
    return;
  }

  const tables = await database.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table'`
  );
  const legacyTables = new Set(tables.map((row) => row.name));
  const hasLegacyData = ['upload_index', 'meta_entries', 'uploaded_fingerprints'].some((table) =>
    legacyTables.has(table)
  );

  if (!hasLegacyData) {
    await database.runAsync(
      'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
      [LEGACY_MIGRATION_KEY, '1']
    );
    return;
  }

  const uploadedFingerprintSet = new Set<string>();
  if (legacyTables.has('uploaded_fingerprints')) {
    const uploadedFingerprints = await database.getAllAsync<{ fingerprint: string }>(
      'SELECT fingerprint FROM uploaded_fingerprints'
    );
    for (const row of uploadedFingerprints) {
      if (row.fingerprint) {
        uploadedFingerprintSet.add(row.fingerprint);
      }
    }
  }

  const insertedFingerprints = new Set<string>();

  await database.execAsync('BEGIN TRANSACTION;');
  try {
    if (legacyTables.has('upload_index')) {
      const legacyUploadRows = await database.getAllAsync<{
        asset_id: string;
        uploaded: number;
        repo_path: string | null;
        file_size: number | null;
        creation_time: number | null;
        fingerprint: string | null;
        content_hash: string | null;
      }>('SELECT * FROM upload_index');

      for (const row of legacyUploadRows) {
        const fingerprint = row.fingerprint ?? row.asset_id;
        if (!fingerprint) continue;
        await upsertAssetRow(database, {
          fingerprint,
          asset_id: row.asset_id ?? null,
          repo_path: row.repo_path ?? null,
          uploaded: row.uploaded === 1 ? 1 : uploadedFingerprintSet.has(fingerprint) ? 1 : 0,
          file_size: row.file_size ?? null,
          created_at: row.creation_time ?? null,
          content_hash: row.content_hash ?? null,
          preview_hash: null,
          last_seen_at: Date.now(),
          last_uploaded_at: row.uploaded === 1 ? Date.now() : null,
          last_error: null,
        });
        insertedFingerprints.add(fingerprint);
      }
    }

    if (legacyTables.has('meta_entries')) {
      const legacyMetaRows = await database.getAllAsync<{
        fingerprint: string;
        repo_path: string;
        preview_repo_path: string | null;
        created_at: number | null;
        file_size: number | null;
        content_hash: string | null;
      }>('SELECT fingerprint, repo_path, preview_repo_path, created_at, file_size, content_hash FROM meta_entries');

      for (const row of legacyMetaRows) {
        const fingerprint = row.fingerprint;
        if (!fingerprint) continue;
        if (insertedFingerprints.has(fingerprint)) {
          await database.runAsync(
            `UPDATE assets SET repo_path = COALESCE(?, repo_path), file_size = COALESCE(?, file_size), created_at = COALESCE(?, created_at), content_hash = COALESCE(?, content_hash), preview_hash = COALESCE(?, preview_hash) WHERE fingerprint = ?`,
            [
              row.repo_path ?? null,
              row.file_size ?? null,
              row.created_at ?? null,
              row.content_hash ?? null,
              row.preview_repo_path ?? null,
              fingerprint,
            ]
          );
        } else {
          await upsertAssetRow(database, {
            fingerprint,
            asset_id: null,
            repo_path: row.repo_path ?? null,
            uploaded: uploadedFingerprintSet.has(fingerprint) ? 1 : 0,
            file_size: row.file_size ?? null,
            created_at: row.created_at ?? null,
            content_hash: row.content_hash ?? null,
            preview_hash: row.preview_repo_path ?? null,
            last_seen_at: Date.now(),
            last_uploaded_at: uploadedFingerprintSet.has(fingerprint) ? Date.now() : null,
            last_error: null,
          });
          insertedFingerprints.add(fingerprint);
        }
      }
    }

    await database.runAsync(
      'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
      [LEGACY_MIGRATION_KEY, '1']
    );

    const dropStatements = [
      'DROP TABLE IF EXISTS upload_index;',
      'DROP TABLE IF EXISTS meta_entries;',
      'DROP TABLE IF EXISTS uploaded_fingerprints;',
      'DROP TABLE IF EXISTS recently_uploaded;',
      'DROP TABLE IF EXISTS deleted_repo_paths;',
      'DROP TABLE IF EXISTS non_existent_paths;',
      'DROP TABLE IF EXISTS blocked_fingerprints;'
    ].join('\n');
    await database.execAsync(dropStatements);

    await database.execAsync('COMMIT;');
  } catch (error) {
    await database.execAsync('ROLLBACK;');
    console.warn('Legacy migration failed:', error);
  }
}

async function upsertAssetRow(database: SQLite.SQLiteDatabase, row: AssetRow): Promise<void> {
  await database.runAsync(
    `INSERT INTO assets (
      fingerprint,
      asset_id,
      repo_path,
      uploaded,
      file_size,
      created_at,
      content_hash,
      preview_hash,
      last_seen_at,
      last_uploaded_at,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      asset_id = excluded.asset_id,
      repo_path = excluded.repo_path,
      uploaded = excluded.uploaded,
      file_size = excluded.file_size,
      created_at = excluded.created_at,
      content_hash = excluded.content_hash,
      preview_hash = excluded.preview_hash,
      last_seen_at = excluded.last_seen_at,
      last_uploaded_at = excluded.last_uploaded_at,
      last_error = excluded.last_error;
    `,
    [
      row.fingerprint,
      row.asset_id ?? null,
      row.repo_path ?? null,
      row.uploaded ?? 0,
      row.file_size ?? null,
      row.created_at ?? null,
      row.content_hash ?? null,
      row.preview_hash ?? null,
      row.last_seen_at ?? null,
      row.last_uploaded_at ?? null,
      row.last_error ?? null,
    ]
  );
}

function mapRowToAsset(record: AssetRow): AssetRecord {
  return {
    fingerprint: record.fingerprint,
    assetId: record.asset_id,
    repoPath: record.repo_path,
    uploaded: record.uploaded === 1,
    fileSize: record.file_size ?? null,
    createdAt: record.created_at ?? null,
    contentHash: record.content_hash ?? null,
    previewHash: record.preview_hash ?? null,
    lastSeenAt: record.last_seen_at ?? null,
    lastUploadedAt: record.last_uploaded_at ?? null,
    lastError: record.last_error ?? null,
  };
}

export async function saveAsset(record: AssetRecord): Promise<void> {
  const database = await openDatabase();
  const uploaded = record.uploaded === true ? 1 : record.uploaded === false ? 0 : undefined;
  await upsertAssetRow(database, {
    fingerprint: record.fingerprint,
    asset_id: record.assetId ?? null,
    repo_path: record.repoPath ?? null,
    uploaded: uploaded ?? (record.uploaded ? 1 : 0),
    file_size: record.fileSize ?? null,
    created_at: record.createdAt ?? null,
    content_hash: record.contentHash ?? null,
    preview_hash: record.previewHash ?? null,
    last_seen_at: record.lastSeenAt ?? Date.now(),
    last_uploaded_at: record.lastUploadedAt ?? null,
    last_error: record.lastError ?? null,
  });
}

export async function touchAsset(fingerprint: string, values: Partial<Omit<AssetRecord, 'fingerprint'>> = {}): Promise<void> {
  const database = await openDatabase();
  const existing = await database.getFirstAsync<AssetRow>('SELECT * FROM assets WHERE fingerprint = ?', [fingerprint]);
  if (!existing) {
    await saveAsset({ fingerprint, ...values, lastSeenAt: values.lastSeenAt ?? Date.now() });
    return;
  }
  const merged: AssetRow = {
    fingerprint,
    asset_id: values.assetId ?? existing.asset_id,
    repo_path: values.repoPath ?? existing.repo_path,
    uploaded: typeof values.uploaded === 'boolean' ? (values.uploaded ? 1 : 0) : existing.uploaded,
    file_size: values.fileSize ?? existing.file_size,
    created_at: values.createdAt ?? existing.created_at,
    content_hash: values.contentHash ?? existing.content_hash,
    preview_hash: values.previewHash ?? existing.preview_hash,
    last_seen_at: values.lastSeenAt ?? Date.now(),
    last_uploaded_at: values.lastUploadedAt ?? existing.last_uploaded_at,
    last_error: values.lastError ?? existing.last_error,
  };
  await upsertAssetRow(database, merged);
}

export async function getAsset(fingerprint: string): Promise<AssetRecord | null> {
  const database = await openDatabase();
  const row = await database.getFirstAsync<AssetRow>('SELECT * FROM assets WHERE fingerprint = ?', [fingerprint]);
  if (!row) return null;
  return mapRowToAsset(row);
}

export async function getAssets(filter: AssetFilter = {}): Promise<AssetRecord[]> {
  const database = await openDatabase();
  const clauses: string[] = [];
  const params: any[] = [];

  if (typeof filter.uploaded === 'boolean') {
    clauses.push('uploaded = ?');
    params.push(filter.uploaded ? 1 : 0);
  }

  if (filter.cursor) {
    clauses.push('(last_seen_at < ? OR (last_seen_at = ? AND fingerprint < ?))');
    params.push(filter.cursor.lastSeenAt);
    params.push(filter.cursor.lastSeenAt);
    params.push(filter.cursor.fingerprint);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filter.limit && filter.limit > 0 ? `LIMIT ${filter.limit}` : '';

  const rows = await database.getAllAsync<AssetRow>(
    `SELECT * FROM assets ${where} ORDER BY last_seen_at DESC, fingerprint DESC ${limit}`,
    params
  );
  return rows.map(mapRowToAsset);
}

export async function getPendingAssets(limit = 100): Promise<AssetRecord[]> {
  return getAssets({ uploaded: false, limit });
}

export async function markUploaded(fingerprint: string, repoPath: string | null, contentHash?: string | null): Promise<void> {
  const database = await openDatabase();
  await database.runAsync(
    'UPDATE assets SET uploaded = 1, repo_path = COALESCE(?, repo_path), content_hash = COALESCE(?, content_hash), last_uploaded_at = ?, last_error = NULL WHERE fingerprint = ?',
    [repoPath ?? null, contentHash ?? null, Date.now(), fingerprint]
  );
}

export async function recordFailure(fingerprint: string, errorMessage: string): Promise<void> {
  const database = await openDatabase();
  await database.runAsync(
    'UPDATE assets SET last_error = ?, uploaded = 0 WHERE fingerprint = ?',
    [errorMessage.slice(0, 500), fingerprint]
  );
}

export async function deleteAsset(fingerprint: string): Promise<void> {
  const database = await openDatabase();
  await database.runAsync('DELETE FROM assets WHERE fingerprint = ?', [fingerprint]);
}

export async function deleteAssetsNotSeenSince(timestamp: number): Promise<number> {
  const database = await openDatabase();
  const result = await database.runAsync(
    'DELETE FROM assets WHERE last_seen_at IS NOT NULL AND last_seen_at < ?',
    [timestamp]
  );
  return typeof result.changes === 'number' ? result.changes : 0;
}

export async function resetStore(): Promise<void> {
  const database = await openDatabase();
  await database.execAsync(`
    DELETE FROM assets;
    DELETE FROM kv_store;
    DELETE FROM auto_sync_blocklist;
  `);
}

export async function addAutoSyncBlock(fingerprint: string): Promise<void> {
  const database = await openDatabase();
  await database.runAsync(
    'INSERT OR REPLACE INTO auto_sync_blocklist (fingerprint, blocked_at) VALUES (?, ?)',
    [fingerprint, Date.now()]
  );
}

export async function removeAutoSyncBlock(fingerprint: string): Promise<void> {
  const database = await openDatabase();
  await database.runAsync('DELETE FROM auto_sync_blocklist WHERE fingerprint = ?', [fingerprint]);
}

export async function getAutoSyncBlocklist(): Promise<string[]> {
  const database = await openDatabase();
  const rows = await database.getAllAsync<{ fingerprint: string }>('SELECT fingerprint FROM auto_sync_blocklist');
  return rows.map((row) => row.fingerprint).filter((fp) => typeof fp === 'string' && fp.length > 0);
}

export async function clearAutoSyncBlocklist(): Promise<void> {
  const database = await openDatabase();
  await database.runAsync('DELETE FROM auto_sync_blocklist');
}

export async function getKey(key: LocalStoreKey): Promise<string | null> {
  const database = await openDatabase();
  const row = await database.getFirstAsync<{ value: string | null }>('SELECT value FROM kv_store WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setKey(key: LocalStoreKey, value: string): Promise<void> {
  const database = await openDatabase();
  await database.runAsync('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)', [key, value]);
}

export async function deleteKey(key: LocalStoreKey): Promise<void> {
  const database = await openDatabase();
  await database.runAsync('DELETE FROM kv_store WHERE key = ?', [key]);
}

export async function closeStore(): Promise<void> {
  if (!dbInstance) return;
  await dbInstance.closeAsync();
  dbInstance = null;
  dbInitPromise = null;
}
