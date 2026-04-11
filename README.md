[![The World's Most Powerful Visual Copilot](./screenshots/banner.png)](https://coreviz.io)

<div align="center">
    <h1>CoreViz</h1>
    <a href="https://coreviz.io/">Home</a>
    <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
    <a href="https://lab.coreviz.io/">Studio</a>
    <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
    <a href="https://github.com/coreviz/cli">CLI</a>
    <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
    <a href="https://github.com/coreviz/sdk">SDK</a>
    <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
    <a href="https://docs.coreviz.io/">Docs</a>
    <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
    <a href="https://x.com/withcoreviz">X</a>
    <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
    <a href="https://www.linkedin.com/company/coreviz/">LinkedIn</a>
    <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
    <a href="mailto:team@coreviz.io">Contact</a>
  <br />
  <br />

CoreViz is a Vision AI platform for teams and individuals working with thousands of visual assets.

  <p align="center">
    <a href="https://coreviz.io"><img alt="CoreViz" src="./screenshots/demo.gif"></a>
  </p>
</div>


# @coreviz/cli

<p align="center">
   <a href="https://coreviz.io"><img alt="CoreViz" src="./screenshots/cli-demo.gif"></a>
</p>

An AI-powered CLI for working with photos. Semantically search, edit, tag and generate metadata for thousands of photos right from the command line. 

## Installation

```bash
npm install -g @coreviz/cli
```

## Usage

```bash
# Run directly with npx
npx @coreviz/cli [command]

# Or if installed globally
coreviz [command]
```

## Commands
### AI Features

Describe an image:

```bash
npx @coreviz/cli describe path/to/image.jpg
```

![Screenshot of CoreViz CLI describing an image using AI.](./screenshots/describe.png)



Edit an image with a text prompt (🍌 Nano Banan + Flux Kontext in the CLI!):

```bash
npx @coreviz/cli edit path/to/image.jpg --prompt "make it cyberpunk style"
```

![Screenshot of CoreViz CLI editing an image using AI.](./screenshots/edit.png)

Generate tags or classify an image:

```bash
npx @coreviz/cli tag path/to/image.jpg "objects in the image"
```

Classify an image using specific choices:

```bash
npx @coreviz/cli tag path/to/image.jpg --choices "receipt,invoice,document" --single
```

Run tagging locally (offline capable):

```bash
npx @coreviz/cli tag path/to/image.jpg "prompt" --mode local
```

Search local images using natural language:

```bash
npx @coreviz/cli search "a person wearing a red t-shirt"
```

![Screenshot of CoreViz CLI visually searching through a folder using AI.](./screenshots/search.png)


This will index the images in your current directory (creating a `.index.db` file) and return the top matches for your query.

You can also use the cloud API for embeddings:

```bash
npx @coreviz/cli search "query" --mode api
```


### Scripting

All commands support a `--quiet` flag to suppress UI output and return only raw results.

```bash
# Returns only the file path of the edited image
npx @coreviz/cli edit image.jpg "prompt" --quiet
```

### Authentication

Login to CoreViz using device authorization:

```bash
npx @coreviz/cli login
```

Logout:

```bash
npx @coreviz/cli logout
```

Check login status:

```bash
npx @coreviz/cli whoami
```

## MCP Servers (Claude Code Integration)

`@coreviz/cli` ships two MCP servers that expose CoreViz as tools for Claude Code and other MCP-compatible AI agents.

| Server | Binary | Purpose |
|--------|--------|---------|
| **Cloud library** | `coreviz-mcp` | Manage your full CoreViz cloud library — collections, search, tagging, uploads |
| **Local folder** | `coreviz-local-mcp` | Work with a local folder of photos/videos using CoreViz AI — feels local, processes in the cloud |

---

### Cloud Library MCP

Connects Claude Code to your entire CoreViz visual library. Best for managing large collections, bulk operations, and cross-collection search.

#### Setup

1. Login:
   ```bash
   npx @coreviz/cli login
   ```

2. Add to `~/.claude/settings.json` (Claude Code) or `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop):

   ```json
   {
     "mcpServers": {
       "coreviz": {
         "command": "npx",
         "args": ["coreviz-mcp"]
       }
     }
   }
   ```

3. Run `/mcp` in Claude Code to confirm the connection.

#### Available Tools

| Tool | Description |
|------|-------------|
| `list_collections` | List all collections in your workspace |
| `create_collection` | Create a new collection |
| `browse_media` | Navigate folders and list media items |
| `search_media` | Semantic search across all your media |
| `get_media` | Get full details, tags, and detected objects for an item |
| `get_tags` | Aggregate all tags across a collection |
| `find_similar` | Find visually similar images by object ID |
| `analyze_image` | Run AI vision analysis on an image URL |
| `create_folder` | Create a new folder |
| `move_item` | Move a file or folder |
| `rename_item` | Rename a file or folder |
| `add_tag` | Add a tag to a media item |
| `remove_tag` | Remove a tag from a media item |
| `upload_media` | Upload a local photo or video file to a collection |

---

### Local Folder MCP

Open Claude Code in any folder of photos or videos and get instant AI superpowers — semantic search, auto-tagging, smart organization, and image editing — all powered by CoreViz cloud but operating on your local files.

**How it works:**
1. On startup it scans your folder and reports what it finds — nothing is uploaded yet.
2. When you ask Claude to search, analyze, or edit a file, it will tell you the file needs to go to CoreViz and ask your permission first.
3. Once uploaded, CoreViz indexes each file (CLIP embeddings, auto-descriptions, object detection). That metadata is cached locally in `.coreviz/local-sync.json` so future operations don't need to re-analyze.
4. File organization (folder creation, moves, renames) happens on disk and mirrors to the cloud simultaneously.

#### Setup

Add to your project's `.mcp.json` (or global MCP config):

```json
{
  "mcpServers": {
    "coreviz-local": {
      "command": "npx",
      "args": ["coreviz-local-mcp"],
      "env": {
        "COREVIZ_API_KEY": "your-api-key"
      }
    }
  }
}
```

The server automatically targets the directory where Claude Code is open. Override with `--dir`:

```json
{
  "args": ["coreviz-local-mcp", "--dir", "/path/to/photos"]
}
```

#### Available Tools

**Discovery**

| Tool | Description |
|------|-------------|
| `list_files` | List all files in the folder with cached AI metadata — no cloud required |
| `search_files` | Semantic search across uploaded files |
| `get_file` | Full details for a file: description, tags, objects, blob URL |
| `upload_file` | Upload a single file to CoreViz (asks user consent first) |
| `sync_folder` | Upload all new/changed files and refresh enriched metadata |

**Organization**

| Tool | Description |
|------|-------------|
| `create_folder` | Create a subfolder on disk and in CoreViz |
| `move_file` | Move a file to a subfolder (disk + cloud) |
| `rename_file` | Rename a file (disk + cloud) |

**Tagging**

| Tool | Description |
|------|-------------|
| `add_tag` | Add a label+value tag to a file |
| `remove_tag` | Remove a specific tag |
| `get_tags` | Get all tags aggregated across the folder |
| `bulk_tag` | Apply a tag to multiple files at once |

**AI**

| Tool | Description |
|------|-------------|
| `analyze_image` | Describe an image with AI; result cached locally |
| `find_similar` | Find visually similar images in the folder |
| `edit_image` | AI-edit an image and save the result to disk |
| `auto_tag_image` | AI-generate and apply tags to an image |

#### Example session

```
User:  What photos do I have?
→ list_files — returns all filenames with cached descriptions (no upload needed)

User:  Organize the basketball photos by jersey number
→ list_files shows descriptions like "player #23 driving to the hoop"
→ create_folder("23"), move_file("action.jpg", "23"), ... — zero re-analysis

User:  Find all photos of someone dunking
→ search_files("dunking") — semantic search on uploaded files

User:  Edit hero-shot.jpg to increase the contrast
→ edit_image("hero-shot.jpg", ...) — saves hero-shot-edited.jpg to disk
```

---

### Authentication

Both servers support the same auth methods:

```bash
# Option 1: interactive login (stored in ~/.config/coreviz-cli/)
npx @coreviz/cli login

# Option 2: environment variable
COREVIZ_API_KEY=your_key npx coreviz-mcp
COREVIZ_API_KEY=your_key npx coreviz-local-mcp

# Option 3: override API endpoint (for self-hosted / local dev)
COREVIZ_API_URL=http://localhost:3000 npx coreviz-mcp
```

### Local development override

```json
{
  "mcpServers": {
    "coreviz": {
      "command": "node",
      "args": ["/path/to/@coreviz/cli/bin/mcp.js"],
      "env": { "COREVIZ_API_URL": "http://localhost:3000" }
    },
    "coreviz-local": {
      "command": "node",
      "args": ["/path/to/@coreviz/cli/bin/local-mcp.js"],
      "env": { "COREVIZ_API_URL": "http://localhost:3000" }
    }
  }
}
```

---

## Development

1. Install dependencies:
   ```bash
   cd cli
   npm install
   ```

2. Run local CLI:
   ```bash
   node bin/cli.js --help
   ```

3. Run cloud MCP server:
   ```bash
   node bin/mcp.js
   ```

4. Run local-folder MCP server:
   ```bash
   node bin/local-mcp.js --dir /path/to/photos
   ```