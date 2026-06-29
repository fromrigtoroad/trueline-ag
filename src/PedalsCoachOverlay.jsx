import React, { useState, useEffect } from 'react';

const DEFAULT_SETTINGS = {
  pedalsOpacity: 0.9,
  pedalsScale: 1.0,
  pedalsBgOpacity: 0.35,
  throttleColor: '#10b981',
  brakeColor: '#ef4444',
  locked: true,
  bgTheme: 'dark'
};

export default function PedalsCoachOverlay() {
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('overlay_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  const [telemetry, setTelemetry] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    document.body.style.backgroundColor = 'transparent';
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
  const isSynced = settings.syncSettings !== false;
  const totalScale = scaleFactor * (isSynced ? (settings.scale ?? 1.0) : (settings.pedalsScale ?? 1.0));

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

  const bgOpacity = isSynced ? (settings.bgOpacity ?? 0.35) : (settings.pedalsBgOpacity ?? 0.35);
  const bgTheme = settings.bgTheme ?? 'dark';

  const panelBg = settings.locked
    ? (bgTheme === 'light' ? `rgba(255, 255, 255, ${bgOpacity})` : `rgba(0, 0, 0, ${bgOpacity})`)
    : (bgTheme === 'light' ? 'rgba(245, 245, 245, 0.9)' : 'rgba(18, 22, 28, 0.9)');
    
  const panelBorder = settings.locked
    ? (bgTheme === 'light' ? '1px solid rgba(0, 0, 0, 0.1)' : '1px solid rgba(255, 255, 255, 0.05)')
    : (bgTheme === 'light' ? '2px dashed #8b5cf6' : '2px dashed var(--neon-purple)');

  const textColor = (bgTheme === 'light' && bgOpacity > 0.6 && settings.locked) ? '#1f2937' : '#ffffff';
  const secondaryTextColor = (bgTheme === 'light' && bgOpacity > 0.6 && settings.locked) ? '#4b5563' : 'rgba(255, 255, 255, 0.4)';
  const mutedTextColor = (bgTheme === 'light' && bgOpacity > 0.6 && settings.locked) ? '#6b7280' : 'rgba(255, 255, 255, 0.2)';

  const hudWrapperStyle = {
    width: `${baseWidth}px`,
    height: `${baseHeight}px`,
    transform: `scale(${totalScale})`,
    transformOrigin: 'center center',
    opacity: isSynced ? (settings.opacity ?? 0.9) : (settings.pedalsOpacity ?? 0.9),
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

  const distToShift = telemetry ? telemetry.distToShift : 9999.0;
  const shiftType = telemetry ? telemetry.shiftType : '';
  const showShift = hasRef && distToShift <= 50.0;
  
  let shiftPct = 0;
  if (showShift) {
    if (shiftType === 'up') {
      shiftPct = (1 - distToShift / 50.0) * 100;
    } else {
      shiftPct = (distToShift / 50.0) * 100;
    }
  }
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
            ↕ DRAG PEDALS REFERENCE
          </div>
        )}

        <div 
          className="hud-panel"
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '12px',
            background: panelBg,
            border: panelBorder,
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
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: secondaryTextColor, fontSize: '11px', fontWeight: '500', textAlign: 'center' }}>
              ⚠️ Server Offline
            </div>
          ) : !telemetry ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: secondaryTextColor, fontSize: '11px', fontWeight: '500', textAlign: 'center' }}>
              🏁 Waiting for iRacing...
            </div>
          ) : !hasRef ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: mutedTextColor, fontSize: '11px', fontWeight: '500', textAlign: 'center', letterSpacing: '0.5px' }}>
              NO REF LAP LOADED
            </div>
          ) : (
            <div style={{ display: 'flex', width: '100%', height: '100%', gap: '10px' }}>
              {/* Brake Coach Bar */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
                <span style={{ fontSize: '9px', color: secondaryTextColor, fontWeight: '700', textAlign: 'center', marginBottom: '6px', letterSpacing: '0.5px' }}>
                  BRAKE REFERENCE
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
                        <span className="num-mono" style={{ fontSize: '20px', fontWeight: '800', color: textColor, textShadow: bgTheme === 'light' && bgOpacity > 0.6 && settings.locked ? 'none' : '1px 1px 3px black' }}>
                          {Math.round(distToBrake)}
                        </span>
                        <span style={{ fontSize: '8px', color: secondaryTextColor, textShadow: bgTheme === 'light' && bgOpacity > 0.6 && settings.locked ? 'none' : '1px 1px 2px black', marginTop: '-2px' }}>METERS</span>
                      </>
                    ) : (
                      <span style={{ fontSize: '16px', color: mutedTextColor, fontWeight: '700' }}>---</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Throttle Coach Bar */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
                <span style={{ fontSize: '9px', color: secondaryTextColor, fontWeight: '700', textAlign: 'center', marginBottom: '6px', letterSpacing: '0.5px' }}>
                  GAS REFERENCE
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
                        <span className="num-mono" style={{ fontSize: '20px', fontWeight: '800', color: textColor, textShadow: bgTheme === 'light' && bgOpacity > 0.6 && settings.locked ? 'none' : '1px 1px 3px black' }}>
                          {Math.round(distToThrottle)}
                        </span>
                        <span style={{ fontSize: '8px', color: secondaryTextColor, textShadow: bgTheme === 'light' && bgOpacity > 0.6 && settings.locked ? 'none' : '1px 1px 2px black', marginTop: '-2px' }}>METERS</span>
                      </>
                    ) : (
                      <span style={{ fontSize: '16px', color: mutedTextColor, fontWeight: '700' }}>---</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Gear Coach Bar */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
                <span style={{ fontSize: '9px', color: secondaryTextColor, fontWeight: '700', textAlign: 'center', marginBottom: '6px', letterSpacing: '0.5px' }}>
                  GEAR REFERENCE
                </span>
                
                <div style={{ flex: 1, width: '100%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: '6px', overflow: 'hidden', position: 'relative', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${shiftPct}%`,
                    backgroundColor: '#8b5cf6',
                    boxShadow: '0 0 8px rgba(139, 92, 246, 0.8)',
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
                    {showShift ? (
                      distToShift <= 3.0 ? (
                        <span className="num-mono" style={{ fontSize: '15px', fontWeight: '800', color: '#ffffff', textShadow: '0 0 8px rgba(139, 92, 246, 0.8)', letterSpacing: '1px' }}>
                          SHIFT!
                        </span>
                      ) : (
                        <>
                          <span className="num-mono" style={{ fontSize: '18px', fontWeight: '800', color: textColor, textShadow: bgTheme === 'light' && bgOpacity > 0.6 && settings.locked ? 'none' : '1px 1px 3px black' }}>
                            {shiftType === 'up' ? '▲' : '▼'} {Math.round(distToShift)}
                          </span>
                          <span style={{ fontSize: '7px', color: secondaryTextColor, textShadow: bgTheme === 'light' && bgOpacity > 0.6 && settings.locked ? 'none' : '1px 1px 2px black', marginTop: '-2px' }}>METERS</span>
                        </>
                      )
                    ) : (
                      <span style={{ fontSize: '16px', color: mutedTextColor, fontWeight: '700' }}>---</span>
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
