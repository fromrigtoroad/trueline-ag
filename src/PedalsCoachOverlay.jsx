import React, { useState, useEffect } from 'react';

const DEFAULT_SETTINGS = {
  opacity: 0.9,
  scale: 1.0,
  throttleColor: '#10b981',
  brakeColor: '#ef4444',
  locked: true
};

export default function PedalsCoachOverlay() {
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

  const baseWidth = 220;
  const baseHeight = 220;
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
  const userBrakeActive = telemetry && telemetry.brake > 0.05;
  const refBrakeActive = telemetry && telemetry.refBrakeActive;
  const distToBrake = telemetry ? telemetry.distToBrake : 9999.0;
  
  const showBrake = hasRef && distToBrake <= 150.0 && !userBrakeActive && !refBrakeActive;
  const brakePct = showBrake ? (distToBrake / 150.0) * 100 : 0;

  const userThrottleActive = telemetry && telemetry.throttle > 0.05;
  const refThrottleActive = telemetry && telemetry.refThrottleActive;
  const distToThrottle = telemetry ? telemetry.distToThrottle : 9999.0;
  
  const maxThrottleDist = 150.0;
  const showThrottle = hasRef && (distToThrottle <= maxThrottleDist || userBrakeActive || refBrakeActive) && !userThrottleActive && !refThrottleActive;
  const throttlePct = showThrottle ? Math.min(100, (distToThrottle / maxThrottleDist) * 100) : 0;

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
              height: '35px',
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
            ↕ DRAG PEDALS COACH
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
            padding: '14px',
            paddingTop: !settings.locked ? '45px' : '14px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            position: 'relative',
            backdropFilter: settings.locked ? 'none' : 'blur(10px)',
            boxSizing: 'border-box'
          }}
        >
          {!wsConnected ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '11px', fontWeight: '500', textAlign: 'center' }}>
              ⚠️ Server Offline
            </div>
          ) : !telemetry ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '11px', fontWeight: '500', textAlign: 'center' }}>
              🏁 Waiting for iRacing...
            </div>
          ) : !hasRef ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '11px', fontWeight: '500', textAlign: 'center', letterSpacing: '0.5px' }}>
              NO REF LAP LOADED
            </div>
          ) : (
            <div style={{ display: 'flex', width: '100%', height: '100%', gap: '16px' }}>
              {/* Brake Coach Bar */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', fontWeight: '700', textAlign: 'center', marginBottom: '6px', letterSpacing: '0.5px' }}>
                  BRAKE COACH
                </span>
                
                <div style={{ flex: 1, width: '100%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: '6px', overflow: 'hidden', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${brakePct}%`,
                    backgroundColor: settings.brakeColor,
                    boxShadow: `0 0 8px ${settings.brakeColor}80`,
                    transition: 'height 0.05s ease-out'
                  }} />
                  
                  {/* Status Overlay text */}
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10
                  }}>
                    {userBrakeActive || refBrakeActive ? (
                      <span className="num-mono" style={{ fontSize: '16px', fontWeight: '800', color: '#ffffff', textShadow: '0 0 8px rgba(239, 68, 68, 0.8)', letterSpacing: '1px' }}>
                        BRAKE!
                      </span>
                    ) : showBrake ? (
                      <>
                        <span className="num-mono" style={{ fontSize: '20px', fontWeight: '800', color: '#ffffff', textShadow: '1px 1px 3px black' }}>
                          {Math.round(distToBrake)}
                        </span>
                        <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.6)', textShadow: '1px 1px 2px black', marginTop: '-2px' }}>METERS</span>
                      </>
                    ) : (
                      <span style={{ fontSize: '16px', color: 'rgba(255,255,255,0.2)', fontWeight: '700' }}>---</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Throttle Coach Bar */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', fontWeight: '700', textAlign: 'center', marginBottom: '6px', letterSpacing: '0.5px' }}>
                  GAS COACH
                </span>
                
                <div style={{ flex: 1, width: '100%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: '6px', overflow: 'hidden', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${throttlePct}%`,
                    backgroundColor: settings.throttleColor,
                    boxShadow: `0 0 8px ${settings.throttleColor}80`,
                    transition: 'height 0.05s ease-out'
                  }} />
                  
                  {/* Status Overlay text */}
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10
                  }}>
                    {userThrottleActive || refThrottleActive ? (
                      <span className="num-mono" style={{ fontSize: '16px', fontWeight: '800', color: '#ffffff', textShadow: '0 0 8px rgba(16, 185, 129, 0.8)', letterSpacing: '1px' }}>
                        GAS!
                      </span>
                    ) : showThrottle ? (
                      <>
                        <span className="num-mono" style={{ fontSize: '20px', fontWeight: '800', color: '#ffffff', textShadow: '1px 1px 3px black' }}>
                          {Math.round(distToThrottle)}
                        </span>
                        <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.6)', textShadow: '1px 1px 2px black', marginTop: '-2px' }}>METERS</span>
                      </>
                    ) : (
                      <span style={{ fontSize: '16px', color: 'rgba(255,255,255,0.2)', fontWeight: '700' }}>---</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
