import React, { useState, useEffect, useRef } from 'react';

const DEFAULT_SETTINGS = {
  mode: 'bars', // 'bars' | 'chart'
  opacity: 0.9,
  scale: 1.0,
  throttleColor: '#10b981',
  brakeColor: '#ef4444',
  locked: true
};

export default function Overlay() {
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('overlay_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  const [telemetry, setTelemetry] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  
  // Rolling chart history (stores last 180 frames = 3 seconds at 60Hz)
  const historyRef = useRef([]);
  const canvasRef = useRef(null);

  // Sync settings via storage event
  useEffect(() => {
    const handleStorageChange = () => {
      const saved = localStorage.getItem('overlay_settings');
      if (saved) {
        setSettings(JSON.parse(saved));
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const [dimensions, setDimensions] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });

  useEffect(() => {
    const handleResize = () => {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const baseWidth = 450;
  const baseHeight = 250;
  const scaleX = dimensions.width / baseWidth;
  const scaleY = dimensions.height / baseHeight;
  const scaleFactor = Math.min(scaleX, scaleY);
  const totalScale = scaleFactor * settings.scale;
  
  const hudWrapperStyle = {
    width: `${baseWidth}px`,
    height: `${baseHeight}px`,
    transform: `scale(${totalScale})`,
    transformOrigin: 'center center',
    opacity: settings.opacity,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box'
  };

  // Connect to WebSocket
  useEffect(() => {
    const socket = new WebSocket('ws://127.0.0.1:8765');
    
    socket.onopen = () => {
      setWsConnected(true);
    };

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'telemetry') {
        if (msg.connected && msg.data) {
          setTelemetry(msg.data);
          
          // Add to rolling history
          const history = historyRef.current;
          history.push({
            throttle: msg.data.throttle,
            brake: msg.data.brake,
            refThrottle: msg.data.hasReference ? msg.data.refThrottle : null,
            refBrake: msg.data.hasReference ? msg.data.refBrake : null
          });
          
          // Limit history to 180 points
          if (history.length > 180) {
            history.shift();
          }
        } else {
          setTelemetry(null);
        }
      }
    };

    socket.onclose = () => {
      setWsConnected(false);
      setTelemetry(null);
    };

    return () => {
      socket.close();
    };
  }, []);

  // Draw Rolling Canvas Chart
  useEffect(() => {
    if (settings.mode !== 'chart' || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const history = historyRef.current;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (history.length === 0) return;
    
    const width = canvas.width;
    const height = canvas.height;
    const padding = 10 * totalScale;
    const drawHeight = height - padding * 2;
    const drawWidth = width - padding * 2;
    
    const step = drawWidth / 180;
    
    // Helper to draw a single line
    const drawLine = (getData, color, isDashed = false) => {
      ctx.beginPath();
      ctx.lineWidth = (isDashed ? 1.5 : 2.5) * totalScale;
      ctx.strokeStyle = color;
      
      if (isDashed) {
        ctx.setLineDash([4 * totalScale, 4 * totalScale]);
      } else {
        ctx.setLineDash([]);
      }
      
      let started = false;
      
      for (let i = 0; i < history.length; i++) {
        const val = getData(history[i]);
        if (val === null || val === undefined) continue;
        
        // Map value (0.0 to 1.0) to canvas coordinates
        const x = padding + i * step;
        const y = padding + drawHeight - (val * drawHeight);
        
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      
      if (started) {
        ctx.stroke();
      }
    };
    
    // 1. Draw grid / lines
    ctx.setLineDash([2 * totalScale, 5 * totalScale]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1 * totalScale;
    
    // 50% line
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    // 2. Draw Reference inputs first (background)
    if (telemetry && telemetry.hasReference) {
      drawLine(h => h.refThrottle, 'rgba(16, 185, 129, 0.85)', true);
      drawLine(h => h.refBrake, 'rgba(239, 68, 68, 0.85)', true);
    }
    
    // 3. Draw User inputs (foreground)
    drawLine(h => h.throttle, settings.throttleColor, false);
    drawLine(h => h.brake, settings.brakeColor, false);
    
  }, [telemetry, settings.mode, settings.throttleColor, settings.brakeColor, totalScale]);

  // Handle transparent background and styling
  const overlayStyle = {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    boxSizing: 'border-box',
    background: 'transparent'
  };

  // If overlay is unlocked, show drag styling
  const containerClass = `overlay-container ${!settings.locked ? 'unlocked-active' : ''}`;

  return (
    <div style={overlayStyle} className={containerClass}>
      <div style={hudWrapperStyle}>
      {/* Drag handle visible only when unlocked */}
      {!settings.locked && (
        <div 
          className="drag-handle"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '35px',
            background: 'rgba(139, 92, 246, 0.65)',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            fontWeight: '600',
            borderTopLeftRadius: '12px',
            borderTopRightRadius: '12px',
            letterSpacing: '1px',
            WebkitAppRegion: 'drag', // Electron drag handle
            cursor: 'move',
            zIndex: 100
          }}
        >
          ↕ DRAG TO MOVE OVERLAY
        </div>
      )}

      {/* Main HUD Display Area */}
      <div 
        className="hud-panel"
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '12px',
          background: settings.locked ? 'rgba(0, 0, 0, 0.35)' : 'rgba(18, 22, 28, 0.85)',
          border: settings.locked ? '1px solid rgba(255,255,255,0.05)' : '2px dashed var(--neon-purple)',
          padding: '14px',
          paddingTop: !settings.locked ? '45px' : '14px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          position: 'relative',
          backdropFilter: settings.locked ? 'none' : 'blur(10px)'
        }}
      >
        {!wsConnected ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '13px', fontWeight: '500' }}>
            ⚠️ Telemetry Server Offline
          </div>
        ) : !telemetry ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '13px', fontWeight: '500' }}>
            🏁 Waiting for iRacing...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
            {/* Top row: Delta indicator and Speed */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {/* Delta time */}
              <div>
                {telemetry.hasReference ? (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span 
                      className="num-mono" 
                      style={{ 
                        fontSize: '36px', 
                        fontWeight: '800',
                        color: telemetry.delta <= 0 ? 'var(--neon-green)' : 'var(--neon-red)',
                        textShadow: telemetry.delta <= 0 
                          ? '0 0 12px var(--neon-green-glow)' 
                          : '0 0 12px var(--neon-red-glow)'
                      }}
                    >
                      {telemetry.delta <= 0 ? '' : '+'}{telemetry.delta.toFixed(2)}s
                    </span>
                    <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.5px' }}>
                      VS REF LAP
                    </span>
                  </div>
                ) : (
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', letterSpacing: '1px' }}>
                    NO REF LAP LOADED
                  </span>
                )}
              </div>
              {/* Speed & Gear */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {/* Speed */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
                    <span className="num-mono" style={{ fontSize: '24px', fontWeight: '800', color: '#ffffff' }}>
                      {Math.round(telemetry.speed)}
                    </span>
                    {telemetry.hasReference && (
                      <span className="num-mono" style={{ fontSize: '15px', color: 'var(--neon-blue)', marginLeft: '2px' }}>
                        /{Math.round(telemetry.refSpeed)}
                      </span>
                    )}
                    <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginLeft: '4px' }}>KM/H</span>
                  </div>
                  {telemetry.hasReference && (
                    <div style={{ fontSize: '12px', fontWeight: '700', marginTop: '2px' }}>
                      {(() => {
                        const speedDelta = Math.round(telemetry.speed - telemetry.refSpeed);
                        const deltaColor = speedDelta > 0 ? 'var(--neon-green)' : speedDelta < 0 ? 'var(--neon-red)' : 'var(--text-secondary)';
                        return (
                          <span className="num-mono" style={{ color: deltaColor }}>
                            {speedDelta > 0 ? '▲ +' : speedDelta < 0 ? '▼ ' : ''}{speedDelta} km/h
                          </span>
                        );
                      })()}
                    </div>
                  )}
                </div>
                
                {/* Gear */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '10px' }}>
                  <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginBottom: '-3px' }}>GEAR</span>
                  <div style={{ display: 'flex', alignItems: 'baseline' }}>
                    <span className="num-mono" style={{ fontSize: '26px', fontWeight: '800', color: '#ffffff' }}>
                      {telemetry.gear === 0 ? 'N' : telemetry.gear === -1 ? 'R' : telemetry.gear}
                    </span>
                    {telemetry.hasReference && (
                      <span className="num-mono" style={{ fontSize: '15px', color: 'var(--neon-blue)', marginLeft: '3px' }}>
                        /{telemetry.refGear === 0 ? 'N' : telemetry.refGear === -1 ? 'R' : telemetry.refGear}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom/Middle row: Visualizer mode */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', marginTop: '10px' }}>
              {settings.mode === 'bars' ? (
                /* Compact HUD Vertical Bars Mode */
                <div style={{ display: 'flex', gap: '24px', justifyContent: 'center', alignItems: 'center', width: '100%', height: '110px', marginTop: '6px' }}>
                  {/* Throttle Column */}
                  <div style={{ width: '28px', height: '100%', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: '6px', overflow: 'hidden', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                    {/* User Fill */}
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: `${telemetry.throttle * 100}%`,
                      backgroundColor: settings.throttleColor,
                      boxShadow: `0 0 8px ${settings.throttleColor}80`
                    }} />
                    {/* Reference Indicator Needle (horizontal needle for vertical bar) */}
                    {telemetry.hasReference && (
                      <div 
                        style={{
                          position: 'absolute',
                          left: '-3px',
                          right: '-3px',
                          bottom: `calc(${telemetry.refThrottle * 100}% - 2px)`,
                          height: '4px',
                          backgroundColor: '#ffffff',
                          border: '1px solid #000000',
                          boxShadow: '0 0 6px rgba(255, 255, 255, 0.8)',
                          zIndex: 10,
                          pointerEvents: 'none'
                        }}
                      />
                    )}
                    <span className="num-mono" style={{ position: 'absolute', left: 0, right: 0, top: '6px', textAlign: 'center', fontSize: '11px', fontWeight: '700', color: 'white', textShadow: '1px 1px 2px black', zIndex: 11 }}>
                      T
                    </span>
                  </div>

                  {/* Brake Column */}
                  <div style={{ width: '28px', height: '100%', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: '6px', overflow: 'hidden', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                    {/* User Fill */}
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: `${telemetry.brake * 100}%`,
                      backgroundColor: settings.brakeColor,
                      boxShadow: `0 0 8px ${settings.brakeColor}80`
                    }} />
                    {/* Reference Indicator Needle (horizontal needle for vertical bar) */}
                    {telemetry.hasReference && (
                      <div 
                        style={{
                          position: 'absolute',
                          left: '-3px',
                          right: '-3px',
                          bottom: `calc(${telemetry.refBrake * 100}% - 2px)`,
                          height: '4px',
                          backgroundColor: '#ffffff',
                          border: '1px solid #000000',
                          boxShadow: '0 0 6px rgba(255, 255, 255, 0.8)',
                          zIndex: 10,
                          pointerEvents: 'none'
                        }}
                      />
                    )}
                    <span className="num-mono" style={{ position: 'absolute', left: 0, right: 0, top: '6px', textAlign: 'center', fontSize: '11px', fontWeight: '700', color: 'white', textShadow: '1px 1px 2px black', zIndex: 11 }}>
                      B
                    </span>
                  </div>
                </div>
              ) : (
                /* Rolling Telemetry Chart Mode */
                <div style={{ width: '100%', height: '90px', position: 'relative', background: 'rgba(0,0,0,0.15)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.03)', overflow: 'hidden' }}>
                  <canvas 
                    ref={canvasRef} 
                    width={Math.round(400 * totalScale)} 
                    height={Math.round(90 * totalScale)}
                    style={{ width: '100%', height: '100%', display: 'block' }}
                  />
                  <div style={{ position: 'absolute', top: '4px', left: '6px', display: 'flex', gap: '8px', fontSize: '9px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.5px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: settings.throttleColor }} /> Live T
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: settings.brakeColor }} /> Live B
                    </span>
                    {telemetry.hasReference && (
                      <>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <span style={{ width: '6px', height: '2px', backgroundColor: 'var(--neon-green)' }} /> Ref T
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <span style={{ width: '6px', height: '2px', backgroundColor: 'var(--neon-red)' }} /> Ref B
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    </div>
  );
}
