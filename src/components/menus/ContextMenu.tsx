/**
 * Custom HTML context-menu system: positioning, submenu flyouts, separators,
 * icons, shortcut hints, keyboard navigation, click-away + Esc.
 * One instance mounted in App; opened via the menu store.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useMenu, type MenuItem } from "../../stores/menu";
import { shortcutLabel } from "../../lib/keyboard";

const MENU_WIDTH = 232;
const ITEM_H = 26;

interface MenuListProps {
  items: MenuItem[];
  x: number;
  y: number;
  depth: number;
  onClose: () => void;
}

function estimateHeight(items: MenuItem[]): number {
  return items.reduce((h, it) => h + (it.type === "separator" ? 9 : ITEM_H), 10);
}

function MenuList({ items, x, y, depth, onClose }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [submenu, setSubmenu] = useState<{
    index: number;
    items: MenuItem[] | "loading";
    x: number;
    y: number;
  } | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const height = estimateHeight(items);
    const nx = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
    const ny = Math.min(y, window.innerHeight - height - 8);
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [x, y, items]);

  const openSubmenu = useCallback(
    (index: number) => {
      const item = items[index];
      if (item.type !== "item" || !item.submenu) return;
      const anchor = ref.current?.children[index] as HTMLElement | undefined;
      const rect = anchor?.getBoundingClientRect();
      const sx = (rect?.right ?? pos.x + MENU_WIDTH) - 2;
      const sy = rect?.top ?? pos.y;
      if (Array.isArray(item.submenu)) {
        setSubmenu({ index, items: item.submenu, x: sx, y: sy });
      } else {
        setSubmenu({ index, items: "loading", x: sx, y: sy });
        void item.submenu().then((loaded) => {
          setSubmenu((cur) =>
            cur && cur.index === index ? { ...cur, items: loaded } : cur,
          );
        });
      }
    },
    [items, pos],
  );

  // keyboard navigation — only the deepest open menu listens
  useEffect(() => {
    if (submenu) return;
    const selectable = (i: number) => {
      const it = items[i];
      return it.type === "item" && !it.disabled;
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const dir = e.key === "ArrowDown" ? 1 : -1;
          let i = active;
          for (let step = 0; step < items.length; step++) {
            i = (i + dir + items.length) % items.length;
            if (selectable(i)) break;
          }
          setActive(i);
          break;
        }
        case "ArrowRight":
          e.preventDefault();
          if (active >= 0) openSubmenu(active);
          break;
        case "Enter": {
          e.preventDefault();
          const it = items[active];
          if (it && it.type === "item" && !it.disabled) {
            if (it.submenu) openSubmenu(active);
            else {
              onClose();
              it.action?.();
            }
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items, active, submenu, onClose, openSubmenu]);

  return (
    <>
      <div
        ref={ref}
        className="anim-pop fixed z-[100] rounded-lg border border-edge bg-raised py-[5px]"
        style={{ left: pos.x, top: pos.y, width: MENU_WIDTH, boxShadow: "var(--shadow-overlay)" }}
        role="menu"
      >
        {items.map((item, i) => {
          if (item.type === "separator") {
            return <div key={i} className="mx-2 my-1 h-px bg-edge" />;
          }
          const isActive = i === active || submenu?.index === i;
          return (
            <div
              key={i}
              role="menuitem"
              aria-disabled={item.disabled}
              className={clsx(
                "mx-1 flex h-[26px] cursor-default items-center gap-2 rounded-[5px] px-2",
                item.disabled
                  ? "text-tertiary"
                  : isActive
                    ? "bg-accent text-white"
                    : "text-primary",
                item.danger && !isActive && !item.disabled && "text-danger",
              )}
              onMouseEnter={() => {
                if (item.disabled) return;
                setActive(i);
                if (item.submenu) openSubmenu(i);
                else setSubmenu(null);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (item.disabled) return;
                if (item.submenu) {
                  openSubmenu(i);
                  return;
                }
                onClose();
                item.action?.();
              }}
            >
              {item.icon ? (
                <img src={item.icon} alt="" className="h-4 w-4" draggable={false} />
              ) : item.dotColor ? (
                <span className="flex w-4 items-center justify-center">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      background: item.dotColor,
                      boxShadow: item.checked ? "0 0 0 2px var(--accent)" : "none",
                    }}
                  />
                </span>
              ) : item.checked != null ? (
                <span className="w-4 text-center text-[11px]">{item.checked ? "✓" : ""}</span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
              {item.shortcut && (
                <span
                  className={clsx(
                    "text-[11px] tracking-wide",
                    isActive ? "text-white/70" : "text-tertiary",
                  )}
                >
                  {shortcutLabel(item.shortcut)}
                </span>
              )}
              {item.submenu && <span className="text-[10px]">▸</span>}
            </div>
          );
        })}
      </div>
      {submenu && (
        <MenuList
          items={
            submenu.items === "loading"
              ? [{ type: "item", label: "Loading…", disabled: true }]
              : submenu.items
          }
          x={submenu.x}
          y={submenu.y}
          depth={depth + 1}
          onClose={onClose}
        />
      )}
    </>
  );
}

export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  const close = useMenu((s) => s.close);

  useEffect(() => {
    if (!open) return;
    const onDown = () => close();
    const onBlur = () => close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [open, close]);

  if (!open) return null;
  return (
    <div onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <MenuList items={open.items} x={open.x} y={open.y} depth={0} onClose={close} />
    </div>
  );
}
