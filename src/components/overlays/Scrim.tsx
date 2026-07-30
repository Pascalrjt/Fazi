import clsx from "clsx";

/**
 * Shared modal backdrop: fixed full-screen fade-in scrim on the overlay
 * layer (z-[85]) that closes when the press lands on the backdrop itself —
 * never on the panel inside. Each overlay passes its own top padding via
 * `className` (e.g. "pt-[12vh]").
 */
export function Scrim({
  className,
  onClose,
  onKeyDown,
  children,
}: {
  className?: string;
  onClose: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        "anim-fade fixed inset-0 z-[85] flex items-start justify-center bg-black/30",
        className,
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
