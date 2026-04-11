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
    scanMediaFiles,
    getSyncedFiles,
} from '../lib/local-sync.js';

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

// ── Startup scan (read-only, no uploads) ─────────────────────────────────────

function initialScan() {
    const state = loadSyncState(targetDir);
    const allFiles = scanMediaFiles(targetDir);
    const synced = getSyncedFiles(state);
    const unsyncedCount = allFiles.length - synced.length;

    log(`Folder: ${targetDir}`);
    log(`Found ${allFiles.length} media file(s): ${synced.length} already synced to CoreViz, ${unsyncedCount} not yet uploaded`);
    if (unsyncedCount > 0) {
        log(`Unsynced files will NOT be uploaded until you explicitly call upload_file or sync_folder`);
    }

    return state;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    // Scan only — no uploads without explicit user action
    initialScan();

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
