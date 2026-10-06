"use client";

import { useEffect, useRef, useState } from "react";
import type { Photo } from "@/types/photo";

/** Browser viewing is isolated here for a future native integration. */
export default function PhotoModal({ photo, onClose }: { photo: Photo; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previouslyFocused?.focus(); };
  }, []);
  return (
    <dialog ref={dialog} className="photo-modal" aria-labelledby="photo-title"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === dialog.current) onClose(); }}>
      <div className="photo-modal__inner">
        <div className="photo-modal__header">
          <div><p className="eyebrow">A closer look</p><h2 id="photo-title">{photo.filename}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close photo" autoFocus>×</button>
        </div>
        <div className="photo-modal__image">
          {failed ? <p>This photo could not be loaded. Try opening the original.</p> :
            <img src={photo.originalUrl} alt={photo.filename} onError={() => setFailed(true)} />}
        </div>
        <div className="photo-modal__footer">
          <span>{new Date(photo.takenAt).toLocaleString()}</span>
          <a className="button button--primary" href={photo.originalUrl} target="_blank" rel="noopener noreferrer">Open original <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </dialog>
  );
}
