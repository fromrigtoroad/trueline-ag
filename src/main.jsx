import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import Overlay from './Overlay.jsx';
import PedalsCoachOverlay from './PedalsCoachOverlay.jsx';
import LineCoachOverlay from './LineCoachOverlay.jsx';
import './index.css';

function Root() {
  const [currentRoute, setCurrentRoute] = useState(window.location.hash);

  useEffect(() => {
    const handleHashChange = () => {
      setCurrentRoute(window.location.hash);
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  // Dispatch based on URL hash
  if (currentRoute.includes('#overlay')) {
    return <Overlay />;
  } else if (currentRoute.includes('#pedals-coach')) {
    return <PedalsCoachOverlay />;
  } else if (currentRoute.includes('#line-coach')) {
    return <LineCoachOverlay />;
  } else {
    return <App />;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
