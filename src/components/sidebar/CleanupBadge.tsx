/** Count of items in a rule folder that go to the Trash by tomorrow. */
import clsx from "clsx";
import { Hourglass } from "lucide-react";
import { useCleanup } from "../../stores/cleanup";
import { leavingSoon } from "../../lib/cleanup";

export function CleanupBadge({
  folder,
  variant = "inline",
}: {
  folder: string;
  /** "bubble" pins a red count to a tile's corner. */
  variant?: "inline" | "bubble";
}) {
  const count = useCleanup((s) => {
    if (!s.folders.has(folder)) return 0;
    let n = 0;
    for (const item of s.items.values()) {
      if (item.folder === folder && leavingSoon(item, s.now)) n++;
    }
    return n;
  });
  if (count === 0) return null;
  const title = `${count} ${count === 1 ? "item goes" : "items go"} to the Trash by tomorrow`;
  if (variant === "bubble") {
    return (
      <span
        className="tnum absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-danger px-1 text-[9.5px] font-bold text-white"
        title={title}
      >
        {count}
      </span>
    );
  }
  return (
    <span
      className={clsx("tnum flex shrink-0 items-center gap-0.5 text-[11px] text-danger")}
      title={title}
    >
      <Hourglass size={11} strokeWidth={1.75} aria-hidden />
      {count}
    </span>
  );
}
