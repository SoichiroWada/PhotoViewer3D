import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "3D Photo Viewer",
  description: "Walk through your memories in a floating, chronological photo corridor.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
