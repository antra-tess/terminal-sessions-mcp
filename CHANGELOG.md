# Changelog

## Unreleased

### Added

- **Web GUI: phone support** 📱 - On narrow or short viewports (phones in
  portrait and landscape) the session list collapses into a drawer behind a
  ☰ button, so the terminal gets the full width instead of a ~6-column strip.
  Toolbar buttons wrap and are touch-sized, xterm.js refits on rotation,
  resize and when the on-screen keyboard opens (visual viewport tracking),
  safe-area insets are respected and the page no longer scrolls sideways.
  A small extra-keys row (Esc / Tab / sticky Ctrl / arrows) sits above the
  keyboard. Desktop layout is unchanged.
- **Web GUI: installable (PWA)** - Web app manifest, icons and the
  `apple-mobile-web-app-*` meta tags, so *Add to Home Screen* gives a
  standalone app on iOS and Android. The `?token=` from the URL is remembered
  in `localStorage` so the installed app (which opens without the query) can
  still authenticate; it is dropped again on a 401. A small app-shell service
  worker registers only in a secure context (https / localhost); plain http on
  a VPN address works without it.
- **Web GUI: desktop sidebar collapse and extra-keys toggle** - The ☰ button
  now also appears on desktop and collapses/expands the session sidebar
  (remembered per browser). A "⌨️ Keys" button in the terminal header toggles the
  Esc/Tab/Ctrl/arrows row (on by default on touch devices, off on desktop,
  remembered). The terminal refits through a `ResizeObserver` on every layout
  and the PTY is only resized when the column/row grid actually changes.
  Installing as an app also works in desktop Chrome/Edge over https/localhost.
- **Web GUI: Redraw** ⟳ - TUIs such as Claude Code draw by diff and skip cells
  they believe are already on screen, so a viewer whose terminal state has
  diverged (attached mid-stream, history replayed at another width, dropped
  frames) shows holes in the picture. A ⟳ button in the terminal header asks
  the program to repaint: the new `session.redraw` API nudges the PTY by one
  row and restores it (the program gets SIGWINCH), serialized with real
  resizes so the PTY never stays at the wrong size. The GUI also redraws
  automatically after attaching to a session and when the tab becomes
  visible again.

## v1.6.0 - 2026-07-11

### Added

- **Named keys for `sendInput`** ⌨️ - New `keys` parameter, tmux `send-keys`
  style, so agents can drive TUIs (codex, vim, htop, ...): `Enter`, `Tab`,
  `Shift-Tab`, `Esc`, `Space`, `Backspace`, `Delete`, arrows, `Home`/`End`,
  `PageUp`/`PageDown`, `F1`-`F12`, `C-a`..`C-z` (Ctrl), `M-<char>` (Alt/Meta).
  Raw control characters cannot pass through the MCP JSON tool layer, so named
  keys are the supported way to send them. Unknown key names return an error
  listing the valid vocabulary.
- Unit tests for key decoding and input assembly (`npm test`, zero-dependency
  `node --test`).

### Changed

- **`appendNewline` now appends `\r` (CR) instead of `\n` (LF)** - CR is what
  a real Enter key sends; canonical-mode shells are unaffected (`icrnl` maps
  CR to NL) and raw-mode TUIs now actually submit. If you were relying on a
  literal trailing LF byte reaching a raw-mode program, pass
  `appendNewline: false` and include `\n` in `input` yourself.
- `appendNewline` defaults to **false** when `keys` is provided (the caller
  controls the exact bytes); pass `true` explicitly to add Enter after keys.
- `sendInput` failures now include the error message instead of a bare
  `success: false`.

### Notes

- Already-running MCP bridge processes must be restarted to expose the new
  `keys` parameter - an old bridge silently drops it (and reports success).

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

