import Link from "next/link";

/** The FAULTLINE mark: an arm reaching for a target, set in a dark rounded tile. */
export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.03em] text-ink">
      <span aria-hidden className="grid size-8 place-items-center rounded-[9px] bg-ink">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M5 19 L10 8 L15 15" stroke="#B9F3DC" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="18" cy="17" r="2.6" fill="#1C64F2" />
        </svg>
      </span>
      faultline
    </Link>
  );
}
