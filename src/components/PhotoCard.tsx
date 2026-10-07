"use client";

import type { CSSProperties } from "react";
import type { Photo } from "@/types/photo";
import { photoDepth, type Position } from "@/lib/photoPosition";
import AdaptivePhotoImage from "./AdaptivePhotoImage";

type Props = {
  photo: Photo; index: number; cameraZ: number; position: Position;
  onOpen: (photo: Photo) => void;
};
export default function PhotoCard({ photo, index, cameraZ, position, onOpen }: Props) {
  const depth = photoDepth(index, cameraZ);
  if (!depth.visible) return null;
  const style = {
    "--photo-x": position.x,
    "--photo-y": position.y,
    transform: `translate3d(calc(var(--photo-x) * min(40vw, 570px)), calc(var(--photo-y) * min(31svh, 260px)), ${depth.translateZ}px) translate(-50%, -50%)`,
    opacity: depth.opacity,
    filter: `brightness(${depth.brightness})`,
    // CSS depth ordering handles paint; the frontmost card also wins hit testing.
    zIndex: 10000 - index,
  } as CSSProperties;
  return (
    <button className="photo-card" style={style} onClick={() => onOpen(photo)}
      data-photo-id={photo.id} data-photo-index={index} data-relative-z={depth.relativeZ.toFixed(2)}
      aria-label={`View ${photo.filename}`}>
      <span className="photo-card__image">
        <AdaptivePhotoImage key={photo.thumbnailUrl} photo={photo} relativeZ={depth.relativeZ} />
      </span>
      <span className="photo-card__caption">
        <span className="photo-card__filename">{photo.filename}</span>
        <span>{new Date(photo.takenAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
      </span>
    </button>
  );
}
