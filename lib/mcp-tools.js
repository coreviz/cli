/**
 * CoreViz MCP tool definitions.
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
 * Register all CoreViz tools on the given MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('@coreviz/sdk').CoreViz} sdk
 */
export function registerTools(server, sdk) {

    // ── Read-only tools ───────────────────────────────────────────────────────

    server.tool(
        'list_datasets',
        'List all collections (datasets) in your CoreViz workspace. Returns dataset IDs and names.',
        {},
        safe(async () => {
            const datasets = await sdk.datasets.list();
            return text(datasets);
        })
    );

    server.tool(
        'browse_media',
        'Browse or list media items and folders inside a dataset. Use the ltree path to navigate subfolders (e.g. "datasetId.folderId"). Returns file/folder IDs, names, types, blob URLs, and metadata.',
        {
            datasetId: z.string().describe('The dataset ID to browse (from list_datasets)'),
            path: z.string().optional().describe('ltree path to list (e.g. "datasetId" for root, "datasetId.folderId" for a subfolder). Defaults to the dataset root.'),
            limit: z.number().optional().default(50).describe('Max number of items to return (default 50)'),
            offset: z.number().optional().default(0).describe('Pagination offset'),
            type: z.enum(['image', 'video', 'folder', 'all']).optional().describe('Filter by item type'),
            dateFrom: z.string().optional().describe('Filter by creation date from (YYYY-MM-DD)'),
            dateTo: z.string().optional().describe('Filter by creation date to (YYYY-MM-DD)'),
            sortBy: z.string().optional().describe('Sort field: name, createdAt, type'),
            sortDirection: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
        },
        safe(async ({ datasetId, ...opts }) => {
            const result = await sdk.media.browse(datasetId, opts);
            return text(result);
        })
    );

    server.tool(
        'search_media',
        'Semantically search across all media in your CoreViz workspace using natural language. Returns ranked results with image URLs, detected objects, and metadata. Use this to find specific images, scenes, or subjects.',
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
        'Get all tag groups and their values aggregated across an entire dataset. Useful for understanding how a collection is categorized.',
        {
            datasetId: z.string().describe('The dataset ID (from list_datasets)'),
        },
        safe(async ({ datasetId }) => {
            const tags = await sdk.tags.list(datasetId);
            return text(tags);
        })
    );

    server.tool(
        'find_similar',
        'Find media items that are visually similar to a specific detected object. Provide an object ID from a previous get_media or search_media result. Useful for face recognition, product matching, or pattern finding.',
        {
            datasetId: z.string().describe('The dataset ID to search within'),
            objectId: z.string().describe('The object ID from a detected object (from get_media frames[].objects[].id or search_media objects[].id)'),
            limit: z.number().optional().default(10).describe('Max number of similar items to return'),
            model: z.string().optional().describe('Similarity model to use: "faces", "objects", or "shoeprints"'),
        },
        safe(async ({ datasetId, objectId, limit, model }) => {
            const result = await sdk.media.findSimilar(datasetId, objectId, { limit, model });
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
        'Create a new folder inside a dataset.',
        {
            datasetId: z.string().describe('The dataset ID where the folder will be created'),
            name: z.string().describe('Name of the new folder'),
            path: z.string().optional().describe('Parent ltree path for the folder (e.g. "datasetId" for root, "datasetId.parentFolderId" for a subfolder). Defaults to dataset root.'),
        },
        safe(async ({ datasetId, name, path }) => {
            const folder = await sdk.folders.create(datasetId, name, path);
            return text(folder);
        })
    );

    server.tool(
        'move_item',
        'Move a media item or folder to a different location within the same dataset. Both sourceId and destinationPath must come from previous browse_media results — never construct paths manually.',
        {
            mediaId: z.string().describe('The ID of the media item or folder to move'),
            destinationPath: z.string().describe('The ltree path of the destination folder (from browse_media results, e.g. "datasetId.folderId")'),
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
        'upload_media',
        'Upload a local photo or video file to a CoreViz dataset. Provide the absolute path to the file and the target dataset ID. Optionally specify a folder path and a custom name.',
        {
            filePath: z.string().describe('Absolute path to the local file to upload (e.g. /Users/you/photo.jpg)'),
            datasetId: z.string().describe('The dataset ID to upload into (from list_datasets)'),
            path: z.string().optional().describe('ltree folder path to upload into (e.g. "datasetId.folderId"). Defaults to dataset root.'),
            name: z.string().optional().describe('Custom name for the file in CoreViz. Defaults to the original filename.'),
        },
        safe(async ({ filePath, datasetId, path, name }) => {
            const result = await sdk.media.upload(filePath, { datasetId, path, name });
            return text(result);
        })
    );
}
