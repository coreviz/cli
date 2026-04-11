/**
 * CoreViz Local Sync State Manager
 *
 * Manages the `.coreviz/local-sync.json` file that maps local file paths
 * to CoreViz cloud media IDs and caches enriched metadata (descriptions,
 * auto-tags, detected objects) so tools can answer questions without
 * re-querying the cloud on every call.
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join, extname, relative, basename, dirname } from 'path';

const SYNC_DIR = '.coreviz';
const SYNC_FILE = 'local-sync.json';
const GITIGNORE_FILE = '.gitignore';

const MEDIA_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic',
    '.mp4', '.mov', '.webm',
]);

// ── State I/O ────────────────────────────────────────────────────────────────

/** @returns {object} Parsed sync state, or a fresh empty state */
export function loadSyncState(dir) {
    const syncPath = join(dir, SYNC_DIR, SYNC_FILE);
    if (!existsSync(syncPath)) {
        return { collectionId: null, collectionName: null, syncedAt: null, files: {} };
    }
    try {
        return JSON.parse(readFileSync(syncPath, 'utf-8'));
    } catch {
        return { collectionId: null, collectionName: null, syncedAt: null, files: {} };
    }
}

/** Write sync state to disk, creating `.coreviz/` if needed */
export function saveSyncState(dir, state) {
    const syncDir = join(dir, SYNC_DIR);
    if (!existsSync(syncDir)) {
        mkdirSync(syncDir, { recursive: true });
        ensureGitignore(dir);
    }
    state.syncedAt = new Date().toISOString();
    writeFileSync(join(syncDir, SYNC_FILE), JSON.stringify(state, null, 2), 'utf-8');
}

/** Ensure `.coreviz/` is in `.gitignore` */
function ensureGitignore(dir) {
    const gitignorePath = join(dir, GITIGNORE_FILE);
    const entry = `\n# CoreViz local sync state\n.coreviz/\n`;

    if (!existsSync(gitignorePath)) {
        writeFileSync(gitignorePath, entry.trimStart(), 'utf-8');
        return;
    }

    const contents = readFileSync(gitignorePath, 'utf-8');
    if (!contents.includes('.coreviz/')) {
        appendFileSync(gitignorePath, entry);
    }
}

// ── File scanning ────────────────────────────────────────────────────────────

/**
 * Recursively scan a directory for media files.
 * Returns relative paths from `dir` (e.g. "photo.jpg", "vacation/beach.jpg").
 */
export function scanMediaFiles(dir) {
    const results = [];
    _walk(dir, dir, results);
    return results;
}

function _walk(baseDir, currentDir, results) {
    let entries;
    try {
        entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        // Skip hidden dirs and the sync state dir
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;

        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
            _walk(baseDir, fullPath, results);
        } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (MEDIA_EXTENSIONS.has(ext)) {
                results.push(relative(baseDir, fullPath));
            }
        }
    }
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/** Compute SHA-256 hex digest of a file's contents */
export function hashFile(filePath) {
    const buffer = readFileSync(filePath);
    return createHash('sha256').update(buffer).digest('hex');
}

// ── Sync state helpers ───────────────────────────────────────────────────────

/** Look up cloud mediaId for a local filename (relative path). Returns null if not synced. */
export function getMediaId(state, filename) {
    return state.files[filename]?.mediaId ?? null;
}

/** Return all file entries that have a mediaId */
export function getSyncedFiles(state) {
    return Object.entries(state.files)
        .filter(([, entry]) => entry.mediaId)
        .map(([filename, entry]) => ({ filename, ...entry }));
}

/** Mark a file as synced in the state (in-place mutation — call saveSyncState to persist) */
export function markSynced(state, filename, mediaId, hash) {
    state.files[filename] = {
        ...(state.files[filename] || {}),
        mediaId,
        hash,
        syncedAt: new Date().toISOString(),
    };
}

/** Store enriched cloud metadata for a file (in-place mutation) */
export function setEnriched(state, filename, enriched) {
    if (!state.files[filename]) return;
    state.files[filename].enriched = {
        ...enriched,
        enrichedAt: new Date().toISOString(),
    };
}

/** Update a file's key in the state (e.g. after rename or move) */
export function renameFileKey(state, oldFilename, newFilename) {
    if (!state.files[oldFilename]) return;
    state.files[newFilename] = state.files[oldFilename];
    delete state.files[oldFilename];
}

/** Remove a file entry from state */
export function removeFileEntry(state, filename) {
    delete state.files[filename];
}

// ── Upload orchestration helpers ─────────────────────────────────────────────

/**
 * Determine which local files need uploading:
 * - Not present in sync state
 * - Or present but hash has changed
 *
 * Returns array of relative filenames.
 */
export function findUnsyncedFiles(dir, state) {
    const allFiles = scanMediaFiles(dir);
    const toUpload = [];

    for (const filename of allFiles) {
        const entry = state.files[filename];
        if (!entry || !entry.mediaId) {
            toUpload.push(filename);
            continue;
        }
        // Check if file changed on disk since last sync
        try {
            const currentHash = hashFile(join(dir, filename));
            if (currentHash !== entry.hash) {
                toUpload.push(filename);
            }
        } catch {
            toUpload.push(filename);
        }
    }

    return toUpload;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Build a sanitized collection name from the directory basename */
export function collectionNameFromDir(dir) {
    return basename(dir).replace(/[^a-zA-Z0-9\s\-_]/g, '').trim() || 'local-folder';
}
