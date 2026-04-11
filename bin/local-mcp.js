#!/usr/bin/env node
/**
 * CoreViz Local-Folder MCP Server
 *
 * Makes your local photo/video folder feel AI-powered: files are synced to
 * CoreViz cloud on startup, then you can search, analyze, organize, and edit
 * them using local filenames while all processing happens in the cloud.
 *
 * Usage — add to .mcp.json in your project:
 *   {
 *     "mcpServers": {
 *       "coreviz-local": {
 *         "command": "npx",
 *         "args": ["@coreviz/cli", "local-mcp"],
 *         "env": { "COREVIZ_API_KEY": "your-key" }
 *       }
 *     }
 *   }
 *
 * The server defaults to the directory where Claude Code is open (CWD).
 * Override with --dir /path/to/folder.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'util';
import { resolve, basename } from 'path';
import Conf from 'conf';
import { CoreViz } from '@coreviz/sdk';
import { registerLocalTools } from '../lib/local-mcp-tools.js';
import {
    loadSyncState,
    saveSyncState,
    findUnsyncedFiles,
    hashFile,
    markSynced,
    setEnriched,
    collectionNameFromDir,
} from '../lib/local-sync.js';
import { join } from 'path';

const log = (msg) => process.stderr.write(`[coreviz-local] ${msg}\n`);

// ── Parse CLI args ────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        dir: { type: 'string', short: 'd' },
        help: { type: 'boolean', short: 'h' },
    },
    strict: false,
});

if (args.help) {
    process.stdout.write(`
CoreViz Local-Folder MCP Server

Usage:
  coreviz local-mcp [--dir <path>]

Options:
  --dir, -d    Directory to watch (default: current working directory)
  --help, -h   Show this help

Environment:
  COREVIZ_API_KEY    API key (alternative to running \`coreviz login\`)
  COREVIZ_API_URL    Override API base URL (default: https://lab.coreviz.io)
`);
    process.exit(0);
}

const targetDir = resolve(args.dir || process.cwd());

// ── Auth ──────────────────────────────────────────────────────────────────────

const config = new Conf({ projectName: 'coreviz-cli' });
const session = config.get('session');
const token = session?.access_token;
const apiKey = process.env.COREVIZ_API_KEY;
const baseUrl = process.env.COREVIZ_API_URL || 'https://lab.coreviz.io';

if (!token && !apiKey) {
    log('Not authenticated. Run `coreviz login` or set COREVIZ_API_KEY.');
    process.exit(1);
}

const sdk = new CoreViz({
    ...(token ? { token } : { apiKey }),
    baseUrl,
});

// ── Startup sync ──────────────────────────────────────────────────────────────

async function fetchEnrichment(mediaId) {
    try {
        const media = await sdk.media.get(mediaId);
        return {
            description: media.metadata?.description ?? null,
            tags: media.metadata?.tags ?? null,
            objects: media.frames ? media.frames.flatMap(f => f.objects || []) : [],
            width: media.width ?? null,
            height: media.height ?? null,
            blobUrl: media.blob ?? null,
        };
    } catch {
        return null;
    }
}

async function initialSync() {
    log(`Syncing folder: ${targetDir}`);
    const state = loadSyncState(targetDir);

    // Create collection if this is the first time
    if (!state.collectionId) {
        const name = collectionNameFromDir(targetDir);
        log(`Creating CoreViz collection: "${name}"`);
        const collection = await sdk.collections.create(name, '📁');
        state.collectionId = collection.id;
        state.collectionName = collection.name;
        log(`Collection created: ${collection.id}`);
    } else {
        log(`Using existing collection: ${state.collectionId} (${state.collectionName})`);
    }

    // Find files that need uploading
    const toUpload = findUnsyncedFiles(targetDir, state);
    log(`Found ${toUpload.length} file(s) to upload`);

    let uploaded = 0;
    let failed = 0;

    for (const filename of toUpload) {
        try {
            const fullPath = join(targetDir, filename);
            const hash = hashFile(fullPath);

            // Determine parent ltree path for subfolders
            const subdir = dirname(filename);
            let uploadPath = state.collectionId;
            if (subdir && subdir !== '.') {
                const folder = await sdk.folders.create(state.collectionId, subdir, state.collectionId, true);
                uploadPath = folder.path;
            }

            const result = await sdk.media.upload(fullPath, {
                collectionId: state.collectionId,
                path: uploadPath,
                name: basename(filename),
            });

            markSynced(state, filename, result.mediaId, hash);

            // Pull enrichment (best-effort)
            const enriched = await fetchEnrichment(result.mediaId);
            if (enriched) setEnriched(state, filename, enriched);

            uploaded++;
            log(`  ✓ ${filename}`);
        } catch (err) {
            failed++;
            log(`  ✗ ${filename}: ${err?.message || err}`);
        }
    }

    // Pull enrichment for any already-synced files that are missing it
    let enriched = 0;
    for (const [filename, entry] of Object.entries(state.files)) {
        if (entry.mediaId && !entry.enriched) {
            const data = await fetchEnrichment(entry.mediaId);
            if (data) {
                setEnriched(state, filename, data);
                enriched++;
            }
        }
    }

    saveSyncState(targetDir, state);

    const totalSynced = Object.values(state.files).filter(f => f.mediaId).length;
    log(`Sync complete: ${uploaded} uploaded, ${enriched} enriched, ${failed} failed, ${totalSynced} total synced`);

    return state;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    // Run initial sync before accepting MCP connections
    await initialSync();

    const server = new McpServer({
        name: 'coreviz-local',
        version: '1.0.0',
        description: `Local media folder assistant for: ${basename(targetDir)}`,
    });

    registerLocalTools(server, sdk, targetDir);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    log('Server ready');
}

main().catch((err) => {
    log(`Fatal error: ${err?.message || err}`);
    process.exit(1);
});
