import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { SessionProvider } from "@/providers/SessionProvider";

import "./globals.css";

export const metadata: Metadata = {
  description:
    "Publish one verified video to your connected social channels with destination-by-destination control.",
  title: {
    default: "VidRelay",
    template: "%s · VidRelay"
  }
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { color: "#07111f", media: "(prefers-color-scheme: dark)" },
    { color: "#f7f9fc", media: "(prefers-color-scheme: light)" }
  ]
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
