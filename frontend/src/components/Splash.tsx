import { useEffect, useState } from "react";
import { Cloud, FolderTree, Lightbulb, Lock, Share2 } from "lucide-react";

const STEPS = [
  "Securing your session…",
  "Connecting to your Telegram storage…",
  "Loading your folders…",
  "Almost there…",
];
const TIPS = [
  "Send or forward any file to your bot and it is saved here automatically.",
  "Star a file to keep it in Favorites for quick access.",
  "Deleted something by mistake? Tap Undo, or restore it from Trash within 30 days.",
  "Share a file with a private link and revoke it any time.",
  "Search looks through every folder at once.",
];

/** Branded loading screen shown while the session, settings and folders load. */
export function Splash() {
  const [step, setStep] = useState(0);
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);

  useEffect(() => {
    const timer = window.setInterval(() => setStep((value) => Math.min(value + 1, STEPS.length - 1)), 1600);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="splash" id="main">
      <span className="sr-only" role="status">Opening Cloud Drive</span>
      <div className="splash-glow splash-glow-a" aria-hidden="true" />
      <div className="splash-glow splash-glow-b" aria-hidden="true" />
      <div className="splash-card" aria-hidden="true">
        <div className="splash-logo">
          <span className="splash-ring splash-ring-1" />
          <span className="splash-ring splash-ring-2" />
          <Cloud size={36} />
        </div>
        <h1>Cloud Drive</h1>
        <p className="splash-tag">Your private files, stored in your own Telegram channel.</p>
        <div className="splash-bar">
          <span />
        </div>
        <p className="splash-step" key={step}>{STEPS[step]}</p>
        <ul className="splash-chips">
          <li>
            <Lock size={15} /> Private
          </li>
          <li>
            <FolderTree size={15} /> Organised
          </li>
          <li>
            <Share2 size={15} /> Shareable
          </li>
        </ul>
        <p className="splash-tip">
          <Lightbulb size={16} /> <span>{tip}</span>
        </p>
      </div>
    </main>
  );
}
