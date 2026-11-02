import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  // exifr dynamically loads Node fs; bundling it breaks chunked disk reads.
  serverExternalPackages: ["exifr", "sharp"],
  allowedDevOrigins: ['192.168.1.68'],
};

export default config;
