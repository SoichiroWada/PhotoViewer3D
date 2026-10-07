"use client";

import { useEffect, useRef, useState } from "react";
import type { Photo } from "@/types/photo";
import { imagePreloader } from "@/lib/imagePreloader";
import { photoTier, photoVariantUrl, preloadTier, type PhotoSize } from "@/lib/photoResolution";

export default function AdaptivePhotoImage({ photo, relativeZ }: { photo: Photo; relativeZ: number }) {
  const [displayed, setDisplayed] = useState(() => {
    const tier = photoTier(relativeZ);
    return { tier: tier as PhotoSize, url: photoVariantUrl(photo, tier) };
  });
  const [failed, setFailed] = useState(false);
  const failedUrls = useRef(new Set<string>());
  const failedPreloads = useRef(new Set<string>());
  const prefetched = useRef<HTMLImageElement | null>(null);
  const desired = photoTier(relativeZ, displayed.tier === "original" ? "small" : displayed.tier);
  const desiredUrl = photoVariantUrl(photo, desired);
  const nextTier = preloadTier(relativeZ, desired);
  const preloadUrl = nextTier ? photoVariantUrl(photo, nextTier) : null;

  useEffect(() => {
    if (displayed.tier === "original" || desired === displayed.tier || failedUrls.current.has(desiredUrl)) return;
    if (desiredUrl === displayed.url || prefetched.current?.getAttribute("src") === desiredUrl) {
      setDisplayed({ tier: desired, url: desiredUrl });
      prefetched.current = null;
      return;
    }
    let cancelled = false;
    const load = imagePreloader.request(desiredUrl, "high");
    void load.promise.then(() => {
      if (!cancelled) setDisplayed({ tier: desired, url: desiredUrl });
    }).catch(() => {
      if (!cancelled) failedUrls.current.add(desiredUrl);
      // Retain the previous image on an unsuccessful upgrade or downgrade.
    });
    return () => { cancelled = true; load.cancel(); };
  }, [desired, desiredUrl, displayed.tier, displayed.url]);

  useEffect(() => {
    prefetched.current = null;
    if (displayed.tier === "original" || !preloadUrl || preloadUrl === displayed.url || failedUrls.current.has(preloadUrl) || failedPreloads.current.has(preloadUrl)) return;
    let cancelled = false;
    const load = imagePreloader.request(preloadUrl, "low");
    void load.promise.then(image => {
      if (!cancelled) prefetched.current = image;
    }).catch(() => {
      // A speculative failure can still be retried once when actually needed.
      if (!cancelled) failedPreloads.current.add(preloadUrl);
    });
    return () => { cancelled = true; load.cancel(); };
  }, [preloadUrl, displayed.tier, displayed.url]);

  if (failed) return <span className="photo-card__failed">Image unavailable</span>;
  return <img src={displayed.url} alt={photo.filename} draggable={false}
    data-resolution={displayed.tier}
    loading={relativeZ < 2100 ? "eager" : "lazy"} decoding="async"
    onError={() => {
      failedUrls.current.add(displayed.url);
      // An initially unavailable variant must not hide a readable original.
      if (displayed.tier !== "small" && displayed.tier !== "original") {
        setDisplayed({ tier: "small", url: photoVariantUrl(photo, "small") });
      } else if (displayed.tier !== "original" && displayed.url !== photo.originalUrl) {
        setDisplayed({ tier: "original", url: photo.originalUrl });
      } else setFailed(true);
    }} />;
}
