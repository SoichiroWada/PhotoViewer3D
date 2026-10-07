import { yearDepth } from "@/lib/photoPosition";
import type { YearMarker } from "@/lib/yearMarkers";

/** Separate decorative layer: wall-mounted years never capture photo clicks. */
export default function CorridorYears({ markers, cameraZ }: {
  markers: YearMarker[]; cameraZ: number;
}) {
  return (
    <div className="scene corridor-years" aria-hidden="true">
      {markers.map(marker => {
        const depth = yearDepth(marker.photoIndex, cameraZ);
        if (!depth.visible) return null;
        return (
          <div key={`${marker.year}-${marker.photoIndex}`} className="corridor-year"
            data-year={marker.year} data-photo-index={marker.photoIndex}
            data-photo-z={marker.photoZ} data-relative-z={depth.relativeZ.toFixed(2)}
            style={{
              // The wall is at the right viewport edge before projection. Its
              // inward-facing plane runs down the corridor, rather than facing
              // the viewer like the floating photo cards.
              transform: `translate3d(50vw, 0, ${depth.translateZ}px) rotateY(-90deg)`,
              opacity: depth.opacity,
            }}>
            <span className="corridor-year__text">{marker.year}</span>
          </div>
        );
      })}
    </div>
  );
}
