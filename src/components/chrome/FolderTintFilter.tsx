/** The SVG filter behind `.folder-tint` (see lib/folderTint): it takes the
 *  accent's hue and saturation and the icon's own lightness, clipped to the
 *  icon's shape. Reading `--accent` here means a new accent recolors every
 *  folder at once, with no icon reloads. */
export function FolderTintFilter() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden focusable="false">
      <filter id="folder-tint" colorInterpolationFilters="sRGB">
        <feFlood style={{ floodColor: "var(--accent)" }} result="accent" />
        <feBlend in="accent" in2="SourceGraphic" mode="color" result="tinted" />
        <feComposite in="tinted" in2="SourceGraphic" operator="in" />
      </filter>
    </svg>
  );
}
