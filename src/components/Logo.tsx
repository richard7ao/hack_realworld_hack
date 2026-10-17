import Link from "next/link";

/** The forkbench mark and wordmark, linking home. */
export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 text-[22px] font-medium tracking-[-0.04em] text-ink">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-full text-base font-medium tracking-normal text-white"
        style={{ background: "conic-gradient(#B6F000, #2BA84A, #6D3FD9, #B6F000)" }}
      >
        f
      </span>
      forkbench
    </Link>
  );
}
