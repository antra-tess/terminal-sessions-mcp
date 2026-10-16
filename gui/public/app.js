// Terminal Sessions Web GUI Client

// Extract token from URL query string
const urlParams = new URLSearchParams(window.location.search);
const authToken = urlParams.get('token');

const socket = io({ query: { token: authToken } });
let currentTerminal = null;
let currentSession = null;
// Tears down resize listeners/observers of the current terminal view
let currentTerminalCleanup = null;
const sessions = new Map();

// Must match the media query in index.html that switches to the phone layout
const MOBILE_LAYOUT_QUERY = '(max-width: 768px), (max-height: 500px)';
const mobileLayoutMedia = window.matchMedia(MOBILE_LAYOUT_QUERY);

function isMobileLayout() {
  return mobileLayoutMedia.matches;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSessions();
  setupSocketListeners();
  setupMobileLayout();
  
  // Refresh sessions every 5 seconds
  setInterval(loadSessions, 5000);
});

// ---- Mobile layout: session list as a drawer, viewport-height tracking ----

function setupMobileLayout() {
  // On a phone the list is hidden behind a drawer, so show it until a session is picked
  if (isMobileLayout() && !currentSession) {
    openSidebar({ focus: false });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
      closeSidebar();
    }
  });

  // iOS Safari: the on-screen keyboard shrinks the visual viewport, not the
  // layout viewport. Size the app to the visual viewport so the terminal stays
  // above the keyboard and refits (the container ResizeObserver picks it up).
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.visualViewport.addEventListener('scroll', syncViewportHeight);
  }
  const onLayoutChange = () => {
    syncViewportHeight();
    if (!isMobileLayout()) closeSidebar();
  };
  if (mobileLayoutMedia.addEventListener) {
    mobileLayoutMedia.addEventListener('change', onLayoutChange);
  } else {
    mobileLayoutMedia.addListener(onLayoutChange);
  }
  window.addEventListener('orientationchange', () => setTimeout(syncViewportHeight, 300));
  syncViewportHeight();
}

function syncViewportHeight() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!isMobileLayout() || !vv) {
    document.body.style.height = '';
    root.style.removeProperty('--app-height');
    return;
  }
  const height = Math.round(vv.height);
  if (height > 0) {
    document.body.style.height = height + 'px';
    // Also consumed by the fixed-position drawer, which ignores body height
    root.style.setProperty('--app-height', height + 'px');
  }
  // Keep the fixed layout pinned to the top when the keyboard pushes the page up
  if (window.scrollY || window.scrollX) {
    window.scrollTo(0, 0);
  }
}

// Everything behind the open drawer: no focus or clicks until it closes
function setBackgroundInert(inert) {
  document.querySelectorAll('header, .content').forEach(el => { el.inert = inert; });
}

function openSidebar({ focus = true } = {}) {
  if (document.body.classList.contains('sidebar-open')) return;
  document.body.classList.add('sidebar-open');
  document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'true');
  setBackgroundInert(true);
  if (focus) {
    document.querySelector('.sidebar-close')?.focus({ preventScroll: true });
  }
}

function closeSidebar() {
  if (!document.body.classList.contains('sidebar-open')) return;
  document.body.classList.remove('sidebar-open');
  document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'false');
  setBackgroundInert(false);
  // Hand focus back to the toggle unless it moved elsewhere (e.g. into the terminal)
  if (document.activeElement === document.body || document.getElementById('sidebar')?.contains(document.activeElement)) {
    document.getElementById('sidebar-toggle')?.focus({ preventScroll: true });
  }
}

function toggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

// Smaller font on narrow phones so a usable number of columns fits
function preferredFontSize() {
  return window.innerWidth <= 480 ? 13 : 14;
}

// Load sessions list
async function loadSessions() {
  try {
    const response = await fetch(`/api/sessions?token=${authToken}`);
    const sessionsList = await response.json();
    
    const container = document.getElementById('sessions-list');
    
    if (sessionsList.length === 0) {
      container.innerHTML = '<div style="padding: 1rem; opacity: 0.5; text-align: center;">No active sessions</div>';
      return;
    }
    
    // Update sessions map
    sessionsList.forEach(session => {
      sessions.set(session.id, session);
    });
    
    // Render sessions
    container.innerHTML = sessionsList.map(session => `
      <div class="session-item ${currentSession === session.id ? 'active' : ''}" 
           onclick="selectSession('${session.id}', event)">
        <div class="session-name">${session.id}</div>
        <div class="session-info">
          ${session.isAlive ? '🟢' : '🔴'} 
          ${session.logSize || 0} lines
        </div>
      </div>
    `).join('');
    
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

// Select and view a session
async function selectSession(sessionId, event) {
  if (isMobileLayout()) closeSidebar();
  if (currentSession === sessionId) return;
  
  currentSession = sessionId;
  
  // Update UI
  document.querySelectorAll('.session-item').forEach(item => {
    item.classList.remove('active');
  });
  if (event) {
    event.target.closest('.session-item')?.classList.add('active');
  } else {
    // If no event, find and highlight the session item by sessionId
    document.querySelectorAll('.session-item').forEach(item => {
      if (item.querySelector('.session-name')?.textContent === sessionId) {
        item.classList.add('active');
      }
    });
  }
  
  // Create terminal view
  await createTerminalView(sessionId);
  
  // Subscribe to session updates
  socket.emit('subscribe', sessionId);
}

// Create terminal view with xterm.js
async function createTerminalView(sessionId) {
  const content = document.getElementById('content');
  
  // Clear current terminal
  disposeCurrentTerminal();
  
  // Create new terminal UI
  content.innerHTML = `
    <div class="terminal-header">
      <div class="terminal-title">Session: ${sessionId}</div>
      <div class="terminal-actions">
        <div class="signal-buttons">
          <button class="signal danger" onclick="sendSignal('SIGINT')" title="Ctrl+C">^C</button>
          <button class="signal" onclick="sendSignal('SIGTSTP')" title="Ctrl+Z">^Z</button>
          <button class="signal" onclick="sendSignal('SIGTERM')" title="Terminate">TERM</button>
        </div>
        <button class="secondary" onclick="clearTerminal()">🗑️ Clear</button>
        <button class="secondary danger" onclick="killCurrentSession()">💀 Kill Session</button>
      </div>
    </div>
    <div id="terminal-container">
      <div id="terminal"></div>
    </div>
    <div class="key-bar" id="key-bar" aria-label="Extra keys">
      <button type="button" data-key="esc">Esc</button>
      <button type="button" data-key="tab">Tab</button>
      <button type="button" data-key="ctrl" id="key-ctrl" aria-pressed="false">Ctrl</button>
      <button type="button" data-key="left" aria-label="Left arrow">←</button>
      <button type="button" data-key="up" aria-label="Up arrow">↑</button>
      <button type="button" data-key="down" aria-label="Down arrow">↓</button>
      <button type="button" data-key="right" aria-label="Right arrow">→</button>
    </div>
  `;
  
  // Initialize xterm.js
  const terminal = new Terminal({
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc'
    },
    fontFamily: '"Cascadia Code", "Fira Code", "Monaco", "Menlo", "Ubuntu Mono", monospace',
    fontSize: preferredFontSize(),
    cursorBlink: true,
    convertEol: true,
    scrollback: 10000,
    // Enable right-click for context menus in TUI apps
    rightClickSelectsWord: false
  });
  
  // Add addons (use the correct exported constructors)
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  
  terminal.open(document.getElementById('terminal'));
  fitAddon.fit();
  
  // Send initial terminal size to PTY (important for mouse support)
  socket.emit('resize', {
    sessionId: sessionId,
    cols: terminal.cols,
    rows: terminal.rows
  });
  
  // Refit on window resize, rotation, drawer/keyboard changes (container size)
  currentTerminalCleanup = setupTerminalResize(terminal, fitAddon, sessionId);
  
  // Store terminal reference
  currentTerminal = terminal;
  
  // Extra keys row (only visible on phones)
  setupKeyBar(terminal);
  
  // Expose terminal globally for screenshot functionality
  window.currentTerminal = terminal;
  
  // Enable keyboard input - forward all key presses to the session
  terminal.onData(data => {
    if (currentSession) {
      data = applyStickyCtrl(data);
      // Debug: log to see if mouse events are being captured
      if (data.charCodeAt(0) === 27) {  // ESC character - mouse events start with ESC
        console.log('[Mouse/Special] Data:', data.split('').map(c => c.charCodeAt(0)));
      }
      socket.emit('input', {
        sessionId: currentSession,
        input: data
      });
    }
  });
  
  // Load existing output
  try {
    const response = await fetch(`/api/sessions/${sessionId}/output?lines=1000&token=${authToken}`);
    const data = await response.json();
    
    if (data.output && Array.isArray(data.output)) {
      // Join lines and write as continuous stream to properly handle control sequences
      const fullOutput = data.output.join('\r\n');
      terminal.write(fullOutput);
    }
  } catch (error) {
    console.error('Failed to load output:', error);
    terminal.write('\x1b[31mFailed to load session output\x1b[0m\r\n');
  }
  
  // Focus terminal for immediate keyboard input
  terminal.focus();
}

// Socket.IO event listeners
function setupSocketListeners() {
  socket.on('connect', () => {
    console.log('Connected to server');
    document.querySelector('.status-dot').style.background = '#3fb950';
  });
  
  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    document.querySelector('.status-dot').style.background = '#f85149';
  });
  
  socket.on('output', (data) => {
    if (currentTerminal && currentSession === data.sessionId) {
      // Write output to terminal as raw stream to preserve control sequences
      if (data.chunk) {
        currentTerminal.write(data.chunk);
      } else if (data.lines && Array.isArray(data.lines)) {
        const text = data.lines.join('\r\n') + '\r\n';
        currentTerminal.write(text);
      }
    }
  });
  
  socket.on('session:created', () => {
    loadSessions();
  });
  
  socket.on('session:exit', (data) => {
    loadSessions();
    if (currentSession === data.sessionId) {
      currentTerminal?.writeln('\x1b[33m\n[Session ended]\x1b[0m');
    }
  });
  
  socket.on('exec-result', (result) => {
    console.log('Command result:', result);
  });
  
  socket.on('screenshot-result', (result) => {
    if (result.success && result.base64) {
      // Download screenshot
      const link = document.createElement('a');
      link.href = 'data:image/png;base64,' + result.base64;
      link.download = `terminal-${currentSession}-${Date.now()}.png`;
      link.click();
    }
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
    alert('Error: ' + error.message);
  });
}

// Note: Command input has been removed in favor of direct terminal input
// Users can type directly into the terminal for a more natural experience

// Send signal to session
function sendSignal(signal) {
  if (!currentSession) return;
  
  socket.emit('signal', {
    sessionId: currentSession,
    signal: signal
  });
  
  // Visual feedback
  if (currentTerminal) {
    currentTerminal.write(`\r\n\x1b[33m[Signal: ${signal} sent]\x1b[0m\r\n`);
  }
}

// Clear terminal display
function clearTerminal() {
  if (currentTerminal) {
    currentTerminal.clear();
  }
}

// Toggle new session form
function toggleNewSessionForm() {
  const form = document.getElementById('new-session-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    document.getElementById('new-session-name').focus();
  }
}

// Create new session
async function createNewSession() {
  const nameInput = document.getElementById('new-session-name');
  const cwdInput = document.getElementById('new-session-cwd');
  
  const name = nameInput.value.trim();
  if (!name) {
    alert('Please enter a session name');
    return;
  }
  
  const cwd = cwdInput.value.trim() || undefined;
  
  try {
    const response = await fetch(`/api/sessions?token=${authToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, cwd })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create session');
    }
    
    // Clear form
    nameInput.value = '';
    cwdInput.value = '';
    toggleNewSessionForm();
    
    // Refresh sessions list
    await loadSessions();
    
    // Auto-select the new session
    setTimeout(() => selectSession(name), 500);
  } catch (error) {
    alert('Error creating session: ' + error.message);
  }
}

// Kill current session
function killCurrentSession() {
  if (!currentSession) return;
  
  if (!confirm(`Kill session "${currentSession}"? This will terminate all running processes.`)) {
    return;
  }
  
  socket.emit('kill', {
    sessionId: currentSession,
    graceful: true
  });
  
  // Clear UI
  disposeCurrentTerminal();
  currentSession = null;
  
  document.getElementById('content').innerHTML = `
    <div class="empty-state">
      <svg fill="currentColor" viewBox="0 0 16 16">
        <path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm9.5 10.5H2V4h12v8.5H9.5z"/>
      </svg>
      <p>Session killed</p>
      <button class="secondary mobile-only" onclick="openSidebar()">Show sessions</button>
    </div>
  `;
  
  // Refresh sessions list
  setTimeout(loadSessions, 500);
}

// Dispose the active xterm instance and its resize listeners
function disposeCurrentTerminal() {
  if (currentTerminalCleanup) {
    currentTerminalCleanup();
    currentTerminalCleanup = null;
  }
  if (currentTerminal) {
    currentTerminal.dispose();
    currentTerminal = null;
  }
  ctrlArmed = false;
}

// Keep xterm sized to its container and tell the PTY when the grid changes
function setupTerminalResize(terminal, fitAddon, sessionId) {
  let lastCols = terminal.cols;
  let lastRows = terminal.rows;
  let frame = null;
  let settle = null;
  
  const refit = () => {
    frame = null;
    if (terminal !== currentTerminal) return;
    const container = document.getElementById('terminal-container');
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return;
    
    const fontSize = preferredFontSize();
    if (terminal.options.fontSize !== fontSize) {
      terminal.options.fontSize = fontSize;
    }
    fitAddon.fit();
    
    if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
      lastCols = terminal.cols;
      lastRows = terminal.rows;
      socket.emit('resize', { sessionId, cols: terminal.cols, rows: terminal.rows });
    }
  };
  
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(refit);
    // iOS reports stale sizes right at rotation; fit again once things settle
    clearTimeout(settle);
    settle = setTimeout(refit, 300);
  };
  
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  
  let observer = null;
  const container = document.getElementById('terminal-container');
  if (window.ResizeObserver && container) {
    observer = new ResizeObserver(schedule);
    observer.observe(container);
  }
  
  return () => {
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    if (observer) observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    clearTimeout(settle);
  };
}

// ---- Extra keys row for on-screen keyboards ----

let ctrlArmed = false;

const KEY_SEQUENCES = {
  esc: '\x1b',
  tab: '\t'
};

// Arrow keys depend on whether the app enabled application cursor mode (vim, less, ...)
const ARROW_KEYS = { up: 'A', down: 'B', left: 'D', right: 'C' };

function keySequence(terminal, key) {
  if (ARROW_KEYS[key]) {
    const appMode = terminal.modes && terminal.modes.applicationCursorKeysMode;
    return (appMode ? '\x1bO' : '\x1b[') + ARROW_KEYS[key];
  }
  return KEY_SEQUENCES[key];
}

// Next printable character typed after tapping "Ctrl" becomes a control character
function applyStickyCtrl(data) {
  if (!ctrlArmed || data.length !== 1) return data;
  setCtrlArmed(false);
  if (data === ' ') return '\x00';   // Ctrl+Space (NUL)
  if (data === '?') return '\x7f';   // Ctrl+? (DEL)
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) {
    return String.fromCharCode(code & 0x1f);
  }
  return data;
}

function setCtrlArmed(armed) {
  ctrlArmed = armed;
  const button = document.getElementById('key-ctrl');
  if (button) {
    button.classList.toggle('armed', armed);
    button.setAttribute('aria-pressed', armed ? 'true' : 'false');
  }
}

function setupKeyBar(terminal) {
  const bar = document.getElementById('key-bar');
  if (!bar) return;
  
  // Don't steal focus from the terminal, otherwise the on-screen keyboard closes
  bar.addEventListener('pointerdown', (e) => e.preventDefault());
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  
  bar.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-key]');
    if (!button || terminal !== currentTerminal || !currentSession) return;
    
    const key = button.dataset.key;
    if (key === 'ctrl') {
      setCtrlArmed(!ctrlArmed);
    } else {
      const seq = keySequence(terminal, key);
      if (seq) {
        // Mirror what xterm does for real key presses before the bytes go out
        terminal.scrollToBottom();
        terminal.clearSelection();
        socket.emit('input', { sessionId: currentSession, input: seq });
      }
    }
    terminal.focus();
  });
}

