import Link from "next/link";

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link aria-label="VidRelay home" className="brand" href={href}>
      <span aria-hidden="true" className="brand-mark">
        V
      </span>
      <span>VidRelay</span>
    </Link>
  );
}
