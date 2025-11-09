// Terminal Sessions Web GUI Client

const socket = io();
let currentTerminal = null;
let currentSession = null;
const sessions = new Map();

// Initialize
document.addEventListener('DOMContentLoaded', () => {
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
  content.innerHTML = `
    <div class="terminal-header">
      <div class="terminal-title">Session: ${sessionId}</div>
      <div class="terminal-actions">
        <button class="secondary" onclick="takeScreenshot()">📸 Screenshot</button>
        <button class="secondary" onclick="clearTerminal()">🗑️ Clear</button>
      </div>
    </div>
    <div id="terminal-container">
      <div id="terminal"></div>
    </div>
    <div class="input-container">
      <input type="text" id="command-input" placeholder="Type command and press Enter..." />
      <button onclick="sendCommand()">Send</button>
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
    scrollback: 10000
  });
  
  // Add addons (use the correct exported constructors)
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  
  terminal.open(document.getElementById('terminal'));
  fitAddon.fit();
  
  // Handle window resize
  window.addEventListener('resize', () => fitAddon.fit());
  
  // Store terminal reference
  currentTerminal = terminal;
  
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
  
  // Setup command input
  const input = document.getElementById('command-input');
  input.focus();
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendCommand();
    }
  });
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

// Send command to session
function sendCommand() {
  const input = document.getElementById('command-input');
  const command = input.value.trim();
  
  if (!command || !currentSession) return;
  
  // Send command
  socket.emit('exec', {
    sessionId: currentSession,
    command: command
  });
  
  // Clear input
  input.value = '';
  input.focus();
}

// Take screenshot from xterm.js
function takeScreenshot() {
  if (!currentTerminal) return;
  
  // Create a temporary canvas
  const terminalElement = currentTerminal.element;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  // Set canvas size to match terminal
  const rect = terminalElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  
  // Try to use html2canvas if available, otherwise use a simpler approach
  // For now, request screenshot from server which has the full buffer
  socket.emit('screenshot', {
    sessionId: currentSession,
    lines: 100
  });
}

// Clear terminal display
function clearTerminal() {
  if (currentTerminal) {
    currentTerminal.clear();
  }
}

