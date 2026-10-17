"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Keep the original frontend available without presenting fixtures as evidence. */
export function LegacyNotice({ synthetic }: { synthetic: boolean }) {
  const path = usePathname();
  if (!path.startsWith("/preview") && !path.startsWith("/runs")) return null;
  return <aside aria-label="Data provenance" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 18px", padding: "11px 24px", background: "#edf3e6", color: "#263e20", borderBottom: "1px solid #b9c9ad", fontSize: 12, lineHeight: 1.5 }}>
    <strong>{synthetic ? "Synthetic frontend preview" : "Legacy frontend"}</strong>
    <span>{synthetic ? "These fixtures and animations are separate from actual policy execution." : "Use the Lab for camera capture, native physics and independently evaluated policy runs."}</span>
    <Link href="/lab" style={{ marginLeft: "auto", fontWeight: 650, textDecoration: "underline", textUnderlineOffset: 3 }}>Open FAULTLINE workspace →</Link>
  </aside>;
}
