# Terminal Screenshot Feature

## Overview

The screenshot feature captures visual terminal output, preserving ANSI colors, formatting, and layout. Perfect for debugging TUIs, progress bars, and visually rich terminal applications.

## Why This Feature?

Traditional log capture loses visual information:
- ❌ ANSI colors become escape codes
- ❌ Layout and positioning is lost
- ❌ Progress bars show as character spam
- ❌ Box-drawing characters don't render properly

Screenshots preserve:
- ✅ Full color and styling
- ✅ Visual layout and positioning
- ✅ Progress bars and spinners
- ✅ ASCII/ANSI art
- ✅ Rich CLI interfaces

## How It Works

```
Terminal Buffer → ANSI to HTML → Puppeteer → PNG Screenshot
```

1. **Capture** - Gets last N lines from terminal session
2. **Convert** - ANSI escape sequences → styled HTML
3. **Render** - Puppeteer renders HTML in headless Chrome
4. **Screenshot** - Captures visual output as PNG
5. **Return** - Base64 or saves to file

## Usage

### From MCP (AI Assistant)

```typescript
// Restart Cursor to load the new tool, then:
takeScreenshot({
  session: "my-tui-app",
  lines: 50,
  outputPath: "./debug-screenshot.png",
  width: 1200,
  height: 800
})
```

### From Code

```typescript
import { SessionClient } from 'terminal-sessions-mcp';

const client = new SessionClient('ws://localhost:3100');

// Take screenshot
const result = await client.takeScreenshot('session-id', {
  lines: 50,           // Last 50 lines
  outputPath: './output.png',  // Save to file
  width: 1200,         // 1200px wide
  height: 800          // 800px tall
});

if (result.success) {
  console.log('Saved to:', result.path);
}
```

### Get Base64 (no file)

```typescript
const result = await client.takeScreenshot('session-id', {
  lines: 30
  // Omit outputPath to get base64
});

if (result.success) {
  console.log('Base64:', result.base64);
  // Can display in HTML: <img src="data:image/png;base64,..." />
}
```

## Use Cases

### 1. TUI Debugging

Capture terminal user interfaces like:
- `htop`, `btop`
- `vim`, `nano`, `emacs`
- `tmux`, `screen`
- Custom TUI applications

### 2. Progress Monitoring

Document progress bars and spinners:
- npm/pip install progress
- Build progress bars
- Loading animations
- Download progress

### 3. Visual Regression Testing

Compare terminal output visually:
- CLI tool styling
- Help text formatting
- Table layouts
- Color schemes

### 4. Documentation

Create visual documentation:
- Terminal examples with actual colors
- Command output screenshots
- Error message examples
- Interactive prompts

### 5. Bug Reports

Attach visual evidence:
- Show exactly what user sees
- Include colors and formatting
- Capture layout issues
- Document rendering bugs

## Configuration

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `session` | string | required | Session ID to screenshot |
| `lines` | number | 50 | Number of recent lines to capture |
| `outputPath` | string | undefined | File path to save PNG (returns base64 if omitted) |
| `width` | number | 1200 | Screenshot width in pixels |
| `height` | number | 800 | Screenshot height in pixels |

### Styling

The terminal is rendered with:
- **Background**: Dark (#1e1e1e)
- **Foreground**: Light (#e0e0e0)
- **Font**: Courier New, Consolas, Monaco
- **Font Size**: 14px
- **Line Height**: 1.5
- **Border**: Subtle rounded corners

## Example Output

The screenshot includes:
- **Header bar** with session ID and line count
- **Terminal content** with preserved colors and formatting
- **Rounded borders** for a polished look
- **Dark theme** typical of terminal applications

## Performance

- **Fast**: ~1-2 seconds per screenshot
- **Efficient**: Reuses Puppeteer browser instance
- **Memory**: ~50-100MB per screenshot operation
- **Headless**: No GUI required

## Dependencies

- `ansi-to-html` - Converts ANSI codes to HTML
- `puppeteer` - Headless Chrome for rendering

## Limitations

- Only captures scrollback buffer (configurable lines)
- Static screenshot (not animated)
- Requires headless Chrome (via Puppeteer)
- May not capture live cursor position

## Demo

Run the included demo:

```bash
cd terminal-sessions-mcp
npx ts-node examples/screenshot-demo.ts
```

This creates a session with colorful output and takes a screenshot to `demo-terminal-screenshot.png`.

## API Response

```typescript
{
  success: boolean;
  path?: string;      // If outputPath was provided
  base64?: string;    // If outputPath was omitted
  error?: string;     // Error message if failed
}
```

## Tips

1. **Capture more lines** for scrolling TUIs: `lines: 200`
2. **Adjust resolution** for readability: `width: 1600, height: 1000`
3. **Use base64** for web display without file I/O
4. **Save to file** for documentation and bug reports
5. **Wait before screenshot** to let animations settle

## Future Enhancements

Possible additions:
- Video recording of terminal sessions
- Animated GIF capture
- Custom themes and styling
- Screenshot regions (not just last N lines)
- Automatic cursor rendering
- Multi-pane tmux/screen support

