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
