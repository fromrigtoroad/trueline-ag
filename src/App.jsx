import React, { useState, useEffect, useRef } from 'react';

const DEFAULT_SETTINGS = {
  locked: true,
  bgTheme: 'dark', // 'dark' | 'light'
  syncSettings: true,
  opacity: 0.9,
  bgOpacity: 0.35,
  scale: 1.0,
  
  // HUD
  hudVisible: false,
  hudOpacity: 0.9,
  hudBgOpacity: 0.35,
  hudScale: 1.0,
  mode: 'bars', // 'bars' | 'chart'
  
  // Pedals
  pedalsVisible: false,
  pedalsOpacity: 0.9,
  pedalsBgOpacity: 0.35,
  pedalsScale: 1.0,
  
  // Racing Line
  lineVisible: false,
  lineOpacity: 0.9,
  lineBgOpacity: 0.35,
  lineScale: 1.0,
  
  // Colors
  throttleColor: '#10b981',
  brakeColor: '#ef4444'
};

const CURRENT_VERSION = '1.2.3';

export default function App() {
  const [wsConnected, setWsConnected] = useState(false);
  const [irConnected, setIrConnected] = useState(false);
  const [isMock, setIsMock] = useState(true);
  const [telemetry, setTelemetry] = useState(null);
  
  // Reference lap state
  const [reference, setReference] = useState(null); // { lapNum, lapTimeStr }
  
  // Parsed IBT file state
  const [parsedLaps, setParsedLaps] = useState(null); // { filePath, laps: [...] }
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  
  // Settings state
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('overlay_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  const [selectedOverlayTab, setSelectedOverlayTab] = useState('hud'); // 'hud' | 'pedals' | 'line'
  const [updateAvailable, setUpdateAvailable] = useState(null); // { version, url }

  // Sync background theme with body class for Light/Dark mode
  useEffect(() => {
    if (settings.bgTheme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  }, [settings.bgTheme]);

  // WebSocket reference
  const ws = useRef(null);

  // Save settings helper
  const updateSettings = (updates) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    localStorage.setItem('overlay_settings', JSON.stringify(newSettings));
    window.dispatchEvent(new Event('storage'));
  };

  // Connect to WebSocket
  useEffect(() => {
    const connect = () => {
      console.log("Connecting to WebSocket bridge...");
      const socket = new WebSocket('ws://127.0.0.1:8765');
      ws.current = socket;

      socket.onopen = () => {
        console.log("WebSocket connected.");
        setWsConnected(true);
        setErrorMsg('');
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'telemetry') {
          setIrConnected(msg.connected);
          setIsMock(msg.is_mock);
          if (msg.connected && msg.data) {
            setTelemetry(msg.data);
          }
        } 
        else if (msg.type === 'reference_loaded') {
          setReference({
            lapNum: msg.lapNum,
            lapTimeStr: msg.lapTimeStr
          });
        } 
        else if (msg.type === 'reference_unloaded') {
          setReference(null);
        }
        else if (msg.type === 'ibt_laps') {
          setParsedLaps({
            filePath: msg.filePath,
            laps: msg.laps
          });
        }
        else if (msg.type === 'error') {
          setErrorMsg(msg.message);
          setTimeout(() => setErrorMsg(''), 5000);
        }
      };

      socket.onclose = () => {
        console.log("WebSocket disconnected. Retrying in 2s...");
        setWsConnected(false);
        setIrConnected(false);
        setTelemetry(null);
        setTimeout(connect, 2000);
      };

      socket.onerror = (err) => {
        console.error("WebSocket error:", err);
        socket.close();
      };
    };

    connect();

    return () => {
      if (ws.current) ws.current.close();
    };
  }, []);

  // Check for updates on GitHub
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const res = await fetch('https://api.github.com/repos/fromrigtoroad/trueline-ag/releases/latest');
        if (res.ok) {
          const data = await res.json();
          const latest = data.tag_name.replace(/^v/, '');
          
          const latestParts = latest.split('.').map(Number);
          const currentParts = CURRENT_VERSION.split('.').map(Number);
          
          let newer = false;
          for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
            const lVal = latestParts[i] || 0;
            const cVal = currentParts[i] || 0;
            if (lVal > cVal) {
              newer = true;
              break;
            } else if (lVal < cVal) {
              break;
            }
          }
          
          if (newer) {
            setUpdateAvailable({
              version: data.tag_name,
              url: data.html_url
            });
          }
        }
      } catch (e) {
        console.warn('Failed to check for updates', e);
      }
    };
    
    checkUpdate();
  }, []);

  // Sync Overlay visibility with Electron
  useEffect(() => {
    if (window.api) {
      window.api.toggleOverlay(settings.hudVisible);
    }
  }, [settings.hudVisible]);

  useEffect(() => {
    if (window.api) {
      window.api.togglePedalsCoach(settings.pedalsVisible);
    }
  }, [settings.pedalsVisible]);

  useEffect(() => {
    if (window.api) {
      window.api.toggleLineCoach(settings.lineVisible);
    }
  }, [settings.lineVisible]);

  // Sync Overlay Lock setting with Electron
  useEffect(() => {
    if (window.api) {
      window.api.setOverlayLock(settings.locked);
    }
  }, [settings.locked]);

  // Open file dialog and import IBT
  const handleImportIBT = async () => {
    if (!window.api) {
      setErrorMsg("File dialog is only available in Desktop mode.");
      return;
    }
    setErrorMsg('');
    try {
      const filePath = await window.api.openFileDialog([
        { name: 'iRacing Telemetry Logs', extensions: ['ibt'] }
      ]);
      
      if (filePath) {
        setSelectedFilePath(filePath);
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(jsonCmd('parse_ibt', { filePath }));
        }
      }
    } catch (err) {
      setErrorMsg(`Failed to select file: ${err.message}`);
    }
  };

  // Helper to format json commands
  const jsonCmd = (command, args = {}) => {
    return JSON.stringify({ command, ...args });
  };

  const handleSelectLap = (lapNum) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(jsonCmd('select_ibt_lap', { filePath: selectedFilePath, lapNum }));
    }
  };

  const handleUnloadReference = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(jsonCmd('unload_reference'));
    }
  };

  const sliderStyle = (accentColor) => ({
    width: '100%',
    accentColor: accentColor,
    cursor: 'pointer',
    background: 'rgba(255,255,255,0.05)',
    height: '6px',
    borderRadius: '3px',
    marginTop: '4px'
  });

  const getVal = (overlayKey, settingName, defaultVal) => {
    const isSynced = settings.syncSettings !== false;
    if (isSynced) {
      return settings[settingName] ?? defaultVal;
    }
    const prefix = overlayKey === 'hud' ? 'hud' : overlayKey === 'pedals' ? 'pedals' : 'line';
    const capitalized = settingName.charAt(0).toUpperCase() + settingName.slice(1);
    return settings[`${prefix}${capitalized}`] ?? defaultVal;
  };

  const handleSliderChange = (overlayKey, settingName, val) => {
    const isSynced = settings.syncSettings !== false;
    if (isSynced) {
      updateSettings({ [settingName]: val });
    } else {
      const prefix = overlayKey === 'hud' ? 'hud' : overlayKey === 'pedals' ? 'pedals' : 'line';
      const capitalized = settingName.charAt(0).toUpperCase() + settingName.slice(1);
      updateSettings({ [`${prefix}${capitalized}`]: val });
    }
  };

  return (
    <div className="dashboard-grid">
      {/* Sidebar Controls */}
      <div className="dashboard-sidebar">
        <div>
          <h1 className="text-neon-blue" style={{ fontSize: '24px', fontWeight: '800', marginBottom: '4px', letterSpacing: '0.5px' }}>
            TrueLine
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '10px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
            A FromRigToRoad performance product
          </p>
        </div>

        {/* Simplified Status box */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px', 
          padding: '8px 12px', 
          borderRadius: '6px', 
          background: settings.bgTheme === 'light' ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.02)', 
          border: '1px solid var(--border-color)', 
          fontSize: '12px' 
        }}>
          <span style={{ fontWeight: '600', color: 'var(--text-secondary)' }}>STATUS:</span>
          {wsConnected && irConnected ? (
            <span style={{ color: 'var(--neon-green)', fontWeight: 'bold' }}>● Ready</span>
          ) : (
            <span style={{ color: 'var(--neon-red)', fontWeight: 'bold' }}>
              ● Error: {!wsConnected ? 'Bridge Offline' : 'iRacing Offline'}
            </span>
          )}
        </div>

        {/* Tab Selection Lists with Checkboxes */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
          <h3 style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
            Overlays
          </h3>
          
          {/* Telemetry HUD */}
          <div 
            onClick={() => setSelectedOverlayTab('hud')}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '12px', 
              padding: '10px 14px', 
              borderRadius: '8px', 
              cursor: 'pointer',
              background: selectedOverlayTab === 'hud' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              border: selectedOverlayTab === 'hud' ? '1px solid var(--neon-blue)' : '1px solid transparent',
              transition: 'all 0.15s ease'
            }}
          >
            <input 
              type="checkbox" 
              checked={settings.hudVisible} 
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateSettings({ hudVisible: e.target.checked })}
              style={{ cursor: 'pointer', accentColor: 'var(--neon-blue)', width: '15px', height: '15px' }}
            />
            <span style={{ fontSize: '13px', fontWeight: '600', color: selectedOverlayTab === 'hud' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              🎛️ Telemetry HUD
            </span>
            <span style={{ 
              marginLeft: 'auto', 
              color: selectedOverlayTab === 'hud' ? 'var(--neon-blue)' : 'var(--text-muted)',
              transform: selectedOverlayTab === 'hud' ? 'translateX(0px)' : 'translateX(-4px)',
              transition: 'all 0.2s ease',
              fontSize: '14px',
              fontWeight: 'bold'
            }}>
              ➔
            </span>
          </div>

          {/* Pedals Reference */}
          <div 
            onClick={() => setSelectedOverlayTab('pedals')}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '12px', 
              padding: '10px 14px', 
              borderRadius: '8px', 
              cursor: 'pointer',
              background: selectedOverlayTab === 'pedals' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              border: selectedOverlayTab === 'pedals' ? '1px solid var(--neon-blue)' : '1px solid transparent',
              transition: 'all 0.15s ease'
            }}
          >
            <input 
              type="checkbox" 
              checked={settings.pedalsVisible} 
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateSettings({ pedalsVisible: e.target.checked })}
              style={{ cursor: 'pointer', accentColor: 'var(--neon-blue)', width: '15px', height: '15px' }}
            />
            <span style={{ fontSize: '13px', fontWeight: '600', color: selectedOverlayTab === 'pedals' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              🏎️ Pedals Reference
            </span>
            <span style={{ 
              marginLeft: 'auto', 
              color: selectedOverlayTab === 'pedals' ? 'var(--neon-blue)' : 'var(--text-muted)',
              transform: selectedOverlayTab === 'pedals' ? 'translateX(0px)' : 'translateX(-4px)',
              transition: 'all 0.2s ease',
              fontSize: '14px',
              fontWeight: 'bold'
            }}>
              ➔
            </span>
          </div>

          {/* Racing Line Reference */}
          <div 
            onClick={() => setSelectedOverlayTab('line')}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '12px', 
              padding: '10px 14px', 
              borderRadius: '8px', 
              cursor: 'pointer',
              background: selectedOverlayTab === 'line' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              border: selectedOverlayTab === 'line' ? '1px solid var(--neon-blue)' : '1px solid transparent',
              transition: 'all 0.15s ease'
            }}
          >
            <input 
              type="checkbox" 
              checked={settings.lineVisible} 
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateSettings({ lineVisible: e.target.checked })}
              style={{ cursor: 'pointer', accentColor: 'var(--neon-blue)', width: '15px', height: '15px' }}
            />
            <span style={{ fontSize: '13px', fontWeight: '600', color: selectedOverlayTab === 'line' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              🛣️ Racing Line Reference
            </span>
            <span style={{ 
              marginLeft: 'auto', 
              color: selectedOverlayTab === 'line' ? 'var(--neon-blue)' : 'var(--text-muted)',
              transform: selectedOverlayTab === 'line' ? 'translateX(0px)' : 'translateX(-4px)',
              transition: 'all 0.2s ease',
              fontSize: '14px',
              fontWeight: 'bold'
            }}>
              ➔
            </span>
          </div>
        </div>

        {/* Global Show/Hide helper */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button 
            className="glass-button" 
            onClick={() => updateSettings({ hudVisible: true, pedalsVisible: true, lineVisible: true })}
            style={{ flex: 1, padding: '8px', justifyContent: 'center', fontSize: '11px' }}
          >
            Show All
          </button>
          <button 
            className="glass-button" 
            onClick={() => updateSettings({ hudVisible: false, pedalsVisible: false, lineVisible: false })}
            style={{ flex: 1, padding: '8px', justifyContent: 'center', fontSize: '11px', color: 'var(--neon-red)' }}
          >
            Hide All
          </button>
        </div>

        {/* Global Lock/Unlock */}
        <button 
          className="glass-button" 
          onClick={() => updateSettings({ locked: !settings.locked })}
          style={{ width: '100%', justifyContent: 'center', borderColor: settings.locked ? 'var(--border-color)' : 'var(--neon-purple)', marginTop: '8px' }}
        >
          {settings.locked ? '🔒 Locked (Click-Through)' : '🔓 Unlocked (Drag / Size)'}
        </button>

        <div style={{ marginTop: 'auto', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
          v{CURRENT_VERSION} &bull; TrueLine by FromRigToRoad
        </div>
      </div>

      {/* Main Panel Content */}
      <div className="dashboard-main" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        
        {/* Top Header Row with Light/Dark Mode toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '800' }}>Control Center</h2>
          <button 
            className="glass-button" 
            onClick={() => updateSettings({ bgTheme: settings.bgTheme === 'light' ? 'dark' : 'light' })}
            style={{ padding: '6px 12px', fontSize: '12px' }}
          >
            {settings.bgTheme === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode'}
          </button>
        </div>

        {/* GitHub Updates Banner */}
        {updateAvailable && (
          <div className="glass-panel" style={{ 
            padding: '12px 16px', 
            borderLeft: '4px solid var(--neon-blue)', 
            color: 'var(--neon-blue)', 
            marginBottom: '16px', 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center' 
          }}>
            <div>
              <strong>New Update Available: {updateAvailable.version}</strong>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                A newer version of TrueLine is available.
              </div>
            </div>
            <a 
              href={updateAvailable.url} 
              target="_blank" 
              rel="noopener noreferrer" 
              className="glass-button primary" 
              style={{ padding: '6px 12px', fontSize: '12px', textDecoration: 'none', display: 'flex', alignItems: 'center' }}
            >
              Download
            </a>
          </div>
        )}

        {errorMsg && (
          <div className="glass-panel" style={{ padding: '12px 16px', borderLeft: '4px solid var(--neon-red)', color: 'var(--neon-red)', marginBottom: '16px' }}>
            ⚠️ {errorMsg}
          </div>
        )}

        {/* Reference Lap configuration */}
        <div className="glass-panel" style={{ padding: '20px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '700', marginBottom: '12px' }}>Reference Lap Config</h3>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', alignItems: 'center' }}>
            <div>
              {reference ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>ACTIVE REFERENCE LAP</span>
                  <span className="num-mono text-neon-blue" style={{ fontSize: '28px' }}>{reference.lapTimeStr}</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Lap {reference.lapNum}</span>
                  <button 
                    className="glass-button" 
                    onClick={handleUnloadReference}
                    style={{ marginTop: '8px', width: 'max-content', color: 'var(--neon-red)', padding: '4px 10px', fontSize: '12px' }}
                  >
                    Clear Reference
                  </button>
                </div>
              ) : (
                <div>
                  <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>No Reference Loaded</span>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', maxWidth: '320px' }}>
                    Import an .ibt file to select a reference lap and enable target overlays.
                  </p>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <button className="glass-button primary" onClick={handleImportIBT} style={{ justifyContent: 'center', width: '100%' }}>
                📁 Import Reference .ibt File
              </button>
            </div>
          </div>
        </div>

        {/* Lap Picker Dropdown (remains open after select) */}
        {parsedLaps && (
          <div className="glass-panel" style={{ padding: '16px 20px', border: '1px solid var(--neon-blue)', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: '700' }}>Select Active Reference Lap</h3>
              <button className="glass-button" onClick={() => setParsedLaps(null)} style={{ padding: '4px 10px', fontSize: '11px' }}>
                Unload File
              </button>
            </div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', wordBreak: 'break-all' }}>
              File: {parsedLaps.filePath.split(/[\\/]/).pop()}
            </p>
            <select
              className="glass-input"
              onChange={(e) => handleSelectLap(Number(e.target.value))}
              value={reference ? reference.lapNum : ""}
              style={{
                width: '100%',
                backgroundColor: settings.bgTheme === 'light' ? 'rgba(0,0,0,0.04)' : '#12161c',
                color: settings.bgTheme === 'light' ? '#0f172a' : 'white',
                border: '1px solid var(--border-color)',
                cursor: 'pointer',
                padding: '8px 12px'
              }}
            >
              <option value="" disabled style={{ backgroundColor: settings.bgTheme === 'light' ? '#ffffff' : '#12161c', color: settings.bgTheme === 'light' ? '#0f172a' : 'white' }}>-- Select a reference lap --</option>
              {parsedLaps.laps.map((lap) => (
                <option key={lap.lap_num} value={lap.lap_num} style={{ backgroundColor: settings.bgTheme === 'light' ? '#ffffff' : '#12161c', color: settings.bgTheme === 'light' ? '#0f172a' : 'white' }}>
                  Lap {lap.lap_num} — {lap.lap_time_str} {reference && reference.lapNum === lap.lap_num ? "⭐️ Active" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Tabbed Settings Card */}
        <div className="glass-panel" style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '8px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '700' }}>
              {selectedOverlayTab === 'hud' && '🎛️ Telemetry HUD Settings'}
              {selectedOverlayTab === 'pedals' && '🏎️ Pedals Reference Settings'}
              {selectedOverlayTab === 'line' && '🛣️ Racing Line Reference Settings'}
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Configure:</span>
              <div style={{ display: 'inline-flex', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', padding: '2px', border: '1px solid var(--border-color)' }}>
                <button
                  onClick={() => updateSettings({ syncSettings: true })}
                  style={{
                    border: 'none',
                    background: (settings.syncSettings !== false) ? 'var(--neon-blue)' : 'transparent',
                    color: 'white',
                    fontSize: '10px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: '600'
                  }}
                >
                  Together
                </button>
                <button
                  onClick={() => updateSettings({ syncSettings: false })}
                  style={{
                    border: 'none',
                    background: (settings.syncSettings === false) ? 'var(--neon-blue)' : 'transparent',
                    color: 'white',
                    fontSize: '10px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: '600'
                  }}
                >
                  Individually
                </button>
              </div>
            </div>
          </div>

          {selectedOverlayTab === 'hud' && (
            <>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px', fontWeight: '600' }}>
                  HUD DISPLAY STYLE
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button 
                    className={`glass-button ${settings.mode === 'bars' ? 'primary' : ''}`}
                    onClick={() => updateSettings({ mode: 'bars' })}
                    style={{ flex: 1, padding: '8px', justifyContent: 'center', fontSize: '12px' }}
                  >
                    HUD Bars
                  </button>
                  <button 
                    className={`glass-button ${settings.mode === 'chart' ? 'primary' : ''}`}
                    onClick={() => updateSettings({ mode: 'chart' })}
                    style={{ flex: 1, padding: '8px', justifyContent: 'center', fontSize: '12px' }}
                  >
                    VRS Chart
                  </button>
                </div>
              </div>
              
              <div style={{ marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>BACKGROUND TRANSPARENCY</span>
                  <span className="num-mono" style={{ color: 'var(--neon-blue)' }}>{Math.round((1 - getVal('hud', 'bgOpacity', 0.35)) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0" max="1" step="0.05"
                  value={getVal('hud', 'bgOpacity', 0.35)}
                  onChange={(e) => handleSliderChange('hud', 'bgOpacity', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-blue)')}
                />
              </div>

              <div style={{ marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>FOREGROUND OPACITY</span>
                  <span className="num-mono" style={{ color: 'var(--neon-purple)' }}>{Math.round(getVal('hud', 'opacity', 0.9) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0.8" max="1" step="0.02"
                  value={getVal('hud', 'opacity', 0.9)}
                  onChange={(e) => handleSliderChange('hud', 'opacity', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-purple)')}
                />
              </div>

              <div style={{ marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>OVERLAY SCALE</span>
                  <span className="num-mono" style={{ color: 'var(--neon-green)' }}>{Math.round(getVal('hud', 'scale', 1.0) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0.5" max="1.5" step="0.05"
                  value={getVal('hud', 'scale', 1.0)}
                  onChange={(e) => handleSliderChange('hud', 'scale', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-green)')}
                />
              </div>
            </>
          )}

          {selectedOverlayTab === 'pedals' && (
            <>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>BACKGROUND TRANSPARENCY</span>
                  <span className="num-mono" style={{ color: 'var(--neon-blue)' }}>{Math.round((1 - getVal('pedals', 'bgOpacity', 0.35)) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0" max="1" step="0.05"
                  value={getVal('pedals', 'bgOpacity', 0.35)}
                  onChange={(e) => handleSliderChange('pedals', 'bgOpacity', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-blue)')}
                />
              </div>

              <div style={{ marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>FOREGROUND OPACITY</span>
                  <span className="num-mono" style={{ color: 'var(--neon-purple)' }}>{Math.round(getVal('pedals', 'opacity', 0.9) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0.8" max="1" step="0.02"
                  value={getVal('pedals', 'opacity', 0.9)}
                  onChange={(e) => handleSliderChange('pedals', 'opacity', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-purple)')}
                />
              </div>

              <div style={{ marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>OVERLAY SCALE</span>
                  <span className="num-mono" style={{ color: 'var(--neon-green)' }}>{Math.round(getVal('pedals', 'scale', 1.0) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0.5" max="1.5" step="0.05"
                  value={getVal('pedals', 'scale', 1.0)}
                  onChange={(e) => handleSliderChange('pedals', 'scale', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-green)')}
                />
              </div>
            </>
          )}

          {selectedOverlayTab === 'line' && (
            <>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>BACKGROUND TRANSPARENCY</span>
                  <span className="num-mono" style={{ color: 'var(--neon-blue)' }}>{Math.round((1 - getVal('line', 'bgOpacity', 0.35)) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0" max="1" step="0.05"
                  value={getVal('line', 'bgOpacity', 0.35)}
                  onChange={(e) => handleSliderChange('line', 'bgOpacity', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-blue)')}
                />
              </div>

              <div style={{ marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>FOREGROUND OPACITY</span>
                  <span className="num-mono" style={{ color: 'var(--neon-purple)' }}>{Math.round(getVal('line', 'opacity', 0.9) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0.8" max="1" step="0.02"
                  value={getVal('line', 'opacity', 0.9)}
                  onChange={(e) => handleSliderChange('line', 'opacity', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-purple)')}
                />
              </div>

              <div style={{ marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
                  <span>OVERLAY SCALE</span>
                  <span className="num-mono" style={{ color: 'var(--neon-green)' }}>{Math.round(getVal('line', 'scale', 1.0) * 100)}%</span>
                </div>
                <input 
                  type="range" min="0.5" max="1.5" step="0.05"
                  value={getVal('line', 'scale', 1.0)}
                  onChange={(e) => handleSliderChange('line', 'scale', parseFloat(e.target.value))}
                  style={sliderStyle('var(--neon-green)')}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
