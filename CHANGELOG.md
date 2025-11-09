# Changelog

## v1.2.0 - 2024-11-09

### Added

- **Direct Keyboard Input** ⌨️ - Type directly in the terminal, all keys forwarded to PTY
  - Arrow keys (←↑↓→)
  - Modifier keys (Ctrl, Alt, Shift)
  - Tab completion
  - All special characters
  - Real terminal experience in the browser
- **Signal Controls** - Practical buttons for process management
  - ^C button (SIGINT) - Interrupt processes
  - ^Z button (SIGTSTP) - Suspend processes
  - TERM button (SIGTERM) - Terminate gracefully
  - Replaces less useful screenshot button
- **Web GUI** 🎨 - Beautiful web interface for terminal session management
  - xterm.js-based terminal rendering with full TUI support
  - Dashboard showing all active sessions
  - Live Socket.IO updates
  - Interactive command input
  - Screenshot button to capture rendered terminal
  - GitHub dark theme UI
  - Accessible at http://localhost:3200
- **Proper TUI Support** - All terminal control sequences work correctly:
  - Cursor positioning (`\033[row;colH`)
  - Screen clearing (`\033[2J`)
  - All ANSI colors and formatting
  - Box drawing characters
  - Progress bars with proper positioning
- **Live Event Streaming** - RobustSessionClient now emits WebSocket events
- Binary command: `session-gui` for starting web interface

### Fixed

- Screenshots now properly render TUI control sequences (via web GUI's xterm.js)
- Event forwarding from session server → GUI server → browser clients

## v1.1.0 - 2024-11-09

### Added

- **Terminal Screenshots** 📸 - Capture visual terminal output including:
  - ANSI colors and formatting
  - TUIs (terminal user interfaces)
  - Progress bars and spinners
  - ASCII/ANSI art
  - Colorized log output
- Returns base64 or saves to file
- Configurable resolution and line count
- New MCP tool: `takeScreenshot`
- Dependencies: `ansi-to-html`, `puppeteer`

### Changed

- **Infinite reconnection** - RobustSessionClient now retries indefinitely instead of giving up after 5 attempts
- Reconnection delay caps at 5 seconds (was 30 seconds)
- Handles server restarts gracefully without manual intervention

## v1.0.0 - 2024-11-09

### Initial Release

Extracted from `connectome-ts` as a standalone, generally-useful package.

### Features

- **Persistent Terminal Sessions** - Real PTY-based shell sessions that maintain state
- **Smart Service Management** - Intelligent startup detection with ready/error patterns
- **Log Search** - Regex-based log search with context lines
- **MCP Integration** - Full Model Context Protocol support for AI assistants
- **WebSocket API** - Real-time bidirectional communication
- **Interactive Support** - Send input and signals to running processes
- **Robust Client** - Automatic reconnection with exponential backoff
- **CLI Tools** - Command-line interface for manual session management

### Components

- `PersistentSessionServer` - Core PTY session management
- `SessionAPI` - WebSocket API server
- `RobustSessionClient` - WebSocket client with auto-reconnection
- `ConnectomeTestingMCP` - MCP integration layer
- `session-cli` - Command-line tool

### Migration from connectome-ts

Files moved from `connectome-ts/src/testing/`:
- `session-server-v3.ts` → `src/server/session-server-v3.ts`
- `websocket-api.ts` → `src/server/websocket-api.ts`
- `start-session-server.ts` → `src/server/start-session-server.ts`
- `mcp-server.ts` → `src/mcp/mcp-server.ts`
- `mcp-stdio-server.ts` → `src/mcp/mcp-stdio-server.ts`
- `websocket-client.ts` → `src/client/websocket-client.ts`
- `session-cli.ts` → `cli/session-cli.ts`

All import paths updated to reflect new structure.

