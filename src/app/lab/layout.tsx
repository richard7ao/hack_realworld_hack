import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAULTLINE Pick · Live Lab",
  description: "Capture physical disturbances, reproduce them in a virtual workcell, and compare independently evaluated policy executions.",
};

export default function LabLayout({ children }: { children: React.ReactNode }) {
  return children;
}
