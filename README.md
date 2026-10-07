# 3D Photo Viewer

A local Next.js / React / TypeScript application that lets you travel through a
chronological collection of floating photographs using CSS perspective.

## Run locally

Requires Node.js 20.19 or newer. This project was verified using Node.js 24.

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

`GET /api/photos` returns the `Photo[]` metadata sorted by the selected photo date
descending, with filename order as a stable tie-breaker. Date priority is valid
EXIF `DateTimeOriginal`, then EXIF `CreateDate`, then filesystem `mtime`, and
finally a usable filesystem `birthtime`. The server caches
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
  cache, ID mapping, and safe image opening.
- `src/lib/photoDate.ts`: strict EXIF date validation and filesystem fallbacks,
  using exifr 7.1.3 to parse only capture date and associated timezone-offset tags.
  JPEGs use bounded chunked reading. PNG/WebP readers skip pixel payloads and
  pass only their EXIF chunk to exifr (at most 320 KiB, 512 container headers).
  Unchanged date results are cached by path, inode, size, mtime, ctime, and
  birthtime, including shared pending work; removed files are pruned after scans.
  Malformed or missing metadata falls back per photo without failing the catalog.
  `next.config.ts` keeps exifr external so its Node filesystem reader also works
  in the production build.
  `loadPhotoDateDiagnostics()` in the server-only loader exposes `source`
  (`dateTaken`, `dateModified`, or `dateCreated`) and the selected EXIF tag during
  development. These fields are not added to the public `Photo` JSON.
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
  plane is reached, avoiding the perspective singularity. Desktop card width is
  `clamp(320px, 28vw, 460px)` and its image-frame height is
  `clamp(220px, 20vw, 320px)`; `object-fit: contain` keeps the whole photo visible.
  At widths up to 640px, the existing 175px card and 115px image height remain.
  Passed photos fade from relative depth -600 to -800 (1.5x to 2.25x perspective
  scale), then unmount. Wall-year labels retain their -750 to -1050 lifecycle,
  and the camera's final travel distance remains unchanged. X/Y adapt to viewport
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

Tests cover capture-date priority, real JPEG/PNG/WebP EXIF, invalid/malformed
metadata, date cache invalidation, effective-date sorting, supported filenames,
symlink rejection, invalid IDs,
missing/empty directories, stable scattered positions, projection and passing,
wheel normalization, interpolation, camera bounds, real photo delivery/ETags,
lightbox focus, responsive layout, and bounded DOM rendering with a 10,000-item
mock catalog.

## Phase 1 limitations

- EXIF dates with an offset use that offset; dates without one use the server's
  local timezone. Set the server's `TZ` environment variable if the photo
  collection needs a specific timezone (for example, `Asia/Tokyo`). No location
  or timezone is inferred from the images. XMP-only dates and subsecond EXIF
  timestamps are not extracted.
- Photos without usable EXIF fall back to mtime, then positive birthtime.
  Unsupported/epoch birthtime is rejected. If every date is unavailable or
  invalid, a photo remains with an epoch placeholder and `source: null` in
  diagnostics. No capture date is invented or files dropped.
- Defensive EXIF read limits can skip metadata in unusually large or fragmented
  containers; these photos still use filesystem date fallbacks.
- `thumbnailUrl` and `originalUrl` intentionally use the same endpoint. Full
  images can be bandwidth- and decoding-heavy; cached thumbnail generation is
  the next optimization and no Sharp-based pipeline is required.
- Overlap avoidance reduces local clustering but is not a collision-free
  layout. Cards enlarge beyond the viewport as you pass them intentionally.
  A partially or completely occluded card becomes easier to select as you move.
- Directory scanning and metadata payload are still proportional to collection
  size; only photo DOM mounting is virtualized. Very large collections may need
  pagination, a persistent catalog, and background indexing.
- No recursive folders, uploads, Windows-native integration,
  authentication, or live directory watching in this version.
- Modern browsers with CSS 3D transforms and native dialog support are required.
  Chrome is the browser exercised by the included end-to-end tests.

## Automatic photo import watcher

The importer is a separate Node.js utility. It does not need the Next.js server
and does not change camera/navigation behavior. Chokidar 5 requires Node.js
20.19 or newer; this project is tested on Node.js 24.

`.env.local` is configured with:

```dotenv
PHOTO_DIRECTORY=/mnt/disk2/CODEX/Photos
PHOTO_INCOMING_DIRECTORY=/mnt/disk2/CODEX/PhotoIncoming
```

Start the utility from the project directory:

```bash
cd /mnt/disk2/CODEX/PhotoViewer3D
npm run photo-watch
```

Run `npm run dev` in a separate terminal for the viewer. The watcher loads the
existing Next.js environment files without starting Next.js. Missing configured
directories are created at startup; the operating-system user must have the
necessary read/write permissions. Incoming and final directories must be
separate and must not contain each other, including through directory symlinks.

The watcher processes files already present at startup and newly added/changed
files at the incoming directory's top level. File symlinks are rejected, and
subdirectories are not imported. Unsupported extensions are logged and left
in incoming. Supported extensions are case-insensitive JPG, JPEG, PNG, and WebP;
spaces and the extension's original capitalization are preserved.

Optional settings, shown with their defaults:

```dotenv
PHOTO_IMPORT_CONCURRENCY=4
PHOTO_IMPORT_STABILITY_MS=3000
PHOTO_IMPORT_POLL_MS=250
```

Chokidar waits for writes to settle. Every job then independently verifies that
size, mtime, ctime, and inode remain stable for the configured interval, including
startup files and files delayed in the work queue. Later arrivals can therefore
take about twice the stability interval before importing. A four-job work queue
bounds active imports and coalesces repeated events for the same path. Changes
observed during an active job schedule another attempt. Per-file failures are
logged and leave the file for a later change or watcher restart; failures do not
stop other imports. Ctrl+C closes watching, cancels outstanding stability waits,
finishes active copy operations safely, and leaves queued sources for next start.

A stability interval cannot prove that a paused producer has finished. For the
strongest handoff, copy into incoming with an unsupported temporary extension
(such as `.partial`), close the completed file, then rename it to `.JPG`, `.PNG`,
or another supported extension. Do not resume writing or replace the same path
after handing a completed image to the importer. The importer rechecks source
identity/state after hashing/copying and immediately before removal, but no
portable filesystem API makes these checks and unlink one indivisible operation
against an uncooperative writer.

Import decisions:

1. Validate a small image signature consistent with its extension. This is a
   lightweight format check, not full pixel decoding or repair of corrupt data.
2. Try the original destination name. Absent names require no hashing.
3. For an occupied candidate, compare sizes first. Different sizes need no hash.
   Equal sizes use streamed SHA-256; the incoming digest is reused for additional
   occupied candidates. Matching bytes are an exact duplicate. Existing
   directories/symlinks are never followed or overwritten.
4. Different bytes use `name_1.JPG`, `name_2.JPG`, and so on. Occupied numbered
   candidates are also checked for exact duplicates, allowing safe retries of
   an earlier completed import whose incoming deletion did not finish.
5. Copy unmodified bytes into `.photo-import-<uuid>.importing` in the destination.
   This extension is not a viewer photo type. All EXIF information is preserved.
   Restore source mtime, pre-read atime, and ordinary permission bits, then fsync.
6. Atomically publish with an exclusive hard link. Normal `rename()` on Linux
   can replace an existing destination, so it is deliberately not used. A race
   returning EEXIST triggers comparison or another numbered name, without ever
   overwriting. Sync the destination directory before removing the source.
7. Remove the temporary link and only then remove the unchanged incoming file.
   Confirmed duplicates are removed from incoming only after comparison and a
   final source check. Copy/publication/hash failures retain incoming and clean
   the utility's temporary files where filesystem permissions allow.

Example logs:

```text
Imported:
  IMG_1234.JPG
  -> /mnt/disk2/CODEX/Photos/IMG_1234.JPG

Renamed and imported:
  DSC_1000.JPG
  -> /mnt/disk2/CODEX/Photos/DSC_1000_1.JPG

Duplicate skipped:
  DSC_1000.JPG
  identical to /mnt/disk2/CODEX/Photos/DSC_1000.JPG

Ignored unsupported file:
  document.txt
  Unsupported extension

Import failed:
  IMG_9999.JPG
  reason: Invalid or mismatched image signature for IMG_9999.JPG.
```

The implementation lives in `scripts/photo-import-watcher.ts` and
`src/lib/photoImport/` (stream helpers, hashing, filename publication, stability,
validation, importing, bounded queue, watcher lifecycle, and types). `npm run
test` includes real temporary-directory imports and live Chokidar tests,
16 MiB streaming-hash checks, identical/different-content races, timestamp and
EXIF preservation, copy failure cleanup, and source-change protection. Live
photo directories are not used by these tests.

Linux/filesystem limitations:

- Creation time/birthtime generally cannot be restored by Node.js on Linux.
  The destination's creation time is new; EXIF and mtime remain original, matching
  the viewer's date preference. Ownership, ACLs, and extended attributes are not
  copied, and special setuid/setgid/sticky permission bits are not propagated.
- Publication requires hard-link and directory-fsync support in the destination
  filesystem. Unsupported operations fail safely and retain the incoming file;
  no weaker overwrite-prone fallback is used. The incoming directory may be on
  a different filesystem because image bytes are copied first.
- Abrupt termination/power loss can leave `.importing` files, which the viewer
  ignores. Inspect these manually before cleanup; automatic deletion could
  interfere with another running importer. Successfully published photos are
  complete; a source left after a crash is rechecked on restart.
- There is no persistent hash index for identical images under unrelated names,
  systemd service, import history database, automatic UI refresh, or thumbnail
  pipeline. After imports, refresh the viewer after its five-second catalog
  cache expires. Very long filenames may not allow an added collision suffix.
