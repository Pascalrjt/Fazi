/**
 * Custom HTML context-menu system: positioning, submenu flyouts, separators,
 * icons, shortcut hints, keyboard navigation, click-away + Esc.
 * One instance mounted in App; opened via the menu store.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useMenu, type MenuItem } from "../../stores/menu";
import { shortcutLabel } from "../../lib/keyboard";
import { useSettings } from "../../stores/settings";
import { captureBrowseFocus, restoreBrowseFocus } from "../../lib/keyboardFocus";

const MENU_WIDTH = 232;
const ITEM_H = 26;

interface MenuListProps {
  items: MenuItem[];
  x: number;
  y: number;
  depth: number;
  onClose: () => void;
  onBack?: () => void;
}

function estimateHeight(items: MenuItem[]): number {
  return items.reduce((h, it) => h + (it.type === "separator" ? 9 : ITEM_H), 10);
}

function firstSelectable(items: MenuItem[]): number {
  return items.findIndex((item) => item.type === "item" && !item.disabled);
}

function MenuList({ items, x, y, depth, onClose, onBack }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId().replace(/:/g, "");
  const [active, setActive] = useState(() => firstSelectable(items));
  const pendingG = useRef(false);
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

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (active < 0 || items[active]?.type !== "item" || items[active].disabled) {
      setActive(firstSelectable(items));
    }
  }, [active, items]);

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

  const selectable = useCallback(
    (i: number) => items[i]?.type === "item" && !items[i].disabled,
    [items],
  );

  const moveActive = useCallback(
    (dir: 1 | -1) => {
      let i = active;
      for (let step = 0; step < items.length; step++) {
        i = (i + dir + items.length) % items.length;
        if (selectable(i)) {
          setActive(i);
          return;
        }
      }
    },
    [active, items.length, selectable],
  );

  const activate = useCallback(() => {
    const item = items[active];
    if (!item || item.type !== "item" || item.disabled) return;
    if (item.submenu) openSubmenu(active);
    else {
      onClose();
      item.action?.();
    }
  }, [active, items, onClose, openSubmenu]);

  const closeSubmenu = useCallback(() => {
    ref.current?.focus({ preventScroll: true });
    setSubmenu(null);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const vimKey =
      useSettings.getState().vimMode && !e.metaKey && !e.ctrlKey && !e.altKey;

    if (pendingG.current && !vimKey) pendingG.current = false;
    if (vimKey && pendingG.current) {
      pendingG.current = false;
      e.preventDefault();
      if (e.key === "g") setActive(firstSelectable(items));
      return;
    }
    if (vimKey && e.key === "g") {
      pendingG.current = true;
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        onClose();
        break;
      case "ArrowDown":
      case "ArrowUp":
      case "j":
      case "k": {
        if ((e.key === "j" || e.key === "k") && !vimKey) break;
        e.preventDefault();
        moveActive(e.key === "ArrowDown" || e.key === "j" ? 1 : -1);
        break;
      }
      case "Home":
        e.preventDefault();
        setActive(firstSelectable(items));
        break;
      case "End":
      case "G": {
        if (e.key === "G" && !vimKey) break;
        e.preventDefault();
        for (let i = items.length - 1; i >= 0; i--) {
          if (selectable(i)) {
            setActive(i);
            break;
          }
        }
        break;
      }
      case "ArrowLeft":
      case "h":
        if (e.key === "h" && !vimKey) break;
        e.preventDefault();
        onBack?.();
        break;
      case "ArrowRight":
        e.preventDefault();
        if (active >= 0) openSubmenu(active);
        break;
      case "l":
        if (!vimKey) break;
        e.preventDefault();
        activate();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        activate();
        break;
    }
  };

  return (
    <>
      <div
        ref={ref}
        className="anim-pop fixed z-[100] rounded-lg border border-edge bg-raised py-[5px]"
        style={{ left: pos.x, top: pos.y, width: MENU_WIDTH, boxShadow: "var(--shadow-overlay)" }}
        role="menu"
        tabIndex={-1}
        aria-activedescendant={active >= 0 ? `${menuId}-item-${active}` : undefined}
        onKeyDown={onKeyDown}
      >
        {items.map((item, i) => {
          if (item.type === "separator") {
            return <div key={i} className="mx-2 my-1 h-px bg-edge" />;
          }
          const isActive = i === active || submenu?.index === i;
          return (
            <div
              key={i}
              id={`${menuId}-item-${i}`}
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
                pendingG.current = false;
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
          onBack={closeSubmenu}
        />
      )}
    </>
  );
}

export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  const close = useMenu((s) => s.close);
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open) {
      if (returnFocus.current == null) returnFocus.current = captureBrowseFocus();
      return;
    }
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target) restoreBrowseFocus(target);
  }, [open]);

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
