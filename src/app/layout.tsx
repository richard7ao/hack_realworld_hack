import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Forkbench",
  description: "Drop an environment and a task. Run a hundred simulations. Gate the policy like CI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
