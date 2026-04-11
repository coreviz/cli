/**
 * Coreviz MCP tool definitions.
 * Each tool maps 1:1 to a @coreviz/sdk method.
 */

import { z } from 'zod';

/** Build a text result object for MCP */
function text(value) {
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

/** Wrap an async tool handler with consistent error handling */
function safe(fn) {
    return async (args) => {
        try {
            return await fn(args);
        } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }], isError: true };
        }
    };
}

/**
 * Register all Coreviz tools on the given MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('@coreviz/sdk').CoreViz} sdk
 */
export function registerTools(server, sdk) {

    // ── Read-only tools ───────────────────────────────────────────────────────

    server.tool(
        'list_collections',
        'List all collections in your Coreviz workspace. Returns collection IDs and names.',
        {
            organizationId: z.string().optional().describe('Organization ID (optional — skips an extra round-trip if provided)'),
        },
        safe(async ({ organizationId }) => {
            const collections = await sdk.collections.list(organizationId);
            return text(collections);
        })
    );

    server.tool(
        'get_collection',
        'Get full details for a single collection by its ID.',
        {
            collectionId: z.string().describe('The collection ID (from list_collections)'),
        },
        safe(async ({ collectionId }) => {
            const collection = await sdk.collections.get(collectionId);
            return text(collection);
        })
    );

    server.tool(
        'create_collection',
        'Create a new collection in your Coreviz workspace.',
        {
            name: z.string().describe('Name for the new collection'),
            icon: z.string().optional().describe('Optional icon for the collection (lucide icon name)'),
        },
        safe(async ({ name, icon }) => {
            const collection = await sdk.collections.create(name, icon);
            return text(collection);
        })
    );

    server.tool(
        'update_collection',
        'Update a collection\'s name or icon.',
        {
            collectionId: z.string().describe('The collection ID to update'),
            name: z.string().optional().describe('New name for the collection'),
            icon: z.string().optional().describe('New icon for the collection (lucide icon name)'),
        },
        safe(async ({ collectionId, name, icon }) => {
            const collection = await sdk.collections.update(collectionId, { name, icon });
            return text(collection);
        })
    );

    server.tool(
        'browse_media',
        'Browse or list media items and folders inside a collection. Use the ltree path to navigate subfolders (e.g. "collectionId.folderId"). Returns file/folder IDs, names, types, blob URLs, and metadata.',
        {
            collectionId: z.string().describe('The collection ID to browse (from list_collections)'),
            path: z.string().optional().describe('ltree path to list (e.g. "collectionId" for root, "collectionId.folderId" for a subfolder). Defaults to the collection root.'),
            limit: z.number().optional().default(50).describe('Max number of items to return (default 50)'),
            offset: z.number().optional().default(0).describe('Pagination offset'),
            type: z.enum(['image', 'video', 'folder', 'all']).optional().describe('Filter by item type'),
            dateFrom: z.string().optional().describe('Filter by creation date from (YYYY-MM-DD)'),
            dateTo: z.string().optional().describe('Filter by creation date to (YYYY-MM-DD)'),
            sortBy: z.string().optional().describe('Sort field: name, createdAt, type'),
            sortDirection: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
            q: z.string().optional().describe('Text or semantic search query — triggers scored results mode'),
            similarToObjectId: z.string().optional().describe('Object ID to find visually similar media within this collection'),
            similarToObjectModel: z.string().optional().describe('Vision model for similarity scoring (e.g. "faces", "objects", "shoeprints")'),
            tags: z.string().optional().describe('Comma-separated tag label filter'),
            mediaId: z.string().optional().describe('Filter results to a specific media item ID'),
            clusterId: z.string().optional().describe('Filter results to a specific object cluster ID'),
            recursive: z.boolean().optional().describe('When true, list all descendants recursively (flattened view)'),
        },
        safe(async ({ collectionId, ...opts }) => {
            const result = await sdk.media.browse(collectionId, opts);
            return text(result);
        })
    );

    server.tool(
        'search_media',
        'Semantically search across all media in your Coreviz workspace using natural language. Returns ranked results with image URLs, detected objects, and metadata. Use this to find specific images, scenes, or subjects.',
        {
            query: z.string().describe('Natural language search query (e.g. "red shoes", "sunset over mountains", "person wearing glasses")'),
            limit: z.number().optional().default(10).describe('Max number of results to return (default 10, max 50)'),
        },
        safe(async ({ query, limit }) => {
            const results = await sdk.media.search(query, { limit });
            return text(results);
        })
    );

    server.tool(
        'get_media',
        'Get full details for a specific media item: blob URL, dimensions, tags, detected objects, version history, and metadata.',
        {
            mediaId: z.string().describe('The media item ID (from browse_media or search_media results)'),
        },
        safe(async ({ mediaId }) => {
            const media = await sdk.media.get(mediaId);
            return text(media);
        })
    );

    server.tool(
        'get_tags',
        'Get all tag groups and their values aggregated across an entire collection. Useful for understanding how a collection is categorized.',
        {
            collectionId: z.string().describe('The collection ID (from list_collections)'),
        },
        safe(async ({ collectionId }) => {
            const tags = await sdk.tags.list(collectionId);
            return text(tags);
        })
    );

    server.tool(
        'find_similar',
        'Find media items that are visually similar to a specific detected object. Provide an object ID from a previous get_media or search_media result. Useful for face recognition, product matching, or pattern finding.',
        {
            collectionId: z.string().describe('The collection ID to search within'),
            objectId: z.string().describe('The object ID from a detected object (from get_media frames[].objects[].id or search_media objects[].id)'),
            limit: z.number().optional().default(10).describe('Max number of similar items to return'),
            model: z.string().optional().describe('Similarity model to use: "faces", "objects", or "shoeprints"'),
        },
        safe(async ({ collectionId, objectId, limit, model }) => {
            const result = await sdk.media.findSimilar(collectionId, objectId, { limit, model });
            return text(result);
        })
    );

    server.tool(
        'delete_media',
        'Permanently delete a media item from Coreviz. This action cannot be undone.',
        {
            mediaId: z.string().describe('The media item ID to delete (from browse_media or search_media results)'),
        },
        safe(async ({ mediaId }) => {
            await sdk.media.delete(mediaId);
            return text({ success: true, deleted: mediaId });
        })
    );

    server.tool(
        'list_versions',
        'List all versions of a media item (original and all AI-edited derivatives).',
        {
            mediaId: z.string().describe('The media item ID (from browse_media or search_media results)'),
        },
        safe(async ({ mediaId }) => {
            const versions = await sdk.media.listVersions(mediaId);
            return text(versions);
        })
    );

    server.tool(
        'select_version',
        'Mark a specific version as the active/current version of a media item.',
        {
            versionId: z.string().describe('The version ID to make active (from list_versions results)'),
        },
        safe(async ({ versionId }) => {
            await sdk.media.selectVersion(versionId);
            return text({ success: true, activeVersion: versionId });
        })
    );

    server.tool(
        'delete_version',
        'Delete a specific version of a media item. If the deleted version was active, the server promotes another version automatically.',
        {
            rootMediaId: z.string().describe('The root/original media item ID'),
            versionId: z.string().describe('The version ID to delete (from list_versions results)'),
        },
        safe(async ({ rootMediaId, versionId }) => {
            const result = await sdk.media.deleteVersion(rootMediaId, versionId);
            return text(result);
        })
    );

    // ── Write tools ───────────────────────────────────────────────────────────

    server.tool(
        'analyze_image',
        'Analyze an image using AI vision. Provide a blob URL (from browse_media or search_media results). Returns a detailed description of the image contents.',
        {
            imageUrl: z.string().describe('The blob URL of the image to analyze (must be a real URL from browse_media or search_media, never guessed)'),
            prompt: z.string().optional().default('Describe this image in detail.').describe('Optional question or prompt to ask about the image'),
        },
        safe(async ({ imageUrl, prompt }) => {
            const description = await sdk.describe(imageUrl, { prompt });
            return text(description);
        })
    );

    server.tool(
        'create_folder',
        'Create a new folder inside a collection. Set reuse=true for upsert behavior (returns existing folder if one with the same name already exists at that path).',
        {
            collectionId: z.string().describe('The collection ID where the folder will be created'),
            name: z.string().describe('Name of the new folder'),
            path: z.string().optional().describe('Parent ltree path for the folder (e.g. "collectionId" for root, "collectionId.parentFolderId" for a subfolder). Defaults to collection root.'),
            reuse: z.boolean().optional().describe('When true, return the existing folder if one with the same name already exists at that path (upsert behavior)'),
        },
        safe(async ({ collectionId, name, path, reuse }) => {
            const folder = await sdk.folders.create(collectionId, name, path, reuse);
            return text(folder);
        })
    );

    server.tool(
        'get_folder',
        'Get full details for a specific folder by its ID.',
        {
            folderId: z.string().describe('The folder ID (from browse_media results)'),
        },
        safe(async ({ folderId }) => {
            const folder = await sdk.folders.get(folderId);
            return text(folder);
        })
    );

    server.tool(
        'update_folder',
        'Update a folder\'s name or metadata.',
        {
            folderId: z.string().describe('The folder ID to update (from browse_media results)'),
            name: z.string().optional().describe('New name for the folder'),
            metadata: z.record(z.unknown()).optional().describe('Metadata key-value pairs to set on the folder'),
        },
        safe(async ({ folderId, name, metadata }) => {
            const folder = await sdk.folders.update(folderId, { name, metadata });
            return text(folder);
        })
    );

    server.tool(
        'delete_folder',
        'Delete a folder and all its contents. This action cannot be undone.',
        {
            folderId: z.string().describe('The folder ID to delete (from browse_media results)'),
        },
        safe(async ({ folderId }) => {
            await sdk.folders.delete(folderId);
            return text({ success: true, deleted: folderId });
        })
    );

    server.tool(
        'move_item',
        'Move a media item or folder to a different location within the same collection. Both sourceId and destinationPath must come from previous browse_media results — never construct paths manually.',
        {
            mediaId: z.string().describe('The ID of the media item or folder to move'),
            destinationPath: z.string().describe('The ltree path of the destination folder (from browse_media results, e.g. "collectionId.folderId")'),
        },
        safe(async ({ mediaId, destinationPath }) => {
            const result = await sdk.media.move(mediaId, destinationPath);
            return text(result);
        })
    );

    server.tool(
        'rename_item',
        'Rename a media item or folder.',
        {
            mediaId: z.string().describe('The ID of the media item to rename'),
            name: z.string().describe('The new name for the item'),
        },
        safe(async ({ mediaId, name }) => {
            const media = await sdk.media.rename(mediaId, name);
            return text(media);
        })
    );

    server.tool(
        'add_tag',
        'Add a tag to a media item. Tags are organized as label (group) + value pairs, e.g. label="color", value="red".',
        {
            mediaId: z.string().describe('The media item ID'),
            label: z.string().describe('Tag group name (e.g. "color", "category", "quality")'),
            value: z.string().describe('Tag value (e.g. "red", "product", "high")'),
        },
        safe(async ({ mediaId, label, value }) => {
            await sdk.media.addTag(mediaId, label, value);
            return text({ success: true, mediaId, tag: { label, value } });
        })
    );

    server.tool(
        'remove_tag',
        'Remove a specific tag from a media item.',
        {
            mediaId: z.string().describe('The media item ID'),
            label: z.string().describe('Tag group name to remove'),
            value: z.string().describe('Tag value to remove'),
        },
        safe(async ({ mediaId, label, value }) => {
            await sdk.media.removeTag(mediaId, label, value);
            return text({ success: true, mediaId, removed: { label, value } });
        })
    );

    server.tool(
        'remove_tag_group',
        'Remove an entire tag group (all values under that label) from a media item.',
        {
            mediaId: z.string().describe('The media item ID'),
            label: z.string().describe('Tag group label to remove entirely (e.g. "color")'),
        },
        safe(async ({ mediaId, label }) => {
            await sdk.media.removeTagGroup(mediaId, label);
            return text({ success: true, mediaId, removedGroup: label });
        })
    );

    server.tool(
        'rename_tag_group',
        'Rename a tag group on a media item, preserving all its values.',
        {
            mediaId: z.string().describe('The media item ID'),
            oldLabel: z.string().describe('Current tag group label (e.g. "colour")'),
            newLabel: z.string().describe('New tag group label (e.g. "color")'),
        },
        safe(async ({ mediaId, oldLabel, newLabel }) => {
            await sdk.media.renameTagGroup(mediaId, oldLabel, newLabel);
            return text({ success: true, mediaId, renamed: { from: oldLabel, to: newLabel } });
        })
    );

    server.tool(
        'upload_media',
        'Upload a local photo or video file to a Coreviz collection. Provide the absolute path to the file and the target collection ID. Optionally specify a folder path and a custom name.',
        {
            filePath: z.string().describe('Absolute path to the local file to upload (e.g. /Users/you/photo.jpg)'),
            collectionId: z.string().describe('The collection ID to upload into (from list_collections)'),
            path: z.string().optional().describe('ltree folder path to upload into (e.g. "collectionId.folderId"). Defaults to collection root.'),
            name: z.string().optional().describe('Custom name for the file in Coreviz. Defaults to the original filename.'),
        },
        safe(async ({ filePath, collectionId, path, name }) => {
            const result = await sdk.media.upload(filePath, { collectionId, path, name });
            return text(result);
        })
    );
}
