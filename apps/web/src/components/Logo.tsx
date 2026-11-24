import { cn } from "../lib/format";

const NODES = [
  [47, 16, 5],
  [24, 13, 3.8],
  [15, 32, 5],
  [24, 51, 3.8],
  [47, 48, 5],
] as const;

export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <div className={cn("rail-logo", className)} style={{ width: size, height: size }} aria-hidden="true">
      <svg
        viewBox="0 0 64 64"
        width={Math.round(size * 0.64)}
        height={Math.round(size * 0.64)}
        fill="none"
      >
        <path
          d="M47 16L24 13L15 32L24 51L47 48"
          stroke="currentColor"
          strokeWidth="4.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {NODES.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="currentColor" />
        ))}
      </svg>
    </div>
  );
}
