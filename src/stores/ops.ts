/**
 * In-flight file operations: progress cards, conflict queue, undo/redo.
 *
 * Cards only appear after an op has been running ~250ms (instant ops never
 * flash UI). Completed cards auto-dismiss after 4s; failures persist.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  ConflictKind,
  ConflictPolicy,
  ConflictResponse,
  ConflictSide,
  OpError,
  OpEvent,
  OpStatus,
  OpWarning,
} from "../types/ipc";
import * as ipc from "../lib/ipc";
import { safeIpc } from "../lib/safeIpc";
import { usePanes } from "./panes";
import { useApp } from "./app";
import { basename, pluralize } from "../lib/format";

const CARD_DELAY_MS = 250;
const SUCCESS_DISMISS_MS = 4000;

export type CardStatus = "running" | OpStatus;

export interface OpCard {
  opId: string;
  kind: "copy" | "move" | "duplicate" | "compress" | "extract";
  label: string;
  visible: boolean;
  startedAt: number;
  bytesDone: number;
  entriesDone: number;
  totalBytes: number | null;
  totalEntries: number | null;
  /** Fast clone path active → progress counted in entries. */
  cloned: boolean;
  currentPath: string;
  /** Bytes/sec, exponential moving average. */
  rate: number;
  status: CardStatus;
  errors: OpError[];
  warnings: OpWarning[];
  skippedIcloud: string[];
  produced: string[];
  expanded: boolean;
  // retry material
  sources: string[];
  destDir: string;
  policy: ConflictPolicy;
}

export interface PendingConflict {
  opId: string;
  conflictId: number;
  kind: ConflictKind;
  source: ConflictSide;
  dest: ConflictSide;
  remaining: number;
}

interface StartOpOptions {
  kind: "copy" | "move";
  sources: string[];
  destDir: string;
  policy?: ConflictPolicy;
  /** Custom card verb, e.g. "Moving 14 items to Downloads". */
  label?: string;
  onDone?: (status: OpStatus, produced: string[]) => void;
}

interface OpsState {
  cards: OpCard[];
  conflicts: PendingConflict[];

  startOp(opts: StartOpOptions): string;
  duplicate(paths: string[]): string;
  compress(paths: string[], destDir: string): string;
  extract(paths: string[], destDir: string): string;
  cancel(opId: string): void;
  dismiss(opId: string): void;
  toggleExpanded(opId: string): void;
  retry(opId: string): void;
  downloadAndRetrySkipped(opId: string): void;
  respondConflict(response: ConflictResponse, applyToAll: boolean): void;

  undo(): Promise<void>;
  redo(): Promise<void>;
}

const visibilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
const rateSamples = new Map<string, { at: number; bytes: number }>();

export function opVerb(kind: OpCard["kind"], done = false): string {
  switch (kind) {
    case "copy":
      return done ? "Copied" : "Copying";
    case "move":
      return done ? "Moved" : "Moving";
    case "duplicate":
      return done ? "Duplicated" : "Duplicating";
    case "compress":
      return done ? "Compressed" : "Compressing";
    case "extract":
      return done ? "Extracted" : "Extracting";
  }
}

/** Past-tense failure verb: "N items couldn't be <verb>". */
export function opFailVerb(kind: OpCard["kind"]): string {
  switch (kind) {
    case "copy":
    case "duplicate":
      return "copied";
    case "move":
      return "moved";
    case "compress":
      return "compressed";
    case "extract":
      return "extracted";
  }
}

export const useOps = create<OpsState>()(
  immer((set, get) => {
    function makeCard(
      opId: string,
      kind: OpCard["kind"],
      label: string,
      sources: string[],
      destDir: string,
      policy: ConflictPolicy,
    ): OpCard {
      return {
        opId,
        kind,
        label,
        visible: false,
        startedAt: Date.now(),
        bytesDone: 0,
        entriesDone: 0,
        totalBytes: null,
        totalEntries: null,
        cloned: false,
        currentPath: "",
        rate: 0,
        status: "running",
        errors: [],
        warnings: [],
        skippedIcloud: [],
        produced: [],
        expanded: false,
        sources,
        destDir,
        policy,
      };
    }

    function armVisibility(opId: string): void {
      visibilityTimers.set(
        opId,
        setTimeout(() => {
          visibilityTimers.delete(opId);
          set((s) => {
            const card = s.cards.find((c) => c.opId === opId);
            if (card && card.status === "running") card.visible = true;
          });
        }, CARD_DELAY_MS),
      );
    }

    function finishCard(opId: string, event: Extract<OpEvent, { event: "done" }>): void {
      const timer = visibilityTimers.get(opId);
      if (timer) {
        clearTimeout(timer);
        visibilityTimers.delete(opId);
      }
      rateSamples.delete(opId);
      const destDir = get().cards.find((c) => c.opId === opId)?.destDir;
      set((s) => {
        const card = s.cards.find((c) => c.opId === opId);
        if (!card) return;
        card.status = event.status;
        card.errors = event.errors;
        // Done's list is authoritative and complete — assign, never append
        // (each warning already arrived once as a live "warning" event).
        card.warnings = event.warnings;
        card.skippedIcloud = event.skippedIcloud;
        card.produced = event.produced;
        const wasVisible = card.visible;
        if (
          event.status === "success" &&
          event.skippedIcloud.length === 0 &&
          event.warnings.length === 0
        ) {
          if (!wasVisible) {
            // never earned UI → remove silently
            s.cards = s.cards.filter((c) => c.opId !== opId);
          } else {
            dismissTimers.set(
              opId,
              setTimeout(() => get().dismiss(opId), SUCCESS_DISMISS_MS),
            );
          }
        } else if (event.status === "cancelled") {
          s.cards = s.cards.filter((c) => c.opId !== opId);
        } else {
          // partial/failed (or success with iCloud skips/warnings) persists,
          // visibly and without auto-dismiss
          card.visible = true;
        }
      });
      const onDone = doneCallbacks.get(opId);
      doneCallbacks.delete(opId);
      // optimistic ghost rows in any pane showing the destination
      if (event.produced.length > 0 && destDir) {
        usePanes.getState().addGhosts(destDir, event.produced);
      }
      onDone?.(event.status, event.produced);
    }

    function handleEvent(opId: string, event: OpEvent): void {
      switch (event.event) {
        case "started":
          break;
        case "enumerated":
          set((s) => {
            const card = s.cards.find((c) => c.opId === opId);
            if (card) {
              card.totalBytes = event.totalBytes;
              card.totalEntries = event.totalEntries;
            }
          });
          break;
        case "progress": {
          const now = Date.now();
          const prev = rateSamples.get(opId);
          let rate: number | null = null;
          if (prev && now > prev.at) {
            const instant = ((event.bytesDone - prev.bytes) / (now - prev.at)) * 1000;
            rate = Math.max(0, instant);
          }
          rateSamples.set(opId, { at: now, bytes: event.bytesDone });
          set((s) => {
            const card = s.cards.find((c) => c.opId === opId);
            if (!card) return;
            card.bytesDone = event.bytesDone;
            card.entriesDone = event.entriesDone;
            card.currentPath = event.currentPath;
            card.cloned = event.cloned;
            if (rate != null) {
              card.rate = card.rate === 0 ? rate : card.rate * 0.7 + rate * 0.3;
            }
          });
          break;
        }
        case "conflict":
          set((s) => {
            s.conflicts.push({
              opId,
              conflictId: event.conflictId,
              kind: event.kind,
              source: event.source,
              dest: event.dest,
              remaining: event.remaining,
            });
          });
          break;
        case "itemError":
          set((s) => {
            const card = s.cards.find((c) => c.opId === opId);
            if (card) card.errors.push({ path: event.path, message: event.message });
          });
          break;
        case "warning":
          set((s) => {
            const card = s.cards.find((c) => c.opId === opId);
            if (card)
              card.warnings.push({
                path: event.path,
                message: event.message,
                severity: event.severity,
              });
          });
          break;
        case "skippedIcloud":
          set((s) => {
            const card = s.cards.find((c) => c.opId === opId);
            if (card) card.skippedIcloud.push(...event.paths);
          });
          break;
        case "done":
          finishCard(opId, event);
          break;
        default: {
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    }

    const doneCallbacks = new Map<string, (status: OpStatus, produced: string[]) => void>();

    function failCard(opId: string, message: string): void {
      const timer = visibilityTimers.get(opId);
      if (timer) {
        clearTimeout(timer);
        visibilityTimers.delete(opId);
      }
      set((s) => {
        const card = s.cards.find((c) => c.opId === opId);
        if (!card) return;
        card.status = "failed";
        card.visible = true;
        card.errors.push({ path: "", message });
      });
    }

    return {
      cards: [],
      conflicts: [],

      startOp: ({ kind, sources, destDir, policy = "ask", label, onDone }) => {
        const opId = crypto.randomUUID();
        const cardLabel =
          label ??
          `${opVerb(kind)} ${pluralize(sources.length, "item")} to “${basename(destDir)}”`;
        set((s) => {
          s.cards.push(makeCard(opId, kind, cardLabel, sources, destDir, policy));
        });
        armVisibility(opId);
        if (onDone) doneCallbacks.set(opId, onDone);
        safeIpc(() =>
          ipc.runOp({ opId, kind, sources, destDir, policy }, (e) => handleEvent(opId, e)),
        ).catch((err) => failCard(opId, String(err)));
        return opId;
      },

      duplicate: (paths) => {
        const opId = crypto.randomUUID();
        const destDir = paths.length > 0 ? (paths[0].slice(0, paths[0].lastIndexOf("/")) || "/") : "/";
        const label = `${opVerb("duplicate")} ${pluralize(paths.length, "item")}`;
        set((s) => {
          s.cards.push(makeCard(opId, "duplicate", label, paths, destDir, "keepBoth"));
        });
        armVisibility(opId);
        safeIpc(() => ipc.duplicatePaths(opId, paths, (e) => handleEvent(opId, e))).catch(
          (err) => failCard(opId, String(err)),
        );
        return opId;
      },

      compress: (paths, destDir) => {
        const opId = crypto.randomUUID();
        const label =
          paths.length === 1
            ? `${opVerb("compress")} “${basename(paths[0])}”`
            : `${opVerb("compress")} ${pluralize(paths.length, "item")}`;
        set((s) => {
          s.cards.push(makeCard(opId, "compress", label, paths, destDir, "keepBoth"));
        });
        armVisibility(opId);
        safeIpc(() => ipc.compressPaths(opId, paths, destDir, (e) => handleEvent(opId, e))).catch(
          (err) => failCard(opId, String(err)),
        );
        return opId;
      },

      extract: (paths, destDir) => {
        const opId = crypto.randomUUID();
        const label =
          paths.length === 1
            ? `${opVerb("extract")} “${basename(paths[0])}”`
            : `${opVerb("extract")} ${pluralize(paths.length, "archive")}`;
        set((s) => {
          s.cards.push(makeCard(opId, "extract", label, paths, destDir, "keepBoth"));
        });
        armVisibility(opId);
        safeIpc(() => ipc.extractPaths(opId, paths, destDir, (e) => handleEvent(opId, e))).catch(
          (err) => failCard(opId, String(err)),
        );
        return opId;
      },

      cancel: (opId) => {
        void ipc.cancelOp(opId).catch(() => {});
        set((s) => {
          // conflicts belonging to a cancelled op are moot
          s.conflicts = s.conflicts.filter((c) => c.opId !== opId);
        });
      },

      dismiss: (opId) => {
        const t = dismissTimers.get(opId);
        if (t) clearTimeout(t);
        dismissTimers.delete(opId);
        set((s) => {
          s.cards = s.cards.filter((c) => c.opId !== opId);
        });
      },

      toggleExpanded: (opId) => {
        set((s) => {
          const card = s.cards.find((c) => c.opId === opId);
          if (card) card.expanded = !card.expanded;
        });
      },

      retry: (opId) => {
        const card = get().cards.find((c) => c.opId === opId);
        if (!card) return;
        const failedPaths = card.errors.map((e) => e.path).filter((p) => p !== "");
        const sources = failedPaths.length > 0 ? failedPaths : card.sources;
        get().dismiss(opId);
        switch (card.kind) {
          case "duplicate":
            get().duplicate(sources);
            break;
          case "compress":
            // All-or-nothing: errors may carry paths of children INSIDE a
            // selected folder — retrying those would compress a child alone.
            // Always re-run the full selection.
            get().compress(card.sources, card.destDir);
            break;
          case "extract":
            // Safe: the backend guarantees ItemError.path is the archive path.
            get().extract(sources, card.destDir);
            break;
          case "copy":
          case "move":
            get().startOp({
              kind: card.kind,
              sources,
              destDir: card.destDir,
              policy: card.policy,
            });
            break;
        }
      },

      downloadAndRetrySkipped: (opId) => {
        const card = get().cards.find((c) => c.opId === opId);
        if (!card || card.skippedIcloud.length === 0) return;
        const skipped = [...card.skippedIcloud];
        const { kind, destDir, policy } = card;
        get().dismiss(opId);
        useApp
          .getState()
          .pushToast(`Downloading ${pluralize(skipped.length, "item")} from iCloud…`);
        ipc
          .downloadIcloud(skipped)
          .then(() => {
            switch (kind) {
              case "duplicate":
                get().duplicate(skipped);
                break;
              case "compress":
                // Materializing staging means compress never skips iCloud
                // files, but keep the retry meaningful if that ever changes.
                get().compress(skipped, destDir);
                break;
              case "extract":
                get().extract(skipped, destDir);
                break;
              case "copy":
              case "move":
                get().startOp({ kind, sources: skipped, destDir, policy });
                break;
            }
          })
          .catch((err) => {
            useApp.getState().pushToast(`iCloud download failed: ${err}`, { danger: true });
          });
      },

      respondConflict: (response, applyToAll) => {
        const head = get().conflicts[0];
        if (!head) return;
        set((s) => {
          s.conflicts.shift();
          if (applyToAll) {
            // backend applies the policy to the rest; queued ones for this op are moot
            s.conflicts = s.conflicts.filter((c) => c.opId !== head.opId);
          }
        });
        void ipc
          .respondConflict(head.opId, head.conflictId, response, applyToAll)
          .catch((err) => {
            useApp.getState().pushToast(`Couldn't resolve conflict: ${err}`, { danger: true });
          });
      },

      undo: async () => {
        try {
          const result = await ipc.undoLast();
          if (result) {
            useApp.getState().pushToast(`Undid ${result.label}`);
            if (result.restored.length > 0) {
              usePanes.getState().addGhosts(
                result.restored[0].slice(0, result.restored[0].lastIndexOf("/")) || "/",
                result.restored,
              );
            }
          } else {
            useApp.getState().pushToast("Nothing to undo");
          }
        } catch (err) {
          useApp.getState().pushToast(`Undo failed: ${err}`, { danger: true });
        }
      },

      redo: async () => {
        try {
          const result = await ipc.redoLast();
          if (result) useApp.getState().pushToast(`Redid ${result.label}`);
          else useApp.getState().pushToast("Nothing to redo");
        } catch (err) {
          useApp.getState().pushToast(`Redo failed: ${err}`, { danger: true });
        }
      },
    };
  }),
);
