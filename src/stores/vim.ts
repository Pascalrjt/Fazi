/**
 * Runtime Vim-mode state (normal/visual, pending prefix, count). A store —
 * not a module variable — so the StatusBar indicator can subscribe to it.
 * Whether Vim mode is *enabled* lives in useSettings; this is only the
 * interpreter's live state.
 */
import { create } from "zustand";
import { emptyVimState, type VimState } from "../lib/vim";

interface VimStore {
  state: VimState;
  set(next: VimState): void;
  reset(): void;
}

export const useVim = create<VimStore>()((set) => ({
  state: emptyVimState(),
  set: (next) => set({ state: next }),
  reset: () => set({ state: emptyVimState() }),
}));
