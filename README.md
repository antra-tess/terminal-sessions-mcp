# Terminal Sessions MCP

**Persistent terminal session management with MCP integration for AI assistants**

This package provides a robust solution for managing persistent terminal sessions with intelligent startup detection, log search, and seamless integration with AI assistants through the Model Context Protocol (MCP).

## Features

✅ **Persistent Sessions** - Commands like `cd` and `export` persist across AI responses  
✅ **Smart Service Starting** - Detects when services are ready or have errors  
✅ **Log Search** - Find patterns in output with context  
✅ **Multi-Service Management** - Track multiple services by name  
✅ **MCP Integration** - Ready for AI assistant integration (Cursor, Claude Desktop, etc.)  
✅ **WebSocket API** - Real-time bidirectional communication  
✅ **Interactive Support** - Send input and signals to running processes  

## Installation

```bash
npm install terminal-sessions-mcp
```

## Quick Start

### 1. Start the Session Server

```bash
npx session-server
# Or with custom port
SESSION_SERVER_PORT=3200 npx session-server
```

### 2. Use from TypeScript/JavaScript

```typescript
import { SessionClient } from 'terminal-sessions-mcp';

const client = new SessionClient('ws://localhost:3100');

// Create a session
await client.createSession({ id: 'my-session' });

// Execute commands
const result = await client.exec('my-session', 'npm test');
console.log(result.output);

// Search logs
const matches = await client.searchLogs('my-session', 'error|warning', 5);
```

### 3. Use with MCP (AI Assistants)

Add to your MCP configuration (e.g., `~/.cursor/mcp.json`):

```json
{
  "servers": {
    "terminal-sessions": {
      "command": "npx",
      "args": ["terminal-sessions-mcp"],
      "env": {
        "SESSION_SERVER_PORT": "3100"
      }
    }
  }
}
```

Then start the session server separately:

```bash
SESSION_SERVER_PORT=3100 npx session-server
```

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────┐
│ MCP Client  │◄──────────────────►│              │
└─────────────┘                    │   Session    │
                                   │   Server     │
┌─────────────┐                    │              │
│   VSCode    │◄──────────────────►│  - Terminal  │
└─────────────┘                    │    Sessions  │
                                   │  - Output    │
┌─────────────┐                    │    Buffers   │
│ Your Code   │◄──────────────────►│              │
└─────────────┘                    └──────────────┘
```

## API Reference

### Session Management

- `session.create` - Create a new terminal session
- `session.exec` - Execute a command in a session
- `session.output` - Get buffered output (last N lines)
- `session.search` - Search output with regex and context
- `session.list` - List all active sessions
- `session.kill` - Terminate a session
- `session.killAll` - Terminate all sessions

### Service Management

- `service.start` - Start a service with intelligent ready detection
  - Waits up to 2 seconds for ready/error patterns
  - Returns status and startup logs
  - Automatically creates a named session

### Interactive Operations

- `session.input` - Send input to a running process
- `session.signal` - Send a signal (e.g., SIGINT for Ctrl+C)
- `session.env` - Get environment variables
- `session.pwd` - Get current working directory

## CLI Usage

The package includes a CLI tool for manual session management:

```bash
# List sessions
npx session-cli list

# Create a session
npx session-cli create my-session --cwd=/path/to/dir

# Execute a command
npx session-cli exec my-session "npm test"

# Tail logs
npx session-cli tail my-session --lines=100

# Search logs
npx session-cli search my-session "error" --context=5

# Send input to interactive process
npx session-cli input my-session "yes"

# Send signal
npx session-cli signal my-session --signal=SIGINT

# Subscribe to live events
npx session-cli subscribe my-session --replay=50
```

## Use Cases

### 1. AI-Assisted Development

Enable AI assistants to manage development services, run tests, and interact with terminal sessions without losing context between responses.

### 2. Multi-Service Testing

Start and monitor multiple services simultaneously, with intelligent startup detection and log search.

### 3. Interactive Debugging

AI assistants can interact with running processes, send input, and observe output in real-time.

### 4. Collaborative Development

Share terminal sessions between multiple agents or humans for coordinated work.

## Development

```bash
# Clone the repository
git clone https://github.com/anima-labs/terminal-sessions-mcp.git
cd terminal-sessions-mcp

# Install dependencies
npm install

# Build
npm run build

# Start server in development mode
npm run start-server

# Run CLI
npm run cli -- list
```

## License

MIT

## Credits

Developed by [Anima Labs](https://github.com/anima-labs) as part of the Connectome project.

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.

