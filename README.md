# @coreviz/cli

CoreViz CLI tool - A command-line interface for CoreViz.

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

### Authentication

Login to CoreViz using device authorization:

```bash
coreviz login
```

Logout:

```bash
coreviz logout
```

Check login status:

```bash
coreviz whoami
```

### AI Features

Describe an image:

```bash
coreviz describe path/to/image.jpg
```

Edit an image with a text prompt:

```bash
coreviz edit path/to/image.jpg --prompt "make it cyberpunk style"
```

Search local images using natural language:

```bash
coreviz search "a document with a red header"
```

This will index the images in your current directory (creating a `.index.db` file) and return the top matches for your query.

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

## License

MIT
