import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { LegacyNotice } from "@/components/LegacyNotice";
import "./globals.css";

/*
 * Inter, with the weights the type scale actually uses. Self hosted by next/font, so there is no
 * render-blocking request to Google and no flash of fallback text mid-demo.
 */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "FAULTLINE Pick",
  description: "Capture failures, reproduce robot-policy tests, and gate releases with independently verified execution.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body style={{ fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif" }}><LegacyNotice synthetic={(process.env.DATA_MODE ?? "fixture") !== "live"} />{children}</body>
    </html>
  );
}
