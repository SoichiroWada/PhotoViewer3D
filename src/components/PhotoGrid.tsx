"use client";

import { useState } from "react";
import type { Photo } from "@/types/photo";
import { photoVariantUrl } from "@/lib/photoResolution";

export type SelectMode = "toggle" | "range";
type Props = {
  photos: Photo[];
  onOpen: (photo: Photo) => void;
  /** Omitted when photos cannot be deleted (the local backend). */
  selection?: { ids: ReadonlySet<string>; onSelect: (photo: Photo, mode: SelectMode) => void };
};

const dateLabel = (photo: Photo) =>
  new Date(photo.takenAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Explorer-style "extra large icons": 5–6 columns and about four rows per screen. */
export default function PhotoGrid({ photos, onOpen, selection }: Props) {
  const selecting = Boolean(selection?.ids.size);
  return (
    <ul className={`photo-grid${selecting ? " photo-grid--selecting" : ""}`} aria-label="Photo list">
      {photos.map((photo, index) => {
        const checked = selection?.ids.has(photo.id) ?? false;
        return <li key={photo.id} className={`photo-tile${checked ? " photo-tile--selected" : ""}`}>
          {/* Ctrl/⌘-click toggles and Shift-click selects a range; while selecting, a plain click toggles too. */}
          <button className="photo-tile__open" data-photo-id={photo.id} data-photo-index={index}
            aria-label={`View ${photo.filename}`} title={`${photo.filename}\n${dateLabel(photo)}`}
            onClick={event => {
              if (selection && event.shiftKey) selection.onSelect(photo, "range");
              else if (selection && (event.ctrlKey || event.metaKey || selecting)) selection.onSelect(photo, "toggle");
              else onOpen(photo);
            }}>
            <span className="photo-tile__image"><GridImage photo={photo} /></span>
            <span className="photo-tile__filename">{photo.filename}</span>
          </button>
          {selection && <input type="checkbox" className="photo-tile__check" checked={checked}
            aria-label={`Select ${photo.filename}`}
            onChange={() => { /* handled on click, where the Shift key is known */ }}
            onClick={event => selection.onSelect(photo, event.shiftKey ? "range" : "toggle")} />}
        </li>;
      })}
    </ul>
  );
}

function GridImage({ photo }: { photo: Photo }) {
  // The pre-rendered variants come first; the original is the last resort.
  const [stage, setStage] = useState<"variants" | "original" | "failed">("variants");
  if (stage === "failed") return <span className="photo-card__failed">Image unavailable</span>;
  const small = photoVariantUrl(photo, "small");
  return <img alt={photo.filename} draggable={false} loading="lazy" decoding="async"
    src={stage === "original" ? photo.originalUrl : small}
    srcSet={stage === "original" ? undefined : `${small} 320w, ${photoVariantUrl(photo, "medium")} 800w`}
    sizes="(max-width: 640px) 50vw, (max-width: 1100px) 25vw, 20vw"
    onError={() => setStage(current => current === "variants" ? "original" : "failed")} />;
}
