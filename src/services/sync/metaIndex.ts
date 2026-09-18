import { Buffer } from 'buffer';
import type { Octokit } from '@octokit/rest';
import type { RepoInfo, MetaEntry } from './types';
import { resolveBranch } from './utils';

const META_ROOT = 'gitgallery/meta';
const META_MANIFEST_PATH = `${META_ROOT}/manifest.json`;
const LEGACY_META_SHARD_DIR = `${META_ROOT}/shards`;
const SHARD_FILENAME = 'meta_dict.json';

const MANIFEST_VERSION = 1;
const SHARD_VERSION = 1;
const DEFAULT_PRELOAD_TARGET = 450;

type ManifestShardInfo = {
	path: string;
	count: number;
	updatedAt: number;
	sha?: string | null;
};

type MetaManifest = {
	version: number;
	updatedAt: number;
	shards: Record<string, ManifestShardInfo>;
};

type MetaShardEntry = MetaEntry & { updatedAt: number };

type MetaShardDocument = {
	version: number;
	bucket: string;
	generatedAt: number;
	entries: Record<string, MetaShardEntry>;
};

type ShardCacheEntry = {
	bucket: string;
	path: string;
	sha?: string | null;
	count: number;
	updatedAt: number;
	doc: MetaShardDocument | null;
	loaded: boolean;
};

type Cache = {
	manifest: MetaManifest;
	manifestSha?: string | null;
	shards: Map<string, ShardCacheEntry>;
	fetchedAt: number;
};

let cache: Cache | null = null;

const metaByFingerprint = new Map<string, MetaEntry & { updatedAt?: number }>();
const pathToFingerprint = new Map<string, string>();
const fingerprintToBucket = new Map<string, string>();
const bucketToFingerprints = new Map<string, Set<string>>();
const fingerprintToPaths = new Map<string, Set<string>>();

function encode(value: unknown): string {
	const json = JSON.stringify(value, null, 2);
	return Buffer.from(json, 'utf-8').toString('base64');
}

function decode<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function toNumber(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	return fallback;
}

function toNullableNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	return null;
}

function toOptionalString(value: unknown): string | null {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	return null;
}

function sanitizeBucket(bucket: string): string {
	const safe = bucket?.trim().toLowerCase() ?? '';
	const cleaned = safe.replace(/[^0-9a-z-]/g, '-');
	return cleaned || 'unknown';
}

function normalizeManifest(input?: Partial<MetaManifest> | null): MetaManifest {
	const shards: Record<string, ManifestShardInfo> = {};
	if (input?.shards && typeof input.shards === 'object') {
		for (const [key, rawInfo] of Object.entries(input.shards)) {
			if (!rawInfo || typeof rawInfo !== 'object') continue;
			const bucket = sanitizeBucket(key);
			const path =
				typeof (rawInfo as any).path === 'string' && (rawInfo as any).path.length > 0
					? (rawInfo as any).path
					: getShardPath(bucket);
			const count = toNumber((rawInfo as any).count, 0);
			const updatedAt = toNumber((rawInfo as any).updatedAt, 0);
			const sha = typeof (rawInfo as any).sha === 'string' ? (rawInfo as any).sha : null;
			shards[bucket] = { path, count, updatedAt, sha };
		}
	}
	return {
		version: toNumber(input?.version, MANIFEST_VERSION),
		updatedAt: toNumber(input?.updatedAt, Date.now()),
		shards,
	};
}

function normalizeShardDocument(bucket: string, input?: Partial<MetaShardDocument> | null): MetaShardDocument {
	const now = Date.now();
	const docBucket =
		typeof input?.bucket === 'string' && input.bucket.length > 0 ? sanitizeBucket(input.bucket) : sanitizeBucket(bucket);
	const entries: Record<string, MetaShardEntry> = {};
	if (input?.entries && typeof input.entries === 'object') {
		for (const [key, rawValue] of Object.entries(input.entries)) {
			if (!rawValue || typeof rawValue !== 'object') continue;
			const fingerprint =
				typeof (rawValue as any).fingerprint === 'string' && (rawValue as any).fingerprint.length > 0
					? (rawValue as any).fingerprint
					: key;
			if (!fingerprint) continue;
			const repoPath = toOptionalString((rawValue as any).repoPath);
			if (!repoPath) continue;
			const previewRepoPath = toOptionalString((rawValue as any).previewRepoPath);
			const createdAt = toNullableNumber((rawValue as any).createdAt);
			const fileSize = toNullableNumber((rawValue as any).fileSize);
			const contentHash = toOptionalString((rawValue as any).contentHash);
			const uploadedAt = toNullableNumber((rawValue as any).uploadedAt);
			const assetId = toOptionalString((rawValue as any).assetId);
			const updatedAt = toNumber((rawValue as any).updatedAt, now);
			entries[fingerprint] = {
				fingerprint,
				repoPath,
				previewRepoPath,
				createdAt,
				fileSize,
				contentHash,
				uploadedAt,
				assetId,
				updatedAt,
			};
		}
	}
	return {
		version: toNumber(input?.version, SHARD_VERSION),
		bucket: docBucket,
		generatedAt: toNumber(input?.generatedAt, now),
		entries,
	};
}

function makeEmptyShard(bucket: string): MetaShardDocument {
	return {
		version: SHARD_VERSION,
		bucket: sanitizeBucket(bucket),
		generatedAt: Date.now(),
		entries: {},
	};
}

function bucketDateParts(bucket: string): { year: string; month: string; day: string } | null {
	const match = bucket.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	return { year: match[1], month: match[2], day: match[3] };
}

function getShardPath(bucket: string): string {
	const parts = bucketDateParts(bucket);
	if (parts) {
		return `${META_ROOT}/${parts.year}/${parts.month}/${parts.day}/${SHARD_FILENAME}`;
	}
	if (bucket === 'unknown') {
		return `${META_ROOT}/unknown/${SHARD_FILENAME}`;
	}
	return `${LEGACY_META_SHARD_DIR}/${sanitizeBucket(bucket)}.json`;
}

function bucketFromTimestamp(value: number | null | undefined): string {
	if (!value || !Number.isFinite(value)) return 'unknown';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'unknown';
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function bucketFromFingerprint(fingerprint: string): string {
	const parts = fingerprint.split('|');
	if (parts.length >= 2) {
		const timestamp = Number(parts[1]);
		if (Number.isFinite(timestamp)) {
			return bucketFromTimestamp(timestamp);
		}
	}
	return 'unknown';
}

function bucketFromRepoPath(path: string | null | undefined): string {
	if (!path) return 'unknown';
	const fullMatch = path.match(/gitgallery\/library\/(\d{4})\/(\d{2})\/(\d{2})\//);
	if (fullMatch) {
		return `${fullMatch[1]}-${fullMatch[2]}-${fullMatch[3]}`;
	}
	return 'unknown';
}

function resolveBucket(entry: MetaEntry): string {
	const candidates = [
		bucketFromTimestamp(entry.createdAt ?? null),
		bucketFromTimestamp(entry.uploadedAt ?? null),
		bucketFromRepoPath(entry.repoPath ?? null),
		bucketFromFingerprint(entry.fingerprint),
	];
	const resolved = candidates.find((value) => value !== 'unknown') ?? 'unknown';
	return sanitizeBucket(resolved);
}

function sortBucketsByFreshness(shards: Iterable<ShardCacheEntry>): string[] {
	return [...shards]
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.bucket.localeCompare(a.bucket))
		.map((entry) => entry.bucket);
}

function registerPaths(fingerprint: string, paths: Array<string | null | undefined>): void {
	const set = new Set<string>();
	for (const path of paths) {
		if (!path) continue;
		pathToFingerprint.set(path, fingerprint);
		set.add(path);
	}
	if (set.size > 0) {
		fingerprintToPaths.set(fingerprint, set);
	} else {
		fingerprintToPaths.delete(fingerprint);
	}
}

function removeEntryFromCache(fingerprint: string): void {
	metaByFingerprint.delete(fingerprint);
	const bucket = fingerprintToBucket.get(fingerprint);
	if (bucket) {
		const set = bucketToFingerprints.get(bucket);
		if (set) {
			set.delete(fingerprint);
			if (set.size === 0) {
				bucketToFingerprints.delete(bucket);
			}
		}
	}
	fingerprintToBucket.delete(fingerprint);
	const paths = fingerprintToPaths.get(fingerprint);
	if (paths) {
		for (const path of paths) {
			pathToFingerprint.delete(path);
		}
		fingerprintToPaths.delete(fingerprint);
	}
}

function evictBucketEntries(bucket: string): void {
	const fingerprints = bucketToFingerprints.get(bucket);
	if (!fingerprints) return;
	for (const fingerprint of Array.from(fingerprints)) {
		removeEntryFromCache(fingerprint);
	}
}

function ingestShardDocument(doc: MetaShardDocument): void {
	evictBucketEntries(doc.bucket);
	const bucketSet = new Set<string>();
	for (const entry of Object.values(doc.entries)) {
		if (!entry?.fingerprint) continue;
		const cachedEntry: MetaEntry & { updatedAt?: number } = { ...entry };
		metaByFingerprint.set(entry.fingerprint, cachedEntry);
		fingerprintToBucket.set(entry.fingerprint, doc.bucket);
		bucketSet.add(entry.fingerprint);
		registerPaths(entry.fingerprint, [entry.repoPath, entry.previewRepoPath]);
	}
	if (bucketSet.size > 0) {
		bucketToFingerprints.set(doc.bucket, bucketSet);
	} else {
		bucketToFingerprints.delete(doc.bucket);
	}
}

async function fetchManifest(octokit: Octokit, repo: RepoInfo): Promise<{ manifest: MetaManifest; sha?: string | null }> {
	const branch = resolveBranch(repo.branch);
	const result = await octokit.repos.getContent({
		owner: repo.owner,
		repo: repo.name,
		path: META_MANIFEST_PATH,
		ref: branch,
	});
	if (Array.isArray(result.data)) {
		return { manifest: normalizeManifest(null) };
	}
	const data = result.data as any;
	const raw = Buffer.from(String(data.content).replace(/\s/g, ''), 'base64').toString('utf-8');
	const manifest = normalizeManifest(decode<MetaManifest>(raw));
	return { manifest, sha: data.sha ?? null };
}

async function writeManifest(
	octokit: Octokit,
	repo: RepoInfo,
	manifest: MetaManifest,
	sha?: string | null,
	message = 'Update GitGallery meta manifest',
): Promise<string | null> {
	const branch = resolveBranch(repo.branch);
	const payload: MetaManifest = {
		version: MANIFEST_VERSION,
		updatedAt: manifest.updatedAt,
		shards: manifest.shards,
	};
	const response = await octokit.repos.createOrUpdateFileContents({
		owner: repo.owner,
		repo: repo.name,
		branch,
		path: META_MANIFEST_PATH,
		content: encode(payload),
		message,
		sha: sha ?? undefined,
	});
	return response.data.content?.sha ?? null;
}

async function fetchShardDocument(
	octokit: Octokit,
	repo: RepoInfo,
	bucket: string,
	path: string,
): Promise<{ doc: MetaShardDocument; sha?: string | null }> {
	const branch = resolveBranch(repo.branch);
	try {
		const result = await octokit.repos.getContent({
			owner: repo.owner,
			repo: repo.name,
			path,
			ref: branch,
		});
		if (Array.isArray(result.data)) {
			return { doc: makeEmptyShard(bucket) };
		}
		const data = result.data as any;
		const raw = Buffer.from(String(data.content).replace(/\s/g, ''), 'base64').toString('utf-8');
		const parsed = decode<MetaShardDocument>(raw);
		const doc = normalizeShardDocument(bucket, parsed ?? undefined);
		return { doc, sha: data.sha ?? null };
	} catch (error: any) {
		if (error?.status === 404) {
			return { doc: makeEmptyShard(bucket) };
		}
		throw error;
	}
}

async function persistShard(octokit: Octokit, repo: RepoInfo, shard: ShardCacheEntry, message: string): Promise<void> {
	if (!shard.doc) {
		shard.doc = makeEmptyShard(shard.bucket);
	}
	shard.doc.bucket = sanitizeBucket(shard.bucket);
	shard.doc.version = SHARD_VERSION;
	shard.doc.generatedAt = Date.now();

	const branch = resolveBranch(repo.branch);
	const response = await octokit.repos.createOrUpdateFileContents({
		owner: repo.owner,
		repo: repo.name,
		branch,
		path: shard.path,
		content: encode(shard.doc),
		message,
		sha: shard.sha ?? undefined,
	});

	shard.sha = response.data.content?.sha ?? null;
	shard.count = Object.keys(shard.doc.entries).length;
	shard.updatedAt = shard.doc.generatedAt;
	shard.loaded = true;
}

async function deleteShardFile(octokit: Octokit, repo: RepoInfo, shard: ShardCacheEntry): Promise<void> {
	if (!shard.sha) return;
	const branch = resolveBranch(repo.branch);
	await octokit.repos.deleteFile({
		owner: repo.owner,
		repo: repo.name,
		branch,
		path: shard.path,
		sha: shard.sha,
		message: `Delete meta shard ${shard.bucket}`,
	});
}

function bucketFromShardFilePath(path: string | null | undefined): string | null {
	if (!path) return null;
	const normalized = path.replace(/\\/g, '/');
	const datedMatch = normalized.match(/^gitgallery\/meta\/(\d{4})\/(\d{2})\/(\d{2})\/${SHARD_FILENAME}$/);
	if (datedMatch) {
		return `${datedMatch[1]}-${datedMatch[2]}-${datedMatch[3]}`;
	}
	const unknownMatch = normalized.match(/^gitgallery\/meta\/unknown\/${SHARD_FILENAME}$/);
	if (unknownMatch) {
		return 'unknown';
	}
	const legacyMatch = normalized.match(/^gitgallery\/meta\/shards\/(.+)\.json$/);
	if (legacyMatch) {
		return sanitizeBucket(legacyMatch[1]);
	}
	const miscMatch = normalized.match(/^gitgallery\/meta\/misc\/(.+)\/${SHARD_FILENAME}$/);
	if (miscMatch) {
		return sanitizeBucket(miscMatch[1]);
	}
	return null;
}

async function listShardFiles(octokit: Octokit, repo: RepoInfo): Promise<Array<{ bucket: string; path: string }>> {
	const branch = resolveBranch(repo.branch);
	const files: Array<{ bucket: string; path: string }> = [];

	const walk = async (path: string): Promise<void> => {
		let response;
		try {
			response = await octokit.repos.getContent({
				owner: repo.owner,
				repo: repo.name,
				path,
				ref: branch,
			});
		} catch (error: any) {
			if (error?.status === 404) return;
			throw error;
		}

		if (!Array.isArray(response.data)) {
			const file = response.data as any;
			const bucket = bucketFromShardFilePath(file.path ?? path);
			if (bucket) {
				files.push({ bucket, path: file.path ?? path });
			}
			return;
		}

		for (const item of response.data) {
			if (item.type === 'dir') {
				await walk(item.path);
			} else if (item.type === 'file') {
				const bucket = bucketFromShardFilePath(item.path);
				if (bucket) {
					files.push({ bucket, path: item.path });
				}
			}
		}
	};

	await walk(META_ROOT);
	return files;
}

async function buildManifestFromExistingShards(
	octokit: Octokit,
	repo: RepoInfo,
): Promise<{ manifest: MetaManifest; shards: Map<string, ShardCacheEntry> }> {
	const files = await listShardFiles(octokit, repo);
	const shards = new Map<string, ShardCacheEntry>();
	const manifest: MetaManifest = {
		version: MANIFEST_VERSION,
		updatedAt: Date.now(),
		shards: {},
	};

	for (const file of files) {
		const { doc, sha } = await fetchShardDocument(octokit, repo, file.bucket, file.path);
		const shard: ShardCacheEntry = {
			bucket: doc.bucket,
			path: file.path,
			sha: sha ?? undefined,
			count: Object.keys(doc.entries).length,
			updatedAt: doc.generatedAt,
			doc,
			loaded: true,
		};
		shards.set(doc.bucket, shard);
		manifest.shards[doc.bucket] = {
			path: file.path,
			count: shard.count,
			updatedAt: shard.updatedAt,
			sha: shard.sha ?? null,
		};
		ingestShardDocument(doc);
	}

	return { manifest, shards };
}

async function ensureBaseState(octokit: Octokit, repo: RepoInfo): Promise<Cache> {
	if (cache) return cache;

	metaByFingerprint.clear();
	pathToFingerprint.clear();
	fingerprintToBucket.clear();
	bucketToFingerprints.clear();
	fingerprintToPaths.clear();

	let manifestResult: { manifest: MetaManifest; sha?: string | null } | null = null;
	try {
		manifestResult = await fetchManifest(octokit, repo);
	} catch (error: any) {
		if (error?.status !== 404) {
			throw error;
		}
	}

	const shards = new Map<string, ShardCacheEntry>();
	let manifest: MetaManifest;
	let manifestSha: string | null | undefined = null;

	if (!manifestResult) {
		const existing = await buildManifestFromExistingShards(octokit, repo);
		manifest = existing.manifest;
		manifestSha = await writeManifest(octokit, repo, manifest, null, 'Create GitGallery meta manifest');
		for (const shard of existing.shards.values()) {
			shards.set(shard.bucket, shard);
		}
	} else {
		manifest = normalizeManifest(manifestResult.manifest);
		manifestSha = manifestResult.sha ?? null;
		for (const [bucket, info] of Object.entries(manifest.shards)) {
			shards.set(bucket, {
				bucket,
				path: info.path,
				sha: info.sha ?? undefined,
				count: info.count,
				updatedAt: info.updatedAt,
				doc: null,
				loaded: false,
			});
		}
	}

	cache = {
		manifest,
		manifestSha: manifestSha ?? null,
		shards,
		fetchedAt: Date.now(),
	};

	return cache;
}

async function ensureShardLoaded(octokit: Octokit, repo: RepoInfo, bucket: string): Promise<ShardCacheEntry> {
	const state = await ensureBaseState(octokit, repo);
	const key = sanitizeBucket(bucket);
	let shard = state.shards.get(key);
	if (!shard) {
		shard = {
			bucket: key,
			path: getShardPath(key),
			sha: undefined,
			count: 0,
			updatedAt: 0,
			doc: null,
			loaded: false,
		};
		state.shards.set(key, shard);
	}
	if (shard.loaded && shard.doc) {
		return shard;
	}
	const { doc, sha } = await fetchShardDocument(octokit, repo, key, shard.path);
	shard.doc = doc;
	shard.sha = sha ?? undefined;
	shard.count = Object.keys(doc.entries).length;
	shard.updatedAt = doc.generatedAt;
	shard.loaded = true;
	if (shard.count > 0) {
		ingestShardDocument(doc);
	} else {
		evictBucketEntries(key);
	}
	markManifestEntry(state, key, shard);
	return shard;
}

async function preloadRecentShards(octokit: Octokit, repo: RepoInfo, targetEntries = DEFAULT_PRELOAD_TARGET): Promise<void> {
	const state = await ensureBaseState(octokit, repo);
	if (metaByFingerprint.size >= targetEntries) return;
	const orderedBuckets = sortBucketsByFreshness(state.shards.values());
	for (const bucket of orderedBuckets) {
		if (metaByFingerprint.size >= targetEntries) {
			break;
		}
		const shard = state.shards.get(bucket);
		if (!shard) continue;
		if (!shard.loaded) {
			await ensureShardLoaded(octokit, repo, bucket);
		} else if (shard.doc) {
			ingestShardDocument(shard.doc);
		}
	}
}

function markManifestEntry(state: Cache, bucket: string, shard: ShardCacheEntry | null): void {
	if (!shard) {
		delete state.manifest.shards[bucket];
		return;
	}
	state.manifest.shards[bucket] = {
		path: shard.path,
		count: shard.count,
		updatedAt: shard.updatedAt,
		sha: shard.sha ?? null,
	};
}

export function invalidateMetaCache(): void {
	cache = null;
	metaByFingerprint.clear();
	pathToFingerprint.clear();
	fingerprintToBucket.clear();
	bucketToFingerprints.clear();
	fingerprintToPaths.clear();
}

export async function loadMetaIndex(octokit: Octokit, repo: RepoInfo): Promise<Cache> {
	const state = await ensureBaseState(octokit, repo);
	await preloadRecentShards(octokit, repo);
	return state;
}

export async function ensureAllMetaShardsLoaded(octokit: Octokit, repo: RepoInfo): Promise<void> {
	const state = await ensureBaseState(octokit, repo);
	const orderedBuckets = sortBucketsByFreshness(state.shards.values());
	for (const bucket of orderedBuckets) {
		await ensureShardLoaded(octokit, repo, bucket);
	}
}

export function getCachedMetaEntries(limit?: number): MetaEntry[] {
	const entries = Array.from(metaByFingerprint.values()).sort(
		(a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0),
	);
	if (!limit || limit <= 0) {
		return entries;
	}
	return entries.slice(0, limit);
}

export function getMetaEntryFromCache(fingerprintOrPath: string): MetaEntry | null {
	const direct = metaByFingerprint.get(fingerprintOrPath);
	if (direct) return direct;
	const resolved = pathToFingerprint.get(fingerprintOrPath);
	if (!resolved) return null;
	return metaByFingerprint.get(resolved) ?? null;
}

export async function removeMetaEntries(octokit: Octokit, repo: RepoInfo, fingerprints: string[]): Promise<void> {
	if (fingerprints.length === 0) return;
	const state = await ensureBaseState(octokit, repo);
	const grouped = new Map<string, string[]>();
	for (const fingerprint of fingerprints) {
		const bucket = fingerprintToBucket.get(fingerprint) ?? bucketFromFingerprint(fingerprint);
		const key = sanitizeBucket(bucket);
		const list = grouped.get(key) ?? [];
		list.push(fingerprint);
		grouped.set(key, list);
	}

	let manifestDirty = false;

	for (const [bucket, list] of grouped.entries()) {
		const shard = await ensureShardLoaded(octokit, repo, bucket);
		if (!shard.doc) continue;
		let changed = false;
		for (const fingerprint of list) {
			if (shard.doc.entries[fingerprint]) {
				delete shard.doc.entries[fingerprint];
				removeEntryFromCache(fingerprint);
				changed = true;
			}
		}
		if (!changed) continue;

		shard.count = Object.keys(shard.doc.entries).length;
		shard.doc.generatedAt = Date.now();
		shard.updatedAt = shard.doc.generatedAt;

		if (shard.count === 0) {
			await deleteShardFile(octokit, repo, shard);
			state.shards.delete(bucket);
			evictBucketEntries(bucket);
			markManifestEntry(state, bucket, null);
			manifestDirty = true;
		} else {
			await persistShard(octokit, repo, shard, `Update meta shard ${bucket}`);
			ingestShardDocument(shard.doc);
			markManifestEntry(state, bucket, shard);
			manifestDirty = true;
		}
	}

	if (manifestDirty) {
		state.manifest.updatedAt = Date.now();
		state.manifestSha = await writeManifest(octokit, repo, state.manifest, state.manifestSha, 'Update GitGallery meta manifest');
	}
}

export async function upsertMetaEntry(octokit: Octokit, repo: RepoInfo, entry: MetaEntry): Promise<void> {
	const state = await ensureBaseState(octokit, repo);
	const bucket = resolveBucket(entry);
	const shard = await ensureShardLoaded(octokit, repo, bucket);
	if (!shard.doc) {
		shard.doc = makeEmptyShard(bucket);
	}

	shard.doc.entries[entry.fingerprint] = {
		...entry,
		updatedAt: Date.now(),
	};
	shard.doc.generatedAt = Date.now();
	shard.count = Object.keys(shard.doc.entries).length;
	shard.updatedAt = shard.doc.generatedAt;

	await persistShard(octokit, repo, shard, `Update meta shard ${bucket}`);
	ingestShardDocument(shard.doc);
	markManifestEntry(state, bucket, shard);
	state.manifest.updatedAt = Date.now();
	state.manifestSha = await writeManifest(octokit, repo, state.manifest, state.manifestSha, 'Update GitGallery meta manifest');
}

