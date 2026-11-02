"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Photo } from "@/types/photo";
import { PERSPECTIVE } from "@/lib/photoPosition";
import {
  WALL_ARC_LENGTH, WALL_ARM, WALL_FRONT_SCALE, WALL_HEIGHT, wallIndexU, wallOutline, wallPlacement, wallPose,
  wallProject, wallShift, type WallPosition,
} from "@/lib/wallPosition";
import type { YearMarker } from "@/lib/yearMarkers";
import { PhotoFrame } from "./PhotoCard";

const OUTLINE = wallOutline();
const BELT_END = WALL_ARC_LENGTH + WALL_ARM;
const SEAM = 600; // spacing of the belt's seams, which show it moving
const RAIL = 10; // top and bottom trim
const TOP = -WALL_HEIGHT / 2;
const YEAR_Y = TOP + 62;
// The belt's front fills the stage from top to bottom; narrow stages fit its front width instead.
const DESIGN_WIDTH = 900;
const BELT_COLOR = [244, 244, 238];

// Shading uses a dark overlay rather than a filter, which is costly on many 3D cards, in small steps
// because each change repaints the card while a moving transform does not.
const dim = (shade: number) => Math.round((1 - shade) * 40) / 40;
const YEAR_COLOR = [116, 128, 112];

function poseTransform(x: number, y: number, z: number, angle: number) {
  return `translate3d(${x}px, ${y}px, ${z}px) rotateY(${angle}rad) translate(-50%, -50%)`;
}

/** Projected band of the belt between two heights, as SVG polygon points. */
function band(scale: number, top: number, bottom: number) {
  const upper = OUTLINE.map(u => wallProject(u, top));
  const lower = OUTLINE.map(u => wallProject(u, bottom)).reverse();
  return [...upper, ...lower].map(point => `${(point.x * scale).toFixed(1)},${(point.y * scale).toFixed(1)}`).join(" ");
}

type Props = {
  photos: Photo[]; start: number; end: number; cameraZ: number;
  positions: Map<string, WallPosition>; years: YearMarker[];
  onOpen: (photo: Photo) => void;
};
export default function PhotoWall({ photos, start, end, cameraZ, positions, years, onOpen }: Props) {
  const scene = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = scene.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setStage({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = stage.height ? Math.min(stage.height / (WALL_HEIGHT * WALL_FRONT_SCALE), stage.width / DESIGN_WIDTH) : 1;
  // The belt is flat and its vertical edges stay vertical in perspective, so it is drawn as a projected 2D
  // outline behind the 3D photos. Only the photos and year labels are 3D; the stage never repaints the belt.
  const belt = useMemo(() => {
    const ends = [wallProject(-BELT_END, 0).x * scale, wallProject(BELT_END, 0).x * scale];
    const stops = OUTLINE.map(u => {
      const point = wallProject(u, 0);
      const [r, g, b] = BELT_COLOR.map(channel => Math.round(channel * point.shade));
      return { offset: (point.x * scale - ends[0]) / (ends[1] - ends[0]), color: `rgb(${r},${g},${b})` };
    });
    return {
      ends, stops,
      surface: band(scale, TOP, -TOP),
      rails: [band(scale, TOP, TOP + RAIL), band(scale, -TOP - RAIL, -TOP)],
    };
  }, [scale]);
  const shift = wallShift(cameraZ);
  const seams: { key: number; x: number; y: number; width: number }[] = [];
  for (let seam = Math.ceil((shift - BELT_END) / SEAM); seam * SEAM - shift <= BELT_END; seam++) {
    const point = wallProject(seam * SEAM - shift, -TOP - RAIL);
    seams.push({ key: seam, x: point.x * scale, y: point.y * scale, width: Math.max(.5, 2 * point.y / -TOP * scale) });
  }

  return <>
    <div className="wall-room" aria-hidden="true" />
    {stage.width > 0 && <svg className="wall-belt" aria-hidden="true"
      viewBox={`${-stage.width / 2} ${-stage.height / 2} ${stage.width} ${stage.height}`}>
      <defs>
        <linearGradient id="wall-shade" gradientUnits="userSpaceOnUse" x1={belt.ends[0]} x2={belt.ends[1]} y1={0} y2={0}>
          {belt.stops.map((stop, index) => <stop key={index} offset={stop.offset} stopColor={stop.color} />)}
        </linearGradient>
        <linearGradient id="wall-light" x1={0} x2={0} y1={0} y2={1}>
          <stop offset={0} stopColor="#000" stopOpacity={.06} />
          <stop offset={.18} stopColor="#000" stopOpacity={0} />
          <stop offset={.82} stopColor="#000" stopOpacity={0} />
          <stop offset={1} stopColor="#000" stopOpacity={.07} />
        </linearGradient>
      </defs>
      <polygon points={belt.surface} fill="url(#wall-shade)" />
      <polygon points={belt.surface} fill="url(#wall-light)" />
      {seams.map(seam => <line key={seam.key} className="wall-belt__seam" x1={seam.x} x2={seam.x} y1={-seam.y} y2={seam.y} strokeWidth={seam.width} />)}
      {belt.rails.map((rail, index) => <polygon key={index} className="wall-belt__rail" points={rail} />)}
    </svg>}
    {/* Scaling the perspective with the world keeps the same view at any stage size. */}
    <div ref={scene} className="scene wall-scene" aria-label="Photo wall" style={{ perspective: `${PERSPECTIVE * scale}px` }}>
      <div className="wall-world" style={{ transform: `scale3d(${scale}, ${scale}, ${scale})` }}>
        {years.map(marker => {
          const u = wallIndexU(marker.photoIndex, cameraZ);
          const pose = wallPose(u, 2);
          return <div key={`${marker.year}-${marker.photoIndex}`} className="wall-year" aria-hidden="true"
            data-year={marker.year} data-photo-index={marker.photoIndex}
            style={{ transform: poseTransform(pose.x, YEAR_Y, pose.z, pose.angle), color: `rgb(${YEAR_COLOR.map(channel => Math.round(channel * pose.shade)).join(",")})` }}>
            {marker.year}
          </div>;
        })}
        {photos.slice(start, end).map((photo, offset) => {
          const index = start + offset;
          const position = positions.get(photo.id)!;
          const place = wallPlacement(index, cameraZ, position);
          if (!place.visible) return null;
          const style = {
            transform: poseTransform(place.pose.x, place.y, place.pose.z, place.pose.angle),
            opacity: place.opacity,
            "--wall-dim": dim(place.pose.shade),
          } as CSSProperties;
          return <PhotoFrame key={photo.id} className="photo-card--wall" photo={photo} index={index}
            relativeZ={place.relativeZ} style={style} onOpen={onOpen} data={{ "data-wall-layer": position.layer }} />;
        })}
      </div>
    </div>
  </>;
}
