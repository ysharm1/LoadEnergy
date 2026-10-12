import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ServiceWorkerRegister } from "./service-worker-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "Load Energy",
  description:
    "Phoenix-first commercial diesel load board connecting job sites with licensed local diesel deliverers.",
  manifest: "/manifest.json",
  applicationName: "Load Energy",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Load Energy",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  /**
   * Zoom stays available on purpose. The UI is sized for gloves and sunlight,
   * but pinch-zoom is the accommodation some users need to read a BOL number,
   * and capping the scale would take it away (WCAG 1.4.4).
   */
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
