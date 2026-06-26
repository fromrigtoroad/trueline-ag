const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let overlayWindow = null;
let pythonProcess = null;

// Determine if we are in development mode
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function startPythonBridge() {
  const isPackaged = app.isPackaged;
  
  if (isPackaged) {
    const exeName = process.platform === 'win32' ? 'bridge.exe' : 'bridge';
    const binPath = path.join(process.resourcesPath, 'backend', 'bridge', exeName);
    
    console.log(`Spawning packaged Python bridge: ${binPath}`);
    pythonProcess = spawn(binPath, [], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    pythonProcess.on('error', (err) => {
      console.error(`Failed to start packaged Python bridge: ${err.message}`);
    });
    
    pythonProcess.stdout.on('data', (data) => {
      console.log(`[Python Stdout]: ${data.toString().trim()}`);
    });
    
    pythonProcess.stderr.on('data', (data) => {
      console.error(`[Python Stderr]: ${data.toString().trim()}`);
    });
    
    pythonProcess.on('close', (code) => {
      console.log(`Python bridge closed with code ${code}`);
    });
  } else {
    const pythonScript = path.join(__dirname, 'backend', 'bridge.py');
    
    // Prioritize virtual environment python if it exists
    const venvPython = process.platform === 'win32'
      ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
      : path.join(__dirname, 'venv', 'bin', 'python');
      
    const pythonCmds = [];
    if (fs.existsSync(venvPython)) {
      pythonCmds.push(venvPython);
    }
    pythonCmds.push(process.platform === 'win32' ? 'python' : 'python3');
    pythonCmds.push('python');
    pythonCmds.push('python3');
    
    let cmdIndex = 0;
    
    function trySpawn() {
      if (cmdIndex >= pythonCmds.length) {
        console.error("Could not find Python to start the telemetry bridge.");
        return;
      }
      
      const cmd = pythonCmds[cmdIndex];
      console.log(`Spawning Python bridge: ${cmd} ${pythonScript}`);
      
      pythonProcess = spawn(cmd, [pythonScript], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      pythonProcess.on('error', (err) => {
        console.warn(`Failed to start with ${cmd}: ${err.message}`);
        cmdIndex++;
        trySpawn();
      });
      
      pythonProcess.stdout.on('data', (data) => {
        console.log(`[Python Stdout]: ${data.toString().trim()}`);
      });
      
      pythonProcess.stderr.on('data', (data) => {
        console.error(`[Python Stderr]: ${data.toString().trim()}`);
      });
      
      pythonProcess.on('close', (code) => {
        console.log(`Python bridge closed with code ${code}`);
      });
    }
    
    trySpawn();
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 650,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false,
    backgroundColor: '#0c0f12',
    title: "TrueLine - Dashboard"
  });

  const mainUrl = isDev 
    ? 'http://localhost:5173/#main' 
    : `file://${path.join(__dirname, 'dist', 'index.html')}#main`;

  mainWindow.loadURL(mainUrl);
  
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow) overlayWindow.close();
  });
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 450,
    height: 250,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  // Lock aspect ratio to match base layout aspect ratio
  overlayWindow.setAspectRatio(450 / 250);

  const overlayUrl = isDev 
    ? 'http://localhost:5173/#overlay' 
    : `file://${path.join(__dirname, 'dist', 'index.html')}#overlay`;

  overlayWindow.loadURL(overlayUrl);

  // Default to click-through locked
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('toggle-overlay', (event, show) => {
  if (show) {
    if (!overlayWindow) {
      createOverlayWindow();
    }
    overlayWindow.showInactive();
  } else {
    if (overlayWindow) {
      overlayWindow.hide();
    }
  }
});

ipcMain.handle('set-overlay-lock', (event, lock) => {
  if (overlayWindow) {
    if (lock) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      // Unlocked: can click, drag, and resize the window
      overlayWindow.setIgnoreMouseEvents(false);
    }
  }
});

ipcMain.handle('open-file-dialog', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [
      { name: 'iRacing Telemetry Logs', extensions: ['ibt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('get-documents-path', () => {
  return app.getPath('documents');
});

// App Lifecycle
app.whenReady().then(() => {
  startPythonBridge();
  createMainWindow();
  
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Terminate Python bridge
  if (pythonProcess) {
    pythonProcess.kill();
    console.log("Killed Python bridge process.");
  }
});
