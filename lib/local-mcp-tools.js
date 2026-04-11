/**
 * CoreViz Local-Folder MCP tool definitions.
 *
 * All tools operate on local filenames (relative paths from the watched directory).
 * The sync state provides the cloud mediaId mapping. Enriched metadata cached in
 * the sync state lets Claude make decisions (e.g. organize by jersey number)
 * without re-querying the cloud on every call.
 */

import { z } from 'zod';
import { join, dirname, basename, extname } from 'path';
import { renameSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import {
    loadSyncState,
    saveSyncState,
    scanMediaFiles,
    hashFile,
    getMediaId,
    getSyncedFiles,
    markSynced,
    setEnriched,
    renameFileKey,
    removeFileEntry,
    findUnsyncedFiles,
} from './local-sync.js';

/** Build a text result object for MCP */
function text(value) {
    return {
        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    };
}

/** Wrap an async handler with consistent error reporting */
function safe(fn) {
    return async (args) => {
        try {
            return await fn(args);
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
                isError: true,
            };
        }
    };
}

/**
 * Pull cloud enrichment for a single mediaId and return a compact object.
 * Returns null if the fetch fails (non-fatal).
 */
async function fetchEnrichment(sdk, mediaId) {
    try {
        const media = await sdk.media.get(mediaId);
        return {
            description: media.metadata?.description ?? null,
            tags: media.metadata?.tags ?? null,
            objects: media.frames
                ? media.frames.flatMap(f => f.objects || [])
                : [],
            width: media.width ?? null,
            height: media.height ?? null,
            blobUrl: media.blob ?? null,
        };
    } catch {
        return null;
    }
}

/**
 * Upload a single file to CoreViz, fetch enrichment, and update sync state.
 * Caller must call saveSyncState() after.
 */
async function uploadAndEnrich(sdk, dir, filename, state) {
    const fullPath = join(dir, filename);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${filename}`);

    const hash = hashFile(fullPath);
    const collectionId = state.collectionId;

    // Ensure cloud folder exists for subdirectories
    const subdir = dirname(filename);
    let uploadPath = collectionId;
    if (subdir && subdir !== '.') {
        const folder = await sdk.folders.create(collectionId, subdir, collectionId, true);
        uploadPath = folder.path;
    }

    const result = await sdk.media.upload(fullPath, {
        collectionId,
        path: uploadPath,
        name: basename(filename),
    });

    markSynced(state, filename, result.mediaId, hash);

    // Pull enrichment (best-effort — indexing may still be in progress)
    const enriched = await fetchEnrichment(sdk, result.mediaId);
    if (enriched) setEnriched(state, filename, enriched);

    return result.mediaId;
}

/**
 * Return a standard "file not synced" response that instructs Claude
 * to tell the user what will happen and offer to call upload_file.
 */
function notSyncedResponse(filename) {
    return text({
        error: 'not_synced',
        filename,
        message:
            `"${filename}" has not been uploaded to CoreViz yet. ` +
            `To use cloud features (search, analysis, editing), the file needs to be sent to the CoreViz cloud for processing. ` +
            `Call upload_file({ filename: "${filename}" }) to upload it, or sync_folder to upload all files in this folder.`,
    });
}

/**
 * Return a standard "no collection" response when the folder has never been synced.
 */
function noCollectionResponse() {
    return text({
        error: 'no_collection',
        message:
            'This folder has not been connected to CoreViz yet. ' +
            'Call sync_folder to create a collection and upload your files, ' +
            'or upload_file to upload a single file.',
    });
}

/**
 * Register all local-folder MCP tools on the given server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('@coreviz/sdk').CoreViz} sdk
 * @param {string} dir  Absolute path to the watched local directory
 */
export function registerLocalTools(server, sdk, dir) {

    // ── Discovery tools ───────────────────────────────────────────────────────

    server.tool(
        'list_files',
        'List all media files in the current folder. Works entirely from local disk — no cloud required. Returns filenames with any cached cloud-enriched metadata (AI descriptions, auto-tags, detected objects) if files have previously been uploaded to CoreViz. Unsynced files are included and clearly marked.',
        {
            folder: z.string().optional().describe('Optional subfolder to list (e.g. "vacation"). Defaults to all files in the folder.'),
        },
        safe(async ({ folder }) => {
            const state = loadSyncState(dir);
            const allFiles = scanMediaFiles(dir);
            const results = [];

            for (const filename of allFiles) {
                if (folder && !filename.startsWith(folder + '/') && !filename.startsWith(folder + '\\')) continue;

                const entry = state.files[filename];
                const isSynced = !!(entry?.mediaId);

                results.push({
                    filename,
                    synced: isSynced,
                    ...(isSynced ? {
                        description: entry?.enriched?.description ?? null,
                        tags: entry?.enriched?.tags ?? null,
                        objects: entry?.enriched?.objects ?? null,
                        width: entry?.enriched?.width ?? null,
                        height: entry?.enriched?.height ?? null,
                    } : {}),
                });
            }

            const syncedCount = results.filter(f => f.synced).length;
            const unsyncedCount = results.length - syncedCount;

            return text({
                folder: folder || '.',
                totalFiles: allFiles.length,
                syncedToCloud: syncedCount,
                notYetUploaded: unsyncedCount,
                note: unsyncedCount > 0
                    ? `${unsyncedCount} file(s) have not been uploaded to CoreViz yet. Cloud features (search, analysis, editing) require uploading. Use upload_file to upload a single file or sync_folder to upload all.`
                    : undefined,
                files: results,
            });
        })
    );

    server.tool(
        'upload_file',
        'Upload a single local file to CoreViz cloud for processing. The file will be sent to CoreViz servers where it will be indexed (CLIP embeddings, auto-description, object detection). Only call this after the user has agreed to send the file to the cloud.',
        {
            filename: z.string().describe('Local filename or relative path to upload (e.g. "photo.jpg" or "vacation/beach.jpg")'),
        },
        safe(async ({ filename }) => {
            let state = loadSyncState(dir);

            // Create collection on first upload
            if (!state.collectionId) {
                const { collectionNameFromDir } = await import('./local-sync.js');
                const name = collectionNameFromDir(dir);
                const collection = await sdk.collections.create(name, '📁');
                state.collectionId = collection.id;
                state.collectionName = collection.name;
            }

            const mediaId = await uploadAndEnrich(sdk, dir, filename, state);
            saveSyncState(dir, state);

            const enriched = state.files[filename]?.enriched;
            return text({
                uploaded: filename,
                mediaId,
                description: enriched?.description ?? null,
                tags: enriched?.tags ?? null,
                note: 'File is now available for search, analysis, and editing.',
            });
        })
    );

    server.tool(
        'search_files',
        'Semantically search synced files using natural language. Requires files to be uploaded to CoreViz first. Returns matching filenames with relevance scores and enriched metadata. Examples: "basketball dunk", "player wearing jersey 23", "sunset over water".',
        {
            query: z.string().describe('Natural language search query'),
            limit: z.number().optional().default(20).describe('Max results to return (default 20)'),
        },
        safe(async ({ query, limit }) => {
            const state = loadSyncState(dir);
            if (!state.collectionId) return noCollectionResponse();

            const result = await sdk.media.browse(state.collectionId, { q: query, limit });

            const mediaIdToFile = {};
            for (const [filename, entry] of Object.entries(state.files)) {
                if (entry.mediaId) mediaIdToFile[entry.mediaId] = filename;
            }

            const matches = (result.media || [])
                .map(m => ({
                    filename: mediaIdToFile[m.id] ?? null,
                    score: m._score ?? null,
                    description: state.files[mediaIdToFile[m.id]]?.enriched?.description ?? null,
                    tags: state.files[mediaIdToFile[m.id]]?.enriched?.tags ?? null,
                }))
                .filter(m => m.filename);

            return text({ query, matches });
        })
    );

    server.tool(
        'get_file',
        'Get details about a specific file. Returns local info for all files. For files already uploaded to CoreViz, also returns AI description, tags, detected objects, and a blob URL. Use refresh=true to re-fetch cloud metadata.',
        {
            filename: z.string().describe('Local filename or relative path (e.g. "photo.jpg" or "vacation/beach.jpg")'),
            refresh: z.boolean().optional().describe('When true, re-fetch enriched metadata from CoreViz (only for already-synced files)'),
        },
        safe(async ({ filename, refresh }) => {
            const state = loadSyncState(dir);
            const entry = state.files[filename];

            if (!entry?.mediaId) {
                const allFiles = scanMediaFiles(dir);
                const exists = allFiles.includes(filename);
                return text({
                    filename,
                    synced: false,
                    exists,
                    note: exists
                        ? `"${filename}" exists locally but has not been uploaded to CoreViz. Call upload_file({ filename: "${filename}" }) to enable cloud features.`
                        : `"${filename}" was not found in the folder.`,
                });
            }

            let enriched = entry.enriched;
            if (refresh || !enriched) {
                enriched = await fetchEnrichment(sdk, entry.mediaId);
                if (enriched) {
                    setEnriched(state, filename, enriched);
                    saveSyncState(dir, state);
                }
            }

            return text({
                filename,
                synced: true,
                mediaId: entry.mediaId,
                syncedAt: entry.syncedAt,
                ...enriched,
            });
        })
    );

    server.tool(
        'sync_folder',
        'Upload ALL files in the current folder that have not yet been sent to CoreViz, then refresh enriched metadata for all synced files. Only call this after the user has confirmed they want their files sent to the CoreViz cloud.',
        {},
        safe(async () => {
            let state = loadSyncState(dir);

            // Create collection if this is the first sync
            if (!state.collectionId) {
                const { collectionNameFromDir } = await import('./local-sync.js');
                const name = collectionNameFromDir(dir);
                const collection = await sdk.collections.create(name, '📁');
                state.collectionId = collection.id;
                state.collectionName = collection.name;
            }

            const toUpload = findUnsyncedFiles(dir, state);
            let uploaded = 0;
            const errors = [];

            for (const filename of toUpload) {
                try {
                    await uploadAndEnrich(sdk, dir, filename, state);
                    uploaded++;
                } catch (err) {
                    errors.push({ filename, error: err?.message || String(err) });
                }
            }

            // Refresh enrichment for already-synced files that lack it
            const allSynced = getSyncedFiles(state);
            let enrichedCount = 0;
            for (const { filename, mediaId, enriched: existing } of allSynced) {
                if (!existing) {
                    const data = await fetchEnrichment(sdk, mediaId);
                    if (data) {
                        setEnriched(state, filename, data);
                        enrichedCount++;
                    }
                }
            }

            saveSyncState(dir, state);

            return text({
                uploaded,
                enrichedMetadata: enrichedCount,
                errors: errors.length ? errors : undefined,
                totalSynced: getSyncedFiles(state).length,
            });
        })
    );

    // ── Organization tools ────────────────────────────────────────────────────

    server.tool(
        'create_folder',
        'Create a new subfolder in the current directory (both on disk and in CoreViz).',
        {
            name: z.string().describe('Subfolder name (e.g. "vacation", "portraits")'),
        },
        safe(async ({ name }) => {
            // Sanitize folder name
            const safeName = name.replace(/[/\\:*?"<>|]/g, '_').trim();
            if (!safeName) throw new Error('Invalid folder name');

            const state = loadSyncState(dir);

            // Create on disk
            const diskPath = join(dir, safeName);
            if (!existsSync(diskPath)) {
                mkdirSync(diskPath, { recursive: true });
            }

            // Create in CoreViz
            let cloudFolder = null;
            if (state.collectionId) {
                cloudFolder = await sdk.folders.create(state.collectionId, safeName, state.collectionId, true);
            }

            return text({
                created: safeName,
                diskPath,
                cloudFolderId: cloudFolder?.id ?? null,
                cloudPath: cloudFolder?.path ?? null,
            });
        })
    );

    server.tool(
        'move_file',
        'Move a file into a subfolder (on disk and in CoreViz). The subfolder is created if it does not exist.',
        {
            filename: z.string().describe('Current filename or relative path (e.g. "photo.jpg")'),
            folder: z.string().describe('Target subfolder name (e.g. "vacation")'),
        },
        safe(async ({ filename, folder }) => {
            const state = loadSyncState(dir);

            const srcPath = join(dir, filename);
            if (!existsSync(srcPath)) throw new Error(`File not found: ${filename}`);

            // Ensure destination folder exists on disk
            const destDir = join(dir, folder);
            if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

            const newFilename = `${folder}/${basename(filename)}`;
            const destPath = join(dir, newFilename);

            // Move on disk
            renameSync(srcPath, destPath);

            // Move in CoreViz
            const mediaId = getMediaId(state, filename);
            if (mediaId && state.collectionId) {
                // Ensure cloud folder exists
                const cloudFolder = await sdk.folders.create(state.collectionId, folder, state.collectionId, true);
                await sdk.media.move(mediaId, cloudFolder.path);
            }

            // Update sync state key
            renameFileKey(state, filename, newFilename);
            saveSyncState(dir, state);

            return text({ moved: filename, to: newFilename });
        })
    );

    server.tool(
        'rename_file',
        'Rename a file (on disk and in CoreViz).',
        {
            filename: z.string().describe('Current filename or relative path'),
            newName: z.string().describe('New filename (just the name, not a path). Extension can be changed.'),
        },
        safe(async ({ filename, newName }) => {
            const state = loadSyncState(dir);

            const srcPath = join(dir, filename);
            if (!existsSync(srcPath)) throw new Error(`File not found: ${filename}`);

            // Keep in same directory
            const parentDir = dirname(filename);
            const newRelative = parentDir === '.' ? newName : `${parentDir}/${newName}`;
            const destPath = join(dir, newRelative);

            renameSync(srcPath, destPath);

            // Rename in CoreViz
            const mediaId = getMediaId(state, filename);
            if (mediaId) {
                await sdk.media.rename(mediaId, newName);
            }

            renameFileKey(state, filename, newRelative);
            saveSyncState(dir, state);

            return text({ renamed: filename, to: newRelative });
        })
    );

    // ── Tagging tools ─────────────────────────────────────────────────────────

    server.tool(
        'add_tag',
        'Add a tag to a file. Tags are label+value pairs, e.g. label="jersey", value="23" or label="category", value="action-shot".',
        {
            filename: z.string().describe('Local filename or relative path'),
            label: z.string().describe('Tag group name (e.g. "jersey", "category", "quality")'),
            value: z.string().describe('Tag value (e.g. "23", "portrait", "high")'),
        },
        safe(async ({ filename, label, value }) => {
            const state = loadSyncState(dir);
            const mediaId = getMediaId(state, filename);
            if (!mediaId) return notSyncedResponse(filename);

            await sdk.media.addTag(mediaId, label, value);

            // Update cached tags in enriched metadata
            if (state.files[filename]?.enriched) {
                const tags = state.files[filename].enriched.tags || {};
                if (!tags[label]) tags[label] = [];
                if (!tags[label].includes(value)) tags[label].push(value);
                state.files[filename].enriched.tags = tags;
                saveSyncState(dir, state);
            }

            return text({ success: true, filename, tag: { label, value } });
        })
    );

    server.tool(
        'remove_tag',
        'Remove a specific tag from a file.',
        {
            filename: z.string().describe('Local filename or relative path'),
            label: z.string().describe('Tag group name'),
            value: z.string().describe('Tag value to remove'),
        },
        safe(async ({ filename, label, value }) => {
            const state = loadSyncState(dir);
            const mediaId = getMediaId(state, filename);
            if (!mediaId) return notSyncedResponse(filename);

            await sdk.media.removeTag(mediaId, label, value);

            // Update cached tags
            if (state.files[filename]?.enriched?.tags?.[label]) {
                state.files[filename].enriched.tags[label] =
                    state.files[filename].enriched.tags[label].filter(v => v !== value);
                saveSyncState(dir, state);
            }

            return text({ success: true, filename, removed: { label, value } });
        })
    );

    server.tool(
        'get_tags',
        'Get all tags aggregated across the entire folder collection, grouped by label.',
        {},
        safe(async () => {
            const state = loadSyncState(dir);
            if (!state.collectionId) {
                return text({ error: 'Folder not synced yet.' });
            }
            const tags = await sdk.tags.list(state.collectionId);
            return text(tags);
        })
    );

    server.tool(
        'bulk_tag',
        'Apply the same tag to multiple files at once.',
        {
            filenames: z.array(z.string()).describe('List of local filenames or relative paths'),
            label: z.string().describe('Tag group name'),
            value: z.string().describe('Tag value'),
        },
        safe(async ({ filenames, label, value }) => {
            const state = loadSyncState(dir);
            const results = [];
            let stateChanged = false;

            for (const filename of filenames) {
                const mediaId = getMediaId(state, filename);
                if (!mediaId) {
                    results.push({ filename, success: false, error: 'Not synced' });
                    continue;
                }
                try {
                    await sdk.media.addTag(mediaId, label, value);

                    // Update cached tags
                    if (state.files[filename]?.enriched) {
                        const tags = state.files[filename].enriched.tags || {};
                        if (!tags[label]) tags[label] = [];
                        if (!tags[label].includes(value)) tags[label].push(value);
                        state.files[filename].enriched.tags = tags;
                        stateChanged = true;
                    }

                    results.push({ filename, success: true });
                } catch (err) {
                    results.push({ filename, success: false, error: err?.message });
                }
            }

            if (stateChanged) saveSyncState(dir, state);

            return text({ label, value, results });
        })
    );

    // ── AI tools ──────────────────────────────────────────────────────────────

    server.tool(
        'analyze_image',
        'Analyze a local image using CoreViz cloud AI vision. The file must be uploaded to CoreViz first. Returns a detailed description cached in local sync state so future list_files calls include it without re-analysis.',
        {
            filename: z.string().describe('Local filename or relative path'),
            prompt: z.string().optional().default('Describe this image in detail.').describe('Optional question or prompt to guide the analysis'),
        },
        safe(async ({ filename, prompt }) => {
            const state = loadSyncState(dir);
            const mediaId = getMediaId(state, filename);
            if (!mediaId) return notSyncedResponse(filename);

            const media = await sdk.media.get(mediaId);
            if (!media.blob) throw new Error(`No blob URL available for "${filename}".`);

            const description = await sdk.describe(media.blob, { prompt });

            // Cache back into sync state
            if (!state.files[filename].enriched) state.files[filename].enriched = {};
            state.files[filename].enriched.description = description;
            state.files[filename].enriched.enrichedAt = new Date().toISOString();
            saveSyncState(dir, state);

            return text({ filename, description });
        })
    );

    server.tool(
        'find_similar',
        'Find images in the folder that are visually similar to a given file. Uses CoreViz CLIP embeddings. The reference file must be uploaded to CoreViz first.',
        {
            filename: z.string().describe('Local filename to use as the reference image'),
            limit: z.number().optional().default(10).describe('Max similar results to return'),
        },
        safe(async ({ filename, limit }) => {
            const state = loadSyncState(dir);
            if (!state.collectionId) return noCollectionResponse();

            const mediaId = getMediaId(state, filename);
            if (!mediaId) return notSyncedResponse(filename);

            // Get the media to find an object ID for similarity search
            const media = await sdk.media.get(mediaId);
            const objectId = media.frames?.[0]?.objects?.[0]?.id;

            if (!objectId) {
                // Fall back to browse with embedding similarity if no object detected
                return text({ error: 'No visual objects detected in this image for similarity search. Try analyze_image first.' });
            }

            const result = await sdk.media.findSimilar(state.collectionId, objectId, { limit });

            const mediaIdToFile = {};
            for (const [fn, entry] of Object.entries(state.files)) {
                if (entry.mediaId) mediaIdToFile[entry.mediaId] = fn;
            }

            const matches = (result.media || [])
                .map(m => ({
                    filename: mediaIdToFile[m.id] ?? null,
                    score: m._score ?? null,
                    description: state.files[mediaIdToFile[m.id]]?.enriched?.description ?? null,
                }))
                .filter(m => m.filename && m.filename !== filename);

            return text({ reference: filename, similar: matches });
        })
    );

    server.tool(
        'edit_image',
        'AI-edit a local image using a natural language instruction. Saves the result as "{name}-edited.jpg" alongside the original and uploads it to CoreViz. The file must be uploaded to CoreViz first. Examples: "make it black and white", "remove the background", "add dramatic lighting".',
        {
            filename: z.string().describe('Local filename or relative path to edit'),
            prompt: z.string().describe('Natural language edit instruction'),
            aspectRatio: z.enum(['match_input_image', '1:1', '16:9', '9:16', '4:3', '3:4']).optional().default('match_input_image').describe('Output aspect ratio'),
            model: z.enum(['flux-kontext-max', 'google/nano-banana', 'seedream-4']).optional().describe('AI model to use for editing'),
        },
        safe(async ({ filename, prompt, aspectRatio, model }) => {
            const state = loadSyncState(dir);
            const mediaId = getMediaId(state, filename);
            if (!mediaId) return notSyncedResponse(filename);

            const media = await sdk.media.get(mediaId);
            if (!media.blob) throw new Error(`No blob URL available for "${filename}".`);

            // Run cloud edit — returns a base64 data URL or a URL
            const resultUrl = await sdk.edit(media.blob, {
                prompt,
                aspectRatio: aspectRatio || 'match_input_image',
                outputFormat: 'jpg',
                model: model || 'flux-kontext-max',
            });

            // Determine output filename
            const base = basename(filename, extname(filename));
            const parentDir = dirname(filename);
            const editedName = `${base}-edited.jpg`;
            const editedRelative = parentDir === '.' ? editedName : `${parentDir}/${editedName}`;
            const editedPath = join(dir, editedRelative);

            // Decode and save to disk
            if (resultUrl.startsWith('data:')) {
                const base64Data = resultUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                writeFileSync(editedPath, buffer);
            } else {
                // Fetch URL and save
                const response = await fetch(resultUrl);
                if (!response.ok) throw new Error(`Failed to download edited image: ${response.status}`);
                const buffer = Buffer.from(await response.arrayBuffer());
                writeFileSync(editedPath, buffer);
            }

            // Upload edited file to CoreViz
            const uploadResult = await sdk.media.upload(editedPath, {
                collectionId: state.collectionId,
                name: editedName,
            });

            const hash = hashFile(editedPath);
            markSynced(state, editedRelative, uploadResult.mediaId, hash);
            saveSyncState(dir, state);

            return text({
                original: filename,
                edited: editedRelative,
                mediaId: uploadResult.mediaId,
                savedTo: editedPath,
            });
        })
    );

    server.tool(
        'auto_tag_image',
        'Use CoreViz cloud AI to automatically suggest and apply tags to a local image. The file must be uploaded to CoreViz first.',
        {
            filename: z.string().describe('Local filename or relative path'),
            prompt: z.string().describe('Tagging instruction, e.g. "What sport is shown?" or "Describe the scene in keywords"'),
            label: z.string().describe('Tag group label to apply the results under (e.g. "sport", "scene", "color")'),
            options: z.array(z.string()).optional().describe('Optional fixed list of tag values to choose from'),
            multiple: z.boolean().optional().default(true).describe('Allow multiple tags (default true)'),
        },
        safe(async ({ filename, prompt, label, options, multiple }) => {
            const state = loadSyncState(dir);
            const mediaId = getMediaId(state, filename);
            if (!mediaId) return notSyncedResponse(filename);

            const media = await sdk.media.get(mediaId);
            if (!media.blob) throw new Error(`No blob URL available for "${filename}".`);

            const tagResult = await sdk.tag(media.blob, { prompt, options, multiple });

            // Apply each suggested tag to the cloud media
            for (const value of tagResult.tags) {
                await sdk.media.addTag(mediaId, label, value);
            }

            // Cache back
            if (!state.files[filename].enriched) state.files[filename].enriched = {};
            const tags = state.files[filename].enriched.tags || {};
            if (!tags[label]) tags[label] = [];
            for (const v of tagResult.tags) {
                if (!tags[label].includes(v)) tags[label].push(v);
            }
            state.files[filename].enriched.tags = tags;
            saveSyncState(dir, state);

            return text({ filename, label, appliedTags: tagResult.tags });
        })
    );
}
