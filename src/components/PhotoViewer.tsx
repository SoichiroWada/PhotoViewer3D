"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Photo } from "@/types/photo";
import { getPhotos } from "@/lib/api/photoApi";
import { deletePhotos } from "@/lib/api/awsApi";
import { selectionRange } from "@/lib/photoSelection";
import {
  cameraLimit, cameraStep, clampCamera, createPhotoPositions, DEPTH_SPACING,
  visibleWindow, wheelDistance,
} from "@/lib/photoPosition";
import { parseSortOrder, SORT_OPTIONS, sortOrderValue, sortPhotos } from "@/lib/photoSort";
import { createYearMarkers, nearbyYearMarkers } from "@/lib/yearMarkers";
import Corridor from "./Corridor";
import CorridorYears from "./CorridorYears";
import PhotoCard from "./PhotoCard";
import PhotoGrid, { type SelectMode } from "./PhotoGrid";
import DeleteConfirmDialog from "./DeleteConfirmDialog";
import PhotoModal from "./PhotoModal";
import UploadButton from "./UploadButton";
import { useAuth } from "./AuthGate";
import FullscreenButton from "./FullscreenButton";

type LoadState = "loading" | "ready" | "error";
type ViewMode = "corridor" | "grid";
const VIEW_MODE_KEY = "photoviewer3d.viewMode";
const SORT_ORDER_KEY = "photoviewer3d.sortOrder";
const DEMO_UNAVAILABLE = "Not available in demo mode";

// Remembered per browser; storage can be unavailable (private windows, previews).
function readSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeSetting(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* not remembered */ }
}

export default function PhotoViewer() {
  const auth = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [cameraZ, setCameraZ] = useState(0);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("corridor");
  const [sortOrder, setSortOrder] = useState(() => parseSortOrder(null));
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<{ busy: boolean; error?: string } | null>(null);
  const selectionAnchor = useRef<string | null>(null);
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
  const corridor = viewMode === "corridor";
  // The corridor always walks back in time; only the grid follows the chosen order.
  const gridPhotos = useMemo(() => corridor ? [] : sortPhotos(photos, sortOrder), [corridor, photos, sortOrder]);
  // Deleting is an AWS-only feature; the local backend serves the original backup directory.
  const canDelete = auth.mode === "cognito";
  // The demo shows the same controls, greyed out; the API refuses demo uploads and deletes regardless.
  const demo = auth.mode === "cognito" && auth.demo;
  const checkedPhotos = useMemo(() => gridPhotos.filter(item => checkedIds.has(item.id)), [gridPhotos, checkedIds]);
  const clearSelection = useCallback(() => { setCheckedIds(new Set()); selectionAnchor.current = null; }, []);
  const selectPhoto = useCallback((item: Photo, mode: SelectMode) => {
    const anchor = selectionAnchor.current;
    setCheckedIds(current => {
      const next = new Set(current);
      if (mode === "range" && anchor) {
        for (const id of selectionRange(gridPhotos.map(entry => entry.id), anchor, item.id)) next.add(id);
      } else if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    selectionAnchor.current = item.id;
  }, [gridPhotos]);
  const confirmDelete = async () => {
    if (auth.mode !== "cognito") return;
    setDeleting({ busy: true });
    const result = await deletePhotos(checkedPhotos.map(item => item.id), auth.getAccessToken);
    const deleted = new Set(result.deleted);
    setPhotos(current => current.filter(item => !deleted.has(item.id)));
    setCheckedIds(current => new Set([...current].filter(id => !deleted.has(id))));
    // Failed photos stay selected so the dialog can retry them.
    setDeleting(result.failed.length
      ? { busy: false, error: `${result.failed.length} photo(s) could not be deleted: ${result.failed[0]!.error}` }
      : null);
  };
  const move = useCallback((distance: number) => {
    target.current = clampCamera(target.current + distance, photos.length);
  }, [photos.length]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");
    getPhotos({ signal: controller.signal, getAccessToken: auth.mode === "cognito" ? auth.getAccessToken : undefined })
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
  }, [reload, auth]);

  useEffect(() => {
    // Read after hydration so the static HTML always matches the first render.
    if (readSetting(VIEW_MODE_KEY) === "grid") setViewMode("grid");
    setSortOrder(parseSortOrder(readSetting(SORT_ORDER_KEY)));
  }, []);
  const changeViewMode = (mode: ViewMode) => { setViewMode(mode); writeSetting(VIEW_MODE_KEY, mode); clearSelection(); };
  useEffect(clearSelection, [reload, clearSelection]);

  useEffect(() => {
    if (corridor || selected || deleting) return;
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (element.matches("input:not([type=checkbox]), textarea, select") || element.isContentEditable) return;
      if (event.key === "Escape" && checkedIds.size) clearSelection();
      if (event.key === "Delete" && checkedIds.size && canDelete && !demo) { event.preventDefault(); setDeleting({ busy: false }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [corridor, selected, deleting, checkedIds, canDelete, demo, clearSelection]);

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
  }, [move, photos.length, selected, corridor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!corridor || selected || !photos.length || event.altKey || event.ctrlKey || event.metaKey) return;
      const element = event.target as HTMLElement;
      if (element.matches("input, textarea, select") || element.isContentEditable) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? DEPTH_SPACING : -DEPTH_SPACING);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, photos.length, selected, corridor]);

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
          <FullscreenButton />
          <span className="photo-count">{loadState === "ready" ? `${photos.length} photos` : "Your photo collection"}</span>
          <div className="view-switch" role="group" aria-label="View">
            <button className="view-switch__option" aria-pressed={corridor} onClick={() => changeViewMode("corridor")}>3D</button>
            <button className="view-switch__option" aria-pressed={!corridor} onClick={() => changeViewMode("grid")}>Grid</button>
          </div>
          {corridor && <button className="button" onClick={returnToPresent} disabled={!photos.length || cameraZ < 1}>Back to present <span aria-hidden="true">↶</span></button>}
          {auth.mode === "cognito" && <>
            <UploadButton getAccessToken={auth.getAccessToken} onUploaded={() => setReload(value => value + 1)}
              unavailable={demo ? DEMO_UNAVAILABLE : undefined} />
            <button className="button" onClick={auth.signOut} title={demo ? undefined : auth.email ?? undefined}>{demo ? "Exit demo" : "Sign out"}</button>
          </>}
        </div>
      </header>

      {!corridor && <section className="grid-view" aria-label="Photo list view">
        <div className="grid-toolbar">
          <label className="grid-toolbar__sort">Sort by
            <select value={sortOrderValue(sortOrder)} onChange={event => {
              setSortOrder(parseSortOrder(event.target.value));
              writeSetting(SORT_ORDER_KEY, event.target.value);
            }}>
              {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {canDelete && loadState === "ready" && photos.length > 0 && <div className="grid-toolbar__selection">
            <span className="grid-toolbar__count" aria-live="polite">{checkedIds.size ? `${checkedIds.size} selected` : "Ctrl/Shift-click or tick photos to select"}</span>
            {checkedIds.size < gridPhotos.length && <button className="button" onClick={() => setCheckedIds(new Set(gridPhotos.map(item => item.id)))}>Select all</button>}
            {checkedIds.size > 0 && <button className="button" onClick={clearSelection}>Clear</button>}
            <button className="button button--danger" disabled={!checkedIds.size || demo} title={demo ? DEMO_UNAVAILABLE : undefined} onClick={() => setDeleting({ busy: false })}>Delete{checkedIds.size ? ` (${checkedIds.size})` : ""}</button>
          </div>}
        </div>
        {loadState === "ready" && <PhotoGrid photos={gridPhotos} onOpen={setSelected}
          selection={canDelete ? { ids: checkedIds, onSelect: selectPhoto } : undefined} />}
        {loadState === "loading" && <div className="grid-message" role="status"><span className="loader" /><h2>Opening your collection</h2></div>}
        {loadState === "error" && <div className="grid-message" role="alert"><h2>Couldn’t open the collection</h2><p>{error}</p><button className="button button--primary" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
        {loadState === "ready" && !photos.length && <div className="grid-message"><h2>No photos yet</h2><button className="button" onClick={() => setReload(value => value + 1)}>Reload photos</button></div>}
      </section>}

      {corridor && <>
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
        {loadState === "ready" && !photos.length && <div className="viewer-message"><h2>Your corridor is waiting</h2><p>{auth.mode === "cognito" ? "Use Upload to add JPG, PNG, or WebP photos." : "Add JPG, PNG, or WebP images to the configured photo directory."}</p><button className="button" onClick={() => setReload(value => value + 1)}>Reload photos</button></div>}
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
      </>}
      {deleting && checkedPhotos.length > 0 && <DeleteConfirmDialog filenames={checkedPhotos.map(item => item.filename)}
        busy={deleting.busy} error={deleting.error} onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)} />}
      {selected && <PhotoModal key={selected.id} photo={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
