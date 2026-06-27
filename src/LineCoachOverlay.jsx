import React, { useState, useEffect } from 'react';

const DEFAULT_SETTINGS = {
  opacity: 0.9,
  scale: 1.0,
  locked: true
};

export default function LineCoachOverlay() {
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('overlay_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  const [telemetry, setTelemetry] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

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

  const baseWidth = 300;
  const baseHeight = 90;
  const scaleX = dimensions.width / baseWidth;
  const scaleY = dimensions.height / baseHeight;
  const scaleFactor = Math.min(scaleX, scaleY);
  const totalScale = scaleFactor * settings.scale;

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

  // Compute values
  const hasRef = telemetry && telemetry.hasReference;
  const dev = telemetry ? telemetry.lateralDeviation : 0.0;
  
  // Scale deviation to percentage (cap at 3.0 meters max deviation)
  const maxDev = 3.0;
  const devPct = Math.min(100, Math.max(-100, (dev / maxDev) * 100));
  
  // Bar layout math
  const barLeft = devPct >= 0 ? '50%' : `calc(50% + ${devPct}%)`;
  const barWidth = `${Math.abs(devPct)}%`;
  
  // Label text
  const label = dev > 0.05 
    ? `REF LINE: ${dev.toFixed(1)}m RIGHT` 
    : dev < -0.05 
      ? `REF LINE: ${Math.abs(dev).toFixed(1)}m LEFT` 
      : 'REF LINE: ON PATH';

  const containerClass = `overlay-container ${!settings.locked ? 'unlocked-active' : ''}`;

  return (
    <div style={overlayStyle} className={containerClass}>
      <div style={hudWrapperStyle}>
        {!settings.locked && (
          <div 
            className="drag-handle"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '30px',
              background: 'rgba(139, 92, 246, 0.65)',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              fontWeight: '600',
              borderTopLeftRadius: '12px',
              borderTopRightRadius: '12px',
              letterSpacing: '1px',
              WebkitAppRegion: 'drag',
              cursor: 'move',
              zIndex: 100
            }}
          >
            ↕ DRAG RACING LINE COACH
          </div>
        )}

        <div 
          className="hud-panel"
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '12px',
            background: settings.locked ? 'rgba(0, 0, 0, 0.35)' : 'rgba(18, 22, 28, 0.85)',
            border: settings.locked ? '1px solid rgba(255,255,255,0.05)' : '2px dashed var(--neon-purple)',
            padding: '10px 14px',
            paddingTop: !settings.locked ? '38px' : '10px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            position: 'relative',
            backdropFilter: settings.locked ? 'none' : 'blur(10px)',
            boxSizing: 'border-box'
          }}
        >
          {!wsConnected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '11px', fontWeight: '500', height: '100%' }}>
              ⚠️ Server Offline
            </div>
          ) : !telemetry ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '11px', fontWeight: '500', height: '100%' }}>
              🏁 Waiting for iRacing...
            </div>
          ) : !hasRef ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '11px', fontWeight: '500', height: '100%', letterSpacing: '0.5px' }}>
              NO REF LAP LOADED
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between', padding: '2px 0' }}>
              {/* Header Label */}
              <div 
                className="num-mono" 
                style={{ 
                  fontSize: '11px', 
                  fontWeight: '800', 
                  color: '#ffffff', 
                  textAlign: 'center',
                  textShadow: '0 0 6px rgba(0, 210, 255, 0.3)',
                  letterSpacing: '0.5px'
                }}
              >
                {label}
              </div>

              {/* Slider Track */}
              <div 
                style={{ 
                  height: '20px', 
                  backgroundColor: 'rgba(255,255,255,0.04)', 
                  borderRadius: '4px', 
                  position: 'relative', 
                  border: '1px solid rgba(255,255,255,0.05)',
                  overflow: 'hidden',
                  marginTop: '4px'
                }}
              >
                {/* Zero Center-Line Anchor */}
                <div 
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: 0,
                    bottom: 0,
                    width: '2px',
                    backgroundColor: 'rgba(255,255,255,0.25)',
                    zIndex: 5
                  }}
                />

                {/* Fill Indicator (Blue Neon) */}
                <div 
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: barLeft,
                    width: barWidth,
                    backgroundColor: 'var(--neon-blue)',
                    boxShadow: '0 0 8px var(--neon-blue-glow)',
                    borderRadius: '2px',
                    transition: 'left 0.05s ease-out, width 0.05s ease-out'
                  }}
                />
              </div>

              {/* Scale Labels */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: 'rgba(255,255,255,0.3)', fontWeight: '600', marginTop: '2px' }}>
                <span>3m L</span>
                <span>CENTER</span>
                <span>3m R</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
