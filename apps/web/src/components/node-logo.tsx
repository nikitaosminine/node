type NodeLogoProps = {
  className?: string;
};

export function NodeLogo({ className = "h-8 w-8" }: NodeLogoProps) {
  return (
    <span
      className={`relative inline-grid aspect-square shrink-0 place-items-center overflow-hidden ${className}`}
      aria-hidden
    >
      <img
        src="/brand/node_logo_black.svg"
        alt=""
        className="max-h-[88%] max-w-[88%] object-contain dark:hidden"
      />
      <img
        src="/brand/node_logo_white.svg"
        alt=""
        className="hidden max-h-[88%] max-w-[88%] object-contain dark:block"
      />
    </span>
  );
}

// The hexagon mark only (no wordmark). `inverse` flips the theme pairing so the mark reads
// on a --foreground-colored chip (white in light mode, black in dark).
export function NodeIcon({
  className = "h-4 w-4",
  inverse = false,
}: {
  className?: string;
  inverse?: boolean;
}) {
  const light = inverse ? "/brand/node-logo-icon-white.svg" : "/brand/node-logo-icon-black.svg";
  const dark = inverse ? "/brand/node-logo-icon-black.svg" : "/brand/node-logo-icon-white.svg";
  return (
    <span
      className={`relative inline-grid aspect-square shrink-0 place-items-center ${className}`}
      aria-hidden
    >
      <img src={light} alt="" className="max-h-full max-w-full object-contain dark:hidden" />
      <img src={dark} alt="" className="hidden max-h-full max-w-full object-contain dark:block" />
    </span>
  );
}
