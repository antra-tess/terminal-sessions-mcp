// Terminal Sessions Web GUI Client

const socket = io();
let currentTerminal = null;
let currentSession = null;
const sessions = new Map();

// Settings helpers
function getSetting(key, defaultValue) {
  try {
    const v = localStorage.getItem('ts_' + key);
    return v === null ? defaultValue : JSON.parse(v);
  } catch { return defaultValue; }
}
function saveSetting(key, value) {
  localStorage.setItem('ts_' + key, JSON.stringify(value));
}
function toggleSettings() {
  const panel = document.getElementById('settings-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}
function shortenPath(p) {
  const home = '/Users/' + (p.split('/')[2] || '');
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('setting-show-cwd').checked = getSetting('showCwd', true);
  loadSessions();
  setupSocketListeners();

  // Refresh sessions every 5 seconds
  setInterval(loadSessions, 5000);
});

// Load sessions list
async function loadSessions() {
  try {
    const response = await fetch('/api/sessions');
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
    const showCwd = getSetting('showCwd', true);
    container.innerHTML = sessionsList.map(session => `
      <div class="session-item ${currentSession === session.id ? 'active' : ''}"
           onclick="selectSession('${session.id}', event)">
        <div class="session-name">${session.id}</div>
        ${showCwd && session.cwd ? `<div class="session-cwd" title="${session.cwd}">${shortenPath(session.cwd)}</div>` : ''}
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
  if (currentTerminal) {
    currentTerminal.dispose();
    currentTerminal = null;
  }
  
  // Create new terminal UI
  const sessionData = sessions.get(sessionId);
  const cwdLabel = sessionData?.cwd ? `  —  ${shortenPath(sessionData.cwd)}` : '';
  content.innerHTML = `
    <div class="terminal-header">
      <div class="terminal-title">Session: ${sessionId}${cwdLabel}</div>
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
    fontSize: 14,
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
  
  // Handle window resize
  window.addEventListener('resize', () => {
    fitAddon.fit();
    // Update PTY size when terminal is resized
    socket.emit('resize', {
      sessionId: currentSession,
      cols: terminal.cols,
      rows: terminal.rows
    });
  });
  
  // Store terminal reference
  currentTerminal = terminal;
  
  // Expose terminal globally for screenshot functionality
  window.currentTerminal = terminal;
  
  // Enable keyboard input - forward all key presses to the session
  terminal.onData(data => {
    if (currentSession) {
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
    const response = await fetch(`/api/sessions/${sessionId}/output?lines=1000`);
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

  socket.on('session:cwd', (data) => {
    // Update cached session data
    const s = sessions.get(data.sessionId);
    if (s) s.cwd = data.cwd;
    // Update terminal header if this is the active session
    if (currentSession === data.sessionId) {
      const titleEl = document.querySelector('.terminal-title');
      if (titleEl) titleEl.textContent = `Session: ${data.sessionId}  —  ${shortenPath(data.cwd)}`;
    }
    // Update sidebar
    loadSessions();
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
    const response = await fetch('/api/sessions', {
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
  currentTerminal?.dispose();
  currentTerminal = null;
  currentSession = null;
  
  document.getElementById('content').innerHTML = `
    <div class="empty-state">
      <svg fill="currentColor" viewBox="0 0 16 16">
        <path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm9.5 10.5H2V4h12v8.5H9.5z"/>
      </svg>
      <p>Session killed</p>
    </div>
  `;
  
  // Refresh sessions list
  setTimeout(loadSessions, 500);
}

