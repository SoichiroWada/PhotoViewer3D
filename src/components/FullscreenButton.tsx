"use client";

import { useEffect, useState } from "react";

/** Toggles browser full screen for the whole page; hidden where the API is unavailable (e.g. iPhone Safari). */
export default function FullscreenButton() {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Checked after hydration so the static HTML always matches the first render.
    setSupported(document.fullscreenEnabled);
    const update = () => setActive(document.fullscreenElement !== null);
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  if (!supported) return null;
  const toggle = () => {
    const request = active ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    request.catch(() => undefined); // Refused by the browser; the label follows fullscreenchange anyway.
  };
  return (
    <button className="button" onClick={toggle}>
      {active ? "Exit full screen" : "Full screen"} <span aria-hidden="true">{active ? "↙" : "⛶"}</span>
    </button>
  );
}
