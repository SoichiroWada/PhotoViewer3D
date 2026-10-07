# 3D Photo Viewer

A local Next.js / React / TypeScript application that lets you travel through a
chronological collection of floating photographs using CSS perspective.

## Run locally

Requires Node.js 20.9 or newer. This project was verified using Node.js 24.

```bash
cd /mnt/disk2/CODEX/PhotoViewer3D
npm install
# .env.local is already configured for the supplied photo directory.
# On a fresh checkout: cp .env.example .env.local
npm run dev
```

Open http://127.0.0.1:3000. For a production server:

```bash
npm run build
npm run start
```

Both scripts bind to loopback by default. This is a local viewer; authentication
and access controls for an externally accessible deployment are not included.

## Configuration

Set this server-only environment variable in `.env.local`:

```dotenv
PHOTO_DIRECTORY=/mnt/disk2/CODEX/Photos
```

Restart the server after changing the setting. The directory is scanned
non-recursively. JPG/JPEG, PNG, and WebP extensions are case-insensitive;
filenames with spaces and Unicode are supported. Files are read in place and are
never copied to `public/` or modified. Symlinks are excluded.

`GET /api/photos` returns the `Photo[]` metadata sorted by filesystem modification
time descending, with filename order as a stable tie-breaker. The server caches
the scan for five seconds. Reload the page to pick up directory changes after
that interval. If the directory is empty or unreadable, the UI offers a reload
or retry action. The filesystem path is not included in public metadata.

`GET /api/photos/[id]` streams a cataloged image through an opaque stable ID,
sets its MIME type, and supports ETag revalidation. No arbitrary filesystem
path is accepted. A file deleted after scanning returns 404.

## Controls

- Wheel down: travel continuously toward older photos.
- Wheel up: return toward newer photos. Small deltas cause small movement.
- ArrowDown / ArrowUp: move approximately one photo depth interval.
- Timeline slider: travel to any position.
- Touch: swipe upward to move toward the past; tap a card to view it.
- Click a photo: open its original in a browser lightbox.
- Escape, the close button, or the backdrop: close the lightbox.
- Open original: open the original image in a new browser tab.
- Back to present: return to the newest photo.

Wheel capture applies to the corridor; browser Ctrl+wheel zoom is preserved.
The lightbox suspends camera navigation. Native `<dialog>` provides focus
containment and the previous control receives focus after closing.

## Implementation

- `src/types/photo.ts`: `Photo` includes `id`, `filename`, `thumbnailUrl`,
  `originalUrl`, and ISO `takenAt`.
- `src/lib/photoLoader.ts`: server-only, bounded-concurrency scanning, metadata
  cache, timestamp extraction, ID mapping, and safe image opening.
  `readTakenAt` is the extension point for EXIF DateTimeOriginal.
- `src/lib/photoPosition.ts`: ID-seeded X/Y rejection sampling without visible
  rows or bands. Up to twelve candidates avoid clustering against the three
  adjacent depths where practical. Coordinates are calculated once per catalog
  and reused during renders and camera movement. A changed catalog can alter
  nearby overlap choices; Phase 1 does not persist positions across catalog edits.
- `PhotoViewer`: wheel/key/touch input updates a clamped target camera.
  Time-based animation-frame interpolation eases the current camera toward it.
- `PhotoCard`: `photoZ = index * 420`, `relativeZ = photoZ - cameraZ`,
  `translateZ = -(relativeZ + 300)`. A 900px CSS perspective produces increasing
  size as the camera approaches. The card fades and unmounts before the camera
  plane is reached, avoiding the perspective singularity. X/Y adapt to viewport
  size, while chronology alone determines Z.
- Only a window of five passed and 25 upcoming indices, plus the current index,
  is considered (at most 31 slots; passed cards beyond the cutoff are absent).
  Original images are lazy loaded at distant depths. The full metadata catalog
  remains in memory.
- `PhotoModal`: isolated browser viewing behavior for possible future native
  integration; original viewing does not launch a Windows application.
- `CorridorYears` and `src/lib/yearMarkers.ts`: actual year boundaries derived
  from the photo dates, anchored at the first photo depth of each year. Text is
  rotated 90 degrees left on an inward-facing right-wall plane, clipped to the
  wall and moved with the same camera and perspective as the photos. Nearby
  marker selection uses binary search; labels never capture pointer events.
  Calendar years match the local dates displayed elsewhere in the viewer.
- `Corridor`: CSS floor, ceiling, side walls, lighting, and depth guides. The
  supplied stock image is a visual reference only and is not copied into the app.
- Reduced-motion preference removes camera easing. Accessible controls remain
  usable through the keyboard, with visible focus states.

## Validation

```bash
npm run test
npm run typecheck
npm run build
# Requires a production build and Chromium installed by Playwright:
npx playwright install chromium
npm run test:browser
# Alternatively, use an existing Chrome installation:
CHROME_PATH=/usr/bin/google-chrome npm run test:browser
```

Browser tests start a local production server when needed. Set `TEST_BASE_URL`
only when testing an already-running server at another address.

Tests cover ordering, supported filenames, symlink rejection, invalid IDs,
missing/empty directories, stable scattered positions, projection and passing,
wheel normalization, interpolation, camera bounds, real photo delivery/ETags,
lightbox focus, responsive layout, and bounded DOM rendering with a 10,000-item
mock catalog.

## Phase 1 limitations

- Filesystem mtime is a placeholder for capture date. Copied or edited files
  may appear newer than they are. EXIF capture timestamps are not read yet.
- `thumbnailUrl` and `originalUrl` intentionally use the same endpoint. Full
  images can be bandwidth- and decoding-heavy; cached thumbnail generation is
  the next optimization and no Sharp-based pipeline is required.
- Overlap avoidance reduces local clustering but is not a collision-free
  layout. Cards enlarge beyond the viewport as you pass them intentionally.
  A partially or completely occluded card becomes easier to select as you move.
- Directory scanning and metadata payload are still proportional to collection
  size; only photo DOM mounting is virtualized. Very large collections may need
  pagination, a persistent catalog, and background indexing.
- No recursive folders, uploads, EXIF extraction, Windows-native integration,
  authentication, or live directory watching in this version.
- Modern browsers with CSS 3D transforms and native dialog support are required.
  Chrome is the browser exercised by the included end-to-end tests.
