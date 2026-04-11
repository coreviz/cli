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
 *         "args": ["@coreviz/cli", "local-mcp"]
 *       }
 *     }
 *   }
 *
 * The server defaults to the directory where Claude Code is open (CWD).
 * Override with --dir /path/to/folder.
 * Authenticate with `coreviz login` or set COREVIZ_API_KEY.
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

export const log = (msg) => process.stderr.write(`[coreviz-local] ${msg}\n`);

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

export const targetDir = resolve(args.dir || process.cwd());
export const baseUrl = process.env.COREVIZ_API_URL || 'https://lab.coreviz.io';
export const config = new Conf({ projectName: 'coreviz-cli' });

// ── Mutable SDK context ───────────────────────────────────────────────────────
// Passed by reference to registerLocalTools so the login tool can replace the
// SDK instance after a successful device auth flow without restarting the server.

export const ctx = { sdk: null };

function buildSdk(token, apiKey) {
    return new CoreViz({
        ...(token ? { token } : { apiKey }),
        baseUrl,
    });
}

function initSdkFromStoredCreds() {
    const session = config.get('session');
    const token = session?.access_token;
    const apiKey = process.env.COREVIZ_API_KEY;
    if (token || apiKey) {
        ctx.sdk = buildSdk(token, apiKey);
        return true;
    }
    return false;
}

// Export so the login tool can call this after a successful auth
export { buildSdk };

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
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const authed = initSdkFromStoredCreds();
    if (!authed) {
        log('No credentials found. Use the login tool to authenticate, or set COREVIZ_API_KEY.');
    }

    initialScan();

    const server = new McpServer({
        name: 'coreviz-local',
        version: '1.0.0',
        description: `Local media folder assistant for: ${basename(targetDir)}`,
    });

    registerLocalTools(server, ctx, targetDir);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    log('Server ready');
}

main().catch((err) => {
    log(`Fatal error: ${err?.message || err}`);
    process.exit(1);
});
