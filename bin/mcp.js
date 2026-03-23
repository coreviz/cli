#!/usr/bin/env node
/**
 * CoreViz MCP Server
 *
 * Exposes your CoreViz visual library as tools for Claude Code and other MCP clients.
 * Authentication is read from the session stored by `coreviz login`.
 *
 * Usage (after `coreviz login`):
 *   Add to .mcp.json:
 *   {
 *     "mcpServers": {
 *       "coreviz": { "command": "npx", "args": ["coreviz-mcp"] }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Conf from 'conf';
import { CoreViz } from '@coreviz/sdk';
import { registerTools } from '../lib/mcp-tools.js';

const config = new Conf({ projectName: 'coreviz-cli' });

async function main() {
    // Read stored session from `coreviz login`
    const session = config.get('session');
    const token = session?.access_token;

    // Also support explicit env var overrides for CI/scripting
    const apiKey = process.env.COREVIZ_API_KEY;
    const baseUrl = process.env.COREVIZ_API_URL || 'https://lab.coreviz.io';

    if (!token && !apiKey) {
        process.stderr.write(
            '[coreviz-mcp] Not authenticated. Run `coreviz login` first, ' +
            'or set COREVIZ_API_KEY environment variable.\n'
        );
        process.exit(1);
    }

    const sdk = new CoreViz({
        ...(token ? { token } : { apiKey }),
        baseUrl,
    });

    const server = new McpServer({
        name: 'coreviz',
        version: '1.0.0',
    });

    registerTools(server, sdk);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    process.stderr.write('[coreviz-mcp] Server ready\n');
}

main().catch((err) => {
    process.stderr.write(`[coreviz-mcp] Fatal error: ${err?.message || err}\n`);
    process.exit(1);
});
