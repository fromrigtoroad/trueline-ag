import React, { useState, useEffect, useRef } from 'react';

const DEFAULT_SETTINGS = {
  mode: 'bars', // 'bars' | 'chart'
  opacity: 0.9,
  scale: 1.0,
  throttleColor: '#10b981',
  brakeColor: '#ef4444',
  locked: true
};

export default function App() {
  const [wsConnected, setWsConnected] = useState(false);
  const [irConnected, setIrConnected] = useState(false);
  const [isMock, setIsMock] = useState(true);
  const [telemetry, setTelemetry] = useState(null);
  
  // Reference lap state
  const [reference, setReference] = useState(null); // { lapNum, lapTimeStr }
  
  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordName, setRecordName] = useState('My Lap');
  const [recordingSavedMsg, setRecordingSavedMsg] = useState('');
  
  // Parsed IBT file state
  const [parsedLaps, setParsedLaps] = useState(null); // { filePath, laps: [...] }
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Settings state
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('overlay_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  const [overlayActive, setOverlayActive] = useState(false);
  const [pedalsActive, setPedalsActive] = useState(false);
  const [lineActive, setLineActive] = useState(false);

  // WebSocket reference
  const ws = useRef(null);

  // Save settings helper
  const updateSettings = (updates) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    localStorage.setItem('overlay_settings', JSON.stringify(newSettings));
    // Trigger a storage event manually for the local window if needed (other windows will get it automatically)
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
        else if (msg.type === 'recording_state') {
          setIsRecording(msg.recording);
        }
        else if (msg.type === 'recording_saved') {
          setRecordingSavedMsg(`Saved ${msg.fileName} successfully! Loaded as reference.`);
          setTimeout(() => setRecordingSavedMsg(''), 5000);
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

  // Sync Overlay visibility with Electron
  useEffect(() => {
    if (window.api) {
      window.api.toggleOverlay(overlayActive);
    }
  }, [overlayActive]);

  useEffect(() => {
    if (window.api) {
      window.api.togglePedalsCoach(pedalsActive);
    }
  }, [pedalsActive]);

  useEffect(() => {
    if (window.api) {
      window.api.toggleLineCoach(lineActive);
    }
  }, [lineActive]);

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
        // Send command to parse file
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
      setParsedLaps(null); // Close lap list
    }
  };

  const handleUnloadReference = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(jsonCmd('unload_reference'));
    }
  };

  const handleToggleRecording = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      if (isRecording) {
        ws.current.send(jsonCmd('stop_recording', { fileName: recordName }));
      } else {
        ws.current.send(jsonCmd('start_recording'));
      }
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

        {/* Connection Status Section */}
        <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)' }}>CONNECTION STATUS</h3>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: wsConnected ? 'var(--neon-green)' : 'var(--neon-red)',
              boxShadow: wsConnected ? '0 0 8px var(--neon-green)' : '0 0 8px var(--neon-red)'
            }} />
            <span style={{ fontSize: '14px' }}>Bridge Server: {wsConnected ? 'Connected' : 'Disconnected'}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: irConnected ? 'var(--neon-green)' : 'var(--neon-red)',
              boxShadow: irConnected ? '0 0 8px var(--neon-green)' : '0 0 8px var(--neon-red)'
            }} />
            <span style={{ fontSize: '14px' }}>iRacing SDK: {irConnected ? 'Active' : 'Offline'}</span>
          </div>

          {wsConnected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: isMock ? 'var(--neon-purple)' : 'var(--text-muted)',
                boxShadow: isMock ? '0 0 8px var(--neon-purple-glow)' : 'none'
              }} />
              <span style={{ fontSize: '14px' }}>
                Mode: {isMock ? <span className="text-neon-purple">Simulated Telemetry</span> : 'Live Simulator'}
              </span>
            </div>
          )}
        </div>

        {/* Overlay Controls */}
        <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)' }}>COACH OVERLAYS</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button 
              className={`glass-button ${overlayActive ? 'primary glow-blue' : ''}`}
              onClick={() => setOverlayActive(!overlayActive)}
              style={{ width: '100%', justifyContent: 'space-between', padding: '10px 14px' }}
            >
              <span>📊 Telemetry HUD</span>
              <span>{overlayActive ? 'ON' : 'OFF'}</span>
            </button>

            <button 
              className={`glass-button ${pedalsActive ? 'primary glow-blue' : ''}`}
              onClick={() => setPedalsActive(!pedalsActive)}
              style={{ width: '100%', justifyContent: 'space-between', padding: '10px 14px' }}
            >
              <span>🏁 Pedals Coach</span>
              <span>{pedalsActive ? 'ON' : 'OFF'}</span>
            </button>

            <button 
              className={`glass-button ${lineActive ? 'primary glow-blue' : ''}`}
              onClick={() => setLineActive(!lineActive)}
              style={{ width: '100%', justifyContent: 'space-between', padding: '10px 14px' }}
            >
              <span>🛣️ Racing Line Coach</span>
              <span>{lineActive ? 'ON' : 'OFF'}</span>
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button 
              className="glass-button" 
              onClick={() => {
                setOverlayActive(true);
                setPedalsActive(true);
                setLineActive(true);
              }}
              style={{ flex: 1, padding: '8px', justifyContent: 'center', fontSize: '12px' }}
            >
              Show All
            </button>
            <button 
              className="glass-button" 
              onClick={() => {
                setOverlayActive(false);
                setPedalsActive(false);
                setLineActive(false);
              }}
              style={{ flex: 1, padding: '8px', justifyContent: 'center', fontSize: '12px', color: 'var(--neon-red)' }}
            >
              Hide All
            </button>
          </div>

          <button 
            className="glass-button" 
            onClick={() => updateSettings({ locked: !settings.locked })}
            style={{ width: '100%', justifyContent: 'center', borderColor: settings.locked ? 'var(--border-color)' : 'var(--neon-purple)', marginTop: '4px' }}
          >
            {settings.locked ? '🔒 Locked (Click-Through)' : '🔓 Unlocked (Drag / Size)'}
          </button>

          <div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
              HUD DISPLAY STYLE
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button 
                className={`glass-button ${settings.mode === 'bars' ? 'primary' : ''}`}
                onClick={() => updateSettings({ mode: 'bars' })}
                style={{ flex: 1, padding: '8px', justifyContent: 'center' }}
              >
                HUD Bars
              </button>
              <button 
                className={`glass-button ${settings.mode === 'chart' ? 'primary' : ''}`}
                onClick={() => updateSettings({ mode: 'chart' })}
                style={{ flex: 1, padding: '8px', justifyContent: 'center' }}
              >
                VRS Chart
              </button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 'auto', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
          v1.0.0 &bull; TrueLine by FromRigToRoad
        </div>
      </div>

      {/* Main Panel Content */}
      <div className="dashboard-main">
        {errorMsg && (
          <div className="glass-panel" style={{ padding: '12px 16px', borderLeft: '4px solid var(--neon-red)', color: 'var(--neon-red)' }}>
            ⚠️ {errorMsg}
          </div>
        )}

        {recordingSavedMsg && (
          <div className="glass-panel" style={{ padding: '12px 16px', borderLeft: '4px solid var(--neon-green)', color: 'var(--neon-green)' }}>
            ✅ {recordingSavedMsg}
          </div>
        )}

        {/* Reference Lap Config */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: '700', marginBottom: '16px' }}>Reference Lap</h2>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', alignItems: 'center' }}>
            <div>
              {reference ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>ACTIVE COMPARISON</span>
                  <span className="num-mono text-neon-blue" style={{ fontSize: '32px' }}>{reference.lapTimeStr}</span>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Lap {reference.lapNum}</span>
                  <button 
                    className="glass-button" 
                    onClick={handleUnloadReference}
                    style={{ marginTop: '10px', width: 'max-content', color: 'var(--neon-red)' }}
                  >
                    Unload Reference
                  </button>
                </div>
              ) : (
                <div>
                  <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>No Reference Telemetry Loaded</span>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px', maxWidth: '300px' }}>
                    Import an .ibt file from your coach, or record a lap to show the reference throttle & brake outline.
                  </p>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <button className="glass-button primary" onClick={handleImportIBT} style={{ justifyContent: 'center' }}>
                📁 Import Coach .ibt File
              </button>

              <div className="glass-panel" style={{ padding: '14px', border: '1px dashed var(--border-color)' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
                  OR RECORD YOUR OWN LAP
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input 
                    type="text" 
                    className="glass-input" 
                    value={recordName}
                    onChange={(e) => setRecordName(e.target.value)}
                    placeholder="Lap Name"
                    style={{ flex: 1, padding: '6px 10px' }}
                    disabled={isRecording}
                  />
                  <button 
                    className={`glass-button ${isRecording ? 'danger pulse' : ''}`}
                    onClick={handleToggleRecording}
                    style={{ padding: '6px 12px' }}
                  >
                    {isRecording ? 'Stop Recording' : 'Start Recording'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Lap Picker Dropdown */}
        {parsedLaps && (
          <div className="glass-panel" style={{ padding: '20px', border: '1px solid var(--neon-blue)', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: '700' }}>Select Reference Lap</h3>
              <button className="glass-button" onClick={() => setParsedLaps(null)} style={{ padding: '4px 10px', fontSize: '12px' }}>
                Close
              </button>
            </div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              File: {parsedLaps.filePath.split(/[\\/]/).pop()}
            </p>
            <select
              className="glass-input"
              onChange={(e) => handleSelectLap(Number(e.target.value))}
              defaultValue=""
              style={{
                width: '100%',
                backgroundColor: '#12161c',
                color: 'white',
                border: '1px solid var(--border-color)',
                cursor: 'pointer'
              }}
            >
              <option value="" disabled>-- Select a lap time --</option>
              {parsedLaps.laps.map((lap) => (
                <option key={lap.lap_num} value={lap.lap_num} style={{ backgroundColor: '#12161c' }}>
                  Lap {lap.lap_num} — {lap.lap_time_str}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* Live Telemetry Preview Panel */}
        <div className="glass-panel" style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ fontSize: '18px', fontWeight: '700', marginBottom: '16px' }}>Live Telemetry Monitor</h2>

          {telemetry ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1 }}>
              {/* Quick Info Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
                <div className="glass-panel" style={{ padding: '12px', textAlign: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>SPEED</span>
                  <div className="num-mono" style={{ fontSize: '24px', marginTop: '4px' }}>
                    {Math.round(telemetry.speed)} <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>km/h</span>
                  </div>
                </div>
                <div className="glass-panel" style={{ padding: '12px', textAlign: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>GEAR</span>
                  <div className="num-mono text-neon-blue" style={{ fontSize: '24px', marginTop: '4px' }}>
                    {telemetry.gear === 0 ? 'N' : telemetry.gear === -1 ? 'R' : telemetry.gear}
                  </div>
                </div>
                <div className="glass-panel" style={{ padding: '12px', textAlign: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>LAP</span>
                  <div className="num-mono" style={{ fontSize: '24px', marginTop: '4px' }}>
                    {telemetry.lap}
                  </div>
                </div>
                <div className="glass-panel" style={{ padding: '12px', textAlign: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>LAP TIME</span>
                  <div className="num-mono text-neon-purple" style={{ fontSize: '24px', marginTop: '4px' }}>
                    {(() => {
                      const t = telemetry.userLapTime;
                      const mins = intVal(t / 60);
                      const secs = intVal(t % 60);
                      const ms = intVal((t % 1) * 1000);
                      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
                    })()}
                  </div>
                </div>
              </div>

              {/* Progress Inputs Preview */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                    <span>Throttle</span>
                    <span className="num-mono" style={{ color: 'var(--neon-green)' }}>{Math.round(telemetry.throttle * 100)}%</span>
                  </div>
                  <div style={{ height: '14px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '7px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                    <div style={{
                      height: '100%',
                      width: `${telemetry.throttle * 100}%`,
                      backgroundColor: 'var(--neon-green)',
                      boxShadow: '0 0 10px var(--neon-green-glow)',
                      transition: 'width 0.05s ease-out'
                    }} />
                  </div>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                    <span>Brake</span>
                    <span className="num-mono" style={{ color: 'var(--neon-red)' }}>{Math.round(telemetry.brake * 100)}%</span>
                  </div>
                  <div style={{ height: '14px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '7px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                    <div style={{
                      height: '100%',
                      width: `${telemetry.brake * 100}%`,
                      backgroundColor: 'var(--neon-red)',
                      boxShadow: '0 0 10px var(--neon-red-glow)',
                      transition: 'width 0.05s ease-out'
                    }} />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '14px', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
              Waiting for iRacing telemetry data...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Simple integer casting helper
function intVal(val) {
  return Math.floor(val);
}
