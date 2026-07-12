/** State for the custom HTML context-menu system. */
import { create } from "zustand";

export type MenuItem =
  | { type: "separator" }
  | {
      type: "item";
      label: string;
      /** Image URL (icon:// token url) rendered at 16px. */
      icon?: string;
      /** CSS color for a leading tag dot. */
      dotColor?: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      /** Static submenu, or lazy loader (spinner while pending). */
      submenu?: MenuItem[] | (() => Promise<MenuItem[]>);
      action?: () => void;
    };

interface MenuState {
  open: { x: number; y: number; items: MenuItem[] } | null;
  show(x: number, y: number, items: MenuItem[]): void;
  close(): void;
}

export const useMenu = create<MenuState>()((set) => ({
  open: null,
  show: (x, y, items) => {
    lastAnchor = { x, y };
    set({ open: { x, y, items } });
  },
  close: () => set({ open: null }),
}));

/** Where the menu was last shown. Survives close — item actions run after
 *  the menu closes, and some (native share picker) anchor to this point. */
let lastAnchor = { x: 0, y: 0 };
export function lastMenuAnchor(): { x: number; y: number } {
  return lastAnchor;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  useMenu.getState().show(x, y, items);
}
