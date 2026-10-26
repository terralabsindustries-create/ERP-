import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Scrolling the page with the pointer over a focused number field would step
// its value up or down (a price, a quantity) without anyone noticing. Taking
// focus off the field first lets the wheel scroll the page instead.
document.addEventListener(
  'wheel',
  (event) => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.type === 'number' && el === event.target) el.blur();
  },
  { passive: true }
);

createRoot(document.getElementById("root")!).render(<App />);
