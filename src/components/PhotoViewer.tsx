"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Photo } from "@/types/photo";
import { getPhotos } from "@/lib/api/photoApi";
import {
  cameraLimit, cameraStep, clampCamera, createPhotoPositions, DEPTH_SPACING,
  visibleWindow, wheelDistance,
} from "@/lib/photoPosition";
import { createYearMarkers, nearbyYearMarkers } from "@/lib/yearMarkers";
import Corridor from "./Corridor";
import CorridorYears from "./CorridorYears";
import PhotoCard from "./PhotoCard";
import PhotoModal from "./PhotoModal";

type LoadState = "loading" | "ready" | "error";

export default function PhotoViewer() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [cameraZ, setCameraZ] = useState(0);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const target = useRef(0);
  const current = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const positions = useMemo(() => createPhotoPositions(photos), [photos]);
  const yearMarkers = useMemo(() => createYearMarkers(photos), [photos]);
  const { start, end } = visibleWindow(photos.length, cameraZ);
  const visibleYears = useMemo(() => nearbyYearMarkers(yearMarkers, start, end), [yearMarkers, start, end]);
  const nearest = photos.length ? Math.min(photos.length - 1, Math.max(0, Math.floor(cameraZ / DEPTH_SPACING))) : 0;
  const photo = photos[nearest];
  const limit = cameraLimit(photos.length);
  const atEnd = photos.length > 0 && cameraZ >= limit - 1;
  const move = useCallback((distance: number) => {
    target.current = clampCamera(target.current + distance, photos.length);
  }, [photos.length]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");
    getPhotos({ signal: controller.signal })
      .then(data => {
        setPhotos(data);
        target.current = current.current = 0;
        setCameraZ(0);
        setLoadState("ready");
      })
      .catch(reason => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Unable to load photos.");
        setLoadState("error");
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let frame = 0;
    let lastTime = 0;
    const animate = (time: number) => {
      const elapsed = lastTime ? time - lastTime : 16;
      lastTime = time;
      const next = reducedMotion ? target.current : cameraStep(current.current, target.current, elapsed);
      if (next !== current.current) { current.current = next; setCameraZ(next); }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (selected || !photos.length || event.ctrlKey) return;
      event.preventDefault();
      move(wheelDistance(event.deltaY, event.deltaMode, element.clientHeight));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [move, photos.length, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (selected || !photos.length || event.altKey || event.ctrlKey || event.metaKey) return;
      const element = event.target as HTMLElement;
      if (element.matches("input, textarea, select") || element.isContentEditable) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? DEPTH_SPACING : -DEPTH_SPACING);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, photos.length, selected]);

  const openPhoto = useCallback((next: Photo) => {
    // Freeze the camera while browsing an original.
    target.current = current.current;
    setSelected(next);
  }, []);
  const returnToPresent = () => { target.current = 0; };

  return (
    <main className="viewer">
      <header className="viewer-header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true"><span /><span /></span>
          <div><p className="eyebrow">A walk through time</p><h1>3D Photo Viewer</h1></div>
        </div>
        <div className="header-actions">
          <span className="photo-count">{loadState === "ready" ? `${photos.length} photos` : "Your photo collection"}</span>
          <button className="button" onClick={returnToPresent} disabled={!photos.length || cameraZ < 1}>Back to present <span aria-hidden="true">↶</span></button>
        </div>
      </header>

      <div ref={stage} className="viewer-stage" tabIndex={0} aria-label="Photo corridor. Scroll or use up and down arrow keys to travel through time."
        data-camera-z={cameraZ.toFixed(2)}
        onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
        onPointerDown={event => {
          if (event.pointerType === "mouse" || selected) return;
          suppressClick.current = false;
          pointer.current = { id: event.pointerId, y: event.clientY, moved: false };
        }}
        onPointerMove={event => {
          const touch = pointer.current;
          if (!touch || touch.id !== event.pointerId) return;
          const distance = touch.y - event.clientY;
          if (!touch.moved && Math.abs(distance) < 6) return;
          if (!touch.moved) stage.current?.setPointerCapture(event.pointerId);
          touch.moved = true;
          touch.y = event.clientY;
          move(distance * 3);
        }}
        onPointerUp={() => { suppressClick.current = pointer.current?.moved ?? false; pointer.current = null; }}
        onPointerCancel={() => { pointer.current = null; suppressClick.current = false; }}>
        <Corridor />
        <CorridorYears markers={visibleYears} cameraZ={cameraZ} />
        <div className="scene" aria-label="Floating photos">
          {photos.slice(start, end).map((item, offset) => <PhotoCard key={item.id}
            photo={item} index={start + offset} cameraZ={cameraZ}
            position={positions.get(item.id)!} onOpen={openPhoto} />)}
        </div>
        <span className="stage-label"><span className="status-dot" /> {atEnd ? "End of the collection" : "Memories in perspective"}</span>
        {loadState === "loading" && <div className="viewer-message" role="status"><span className="loader" /><h2>Opening your collection</h2><p>Bringing your memories into view.</p></div>}
        {loadState === "error" && <div className="viewer-message" role="alert"><h2>Couldn’t open the collection</h2><p>{error}</p><button className="button button--primary" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
        {loadState === "ready" && !photos.length && <div className="viewer-message"><h2>Your corridor is waiting</h2><p>Add JPG, PNG, or WebP images to the configured photo directory.</p><button className="button" onClick={() => setReload(value => value + 1)}>Reload photos</button></div>}
        {atEnd && <div className="viewer-message viewer-message--end"><p className="eyebrow">The beginning of your story</p><h2>You’ve reached the oldest memory.</h2><button className="button button--primary" onClick={returnToPresent}>Return to present</button></div>}
      </div>

      <footer className="timeline-panel">
        <div className="timeline-panel__top">
          <div className="current-memory"><p className="eyebrow">{atEnd ? "Collection explored" : "Around this moment"}</p>
            <span className="current-memory__date">{photo ? new Date(photo.takenAt).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "—"}</span>
            <span className="current-memory__index">{photos.length ? `${nearest + 1} / ${photos.length}` : ""}</span>
          </div>
          <div className="navigation-controls">
            <button className="icon-button" onClick={() => move(-DEPTH_SPACING)} disabled={!photos.length || cameraZ <= 0} aria-label="Move toward newer photos">↑</button>
            <button className="icon-button" onClick={() => move(DEPTH_SPACING)} disabled={!photos.length || atEnd} aria-label="Move toward older photos">↓</button>
          </div>
        </div>
        <div className="timeline-track">
          <span>Present</span>
          <input aria-label="Travel through the photo timeline" type="range" min={0} max={limit || 1} step="any"
            value={cameraZ} disabled={!photos.length} onChange={event => { target.current = Number(event.target.value); }}
            style={{ "--progress": `${limit ? cameraZ / limit * 100 : 0}%` } as React.CSSProperties} />
          <span>Past</span>
        </div>
        <p className="navigation-hint"><span aria-hidden="true">↕</span> Scroll to travel <span className="hint-divider">·</span> <kbd>↑</kbd> <kbd>↓</kbd> to step <span className="hint-divider">·</span> Click a photo to explore</p>
      </footer>
      {selected && <PhotoModal key={selected.id} photo={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
