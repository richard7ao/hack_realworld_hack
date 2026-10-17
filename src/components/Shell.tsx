import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { WRAP } from "./ui";

/** App chrome: the nav, the area links, and an optional progress hairline under it. */
export function Shell({ children, progress, running = false, crumb }: { children: ReactNode; progress?: number; running?: boolean; crumb?: ReactNode }) {
  return (
    <div className="field min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-surface/85 backdrop-blur-md">
        <div className={`${WRAP} flex h-[62px] items-center gap-6`}>
          <Logo />
          <nav className="hidden items-center gap-1 text-[14px] font-medium text-muted md:flex">
            <Link href="/benchmarks/bench-v1.5-rc1" className="rounded-full px-3 py-1.5 hover:text-ink">CI Bench</Link>
            <Link href="/gate?baseline=bench-v1.4&candidate=bench-v1.5-rc1" className="rounded-full px-3 py-1.5 hover:text-ink">Release Gate</Link>
          </nav>
          <div className="ml-auto min-w-0 truncate text-[13px] text-muted">{crumb}</div>
          <Link href="/" className="pill pill-dark shrink-0">New benchmark</Link>
        </div>
        {progress !== undefined && (
          <div className="relative h-[2px] w-full overflow-hidden bg-line-soft">
            <span className="absolute inset-y-0 left-0 bg-brand transition-[width] duration-200 ease-linear" style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
            {running && <span aria-hidden className="a-sweep absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-brand/45 to-transparent" />}
          </div>
        )}
      </header>
      <main className={`${WRAP} pb-16 pt-6`}>{children}</main>
    </div>
  );
}
