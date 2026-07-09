/**
 * IPC contract between the React frontend and the Rust backend.
 *
 * This file is the single source of truth for the wire format. The Rust
 * structs in src-tauri/src/core/entry.rs (and friends) serialize with
 * `#[serde(rename_all = "camelCase")]` / `#[serde(tag = "event", rename_all = "camelCase")]`
 * to match these shapes exactly. Keep the two in lockstep by hand.
 */

// ---------------------------------------------------------------------------
// Entries & listings
// ---------------------------------------------------------------------------

export type EntryKind = "file" | "dir" | "symlink" | "unknown";

export type ICloudState = "none" | "placeholder" | "local";

export interface FinderTag {
  name: string;
  /** Finder label color 0–7: 0 none, 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange */
  color: number;
}

/**
 * One row in a directory listing.
 * Pass 1 (readdir) fills: id, name, path, kind (d_type hint), hidden, icon, ext.
 * Pass 2 (hydration) fills the rest and flips `hydrated`.
 */
export interface Entry {
  /** Sequence id unique within one listing session. */
  id: number;
  name: string;
  path: string;
  kind: EntryKind;
  hidden: boolean;
  /** Opaque token for icon:// and thumb:// — never a path. */
  icon: string;
  /** Lower-cased extension without the dot; "" if none. */
  ext: string;

  hydrated: boolean;
  /** Bytes; null until hydrated, and null for dirs (folder sizes are a separate lazy call). */
  size: number | null;
  /** Modified time, epoch ms. */
  mtime: number | null;
  /** Created (birth) time, epoch ms. */
  btime: number | null;
  isPackage: boolean;
  isAlias: boolean;
  /** Resolved symlink target path, if kind === "symlink". */
  linkTarget: string | null;
  tags: FinderTag[];
  icloud: ICloudState;
  /** True if the current user lacks read permission (renders lock badge). */
  noAccess: boolean;
}

/** Streamed over the Channel passed to `list_dir`. */
export type ListEvent =
  | { event: "chunk"; entries: Entry[] }
  | { event: "listed"; total: number }
  | { event: "hydrate"; entries: Entry[] }
  | { event: "done" }
  | { event: "error"; code: ListErrorCode; message: string };

export type ListErrorCode =
  | "notFound"
  | "notADirectory"
  | "permissionDenied"
  | "cancelled"
  | "io";

export interface ListDirArgs {
  path: string;
  /** Frontend-generated UUID; also used to cancel and to scope icon tokens. */
  listingId: string;
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

/** Debounced batch streamed over the Channel passed to `watch_dir`. */
export type WatchEvent =
  | {
      event: "batch";
      /** Names created/modified in the watched dir (re-stat these). */
      upserted: string[];
      /** Names removed from the watched dir. */
      removed: string[];
      /** True when the batch overflowed and the frontend should re-list. */
      rescan: boolean;
    }
  | { event: "rootGone" };

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export type OpKind = "copy" | "move" | "trash" | "restoreTrash" | "delete" | "rename" | "newFolder" | "duplicate" | "compress" | "extract";

export type ConflictPolicy = "ask" | "keepBoth" | "replace" | "skip";

export interface RunOpArgs {
  opId: string; // frontend-generated UUID
  kind: "copy" | "move";
  sources: string[];
  destDir: string;
  /** Initial policy; "ask" surfaces conflicts over the channel. */
  policy: ConflictPolicy;
}

export interface ConflictSide {
  path: string;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
  icon: string;
}

export type ConflictKind = "fileFile" | "dirDir" | "fileDir" | "dirFile";

export interface OpError {
  path: string;
  message: string;
}

/**
 * Non-fatal warning attached to a successful item. "critical" warnings are
 * never auto-dismissed (reserved for degraded crash-safety states).
 */
export interface OpWarning {
  path: string;
  message: string;
  severity: "warning" | "critical";
}

export type OpStatus = "success" | "partial" | "cancelled" | "failed";

/** Streamed over the Channel passed to `run_op`. */
export type OpEvent =
  | { event: "started"; opId: string }
  /** Background enumeration finished; progress gains a denominator. */
  | { event: "enumerated"; totalBytes: number; totalEntries: number }
  | {
      event: "progress";
      bytesDone: number;
      entriesDone: number;
      currentPath: string;
      /** True while the fast clone path is active (progress is entry-based). */
      cloned: boolean;
    }
  | {
      event: "conflict";
      conflictId: number;
      kind: ConflictKind;
      source: ConflictSide;
      dest: ConflictSide;
      remaining: number;
    }
  | { event: "itemError"; path: string; message: string }
  | { event: "warning"; path: string; message: string; severity: "warning" | "critical" }
  | { event: "skippedIcloud"; paths: string[] }
  | {
      event: "done";
      status: OpStatus;
      errors: OpError[];
      /** Complete, authoritative list — overwrites live-collected warnings. */
      warnings: OpWarning[];
      skippedIcloud: string[];
      /** Destination paths of top-level items that were produced (for selection/ghost rows). */
      produced: string[];
      undoable: boolean;
    };

/** For dirDir conflicts, "merge" is offered (and is the highlighted default). */
export type ConflictResponse = "keepBoth" | "replace" | "merge" | "skip" | "cancel";

export interface RespondConflictArgs {
  opId: string;
  conflictId: number;
  response: ConflictResponse;
  applyToAll: boolean;
}

export interface UndoDescription {
  /** Human description, e.g. "Move of 3 items". */
  label: string;
  kind: OpKind;
}

export interface UndoResult {
  label: string;
  /** Paths the undo produced/restored (for revealing). */
  restored: string[];
}

export interface InterruptedOp {
  opId: string;
  kind: string;
  destDir: string;
  completed: number;
  total: number;
  startedAtMs: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchArgs {
  searchId: string;
  query: string;
  /** Absolute path scope, or null for whole Mac. */
  scope: string | null;
  /** Also match file contents (kMDItemTextContent). */
  contents: boolean;
}

export type SearchEvent =
  | { event: "hit"; path: string; name: string; isDir: boolean; icon: string }
  | { event: "done"; total: number }
  | { event: "error"; message: string };

// ---------------------------------------------------------------------------
// Volumes & sidebar
// ---------------------------------------------------------------------------

export interface Volume {
  name: string;
  path: string;
  isRemovable: boolean;
  isEjectable: boolean;
  isRoot: boolean;
  totalBytes: number | null;
  availableBytes: number | null;
}

export interface DefaultFolders {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
  pictures: string;
  music: string;
  movies: string;
  applications: string;
  icloudDrive: string | null;
  trash: string;
}

// ---------------------------------------------------------------------------
// Misc commands
// ---------------------------------------------------------------------------

export interface AppCandidate {
  name: string;
  path: string;
  icon: string;
  isDefault: boolean;
}

export interface PasteboardContents {
  paths: string[];
  /** True if this was a Fazi cut (move-on-paste). */
  isCut: boolean;
}

export interface GetInfoResult {
  entry: Entry;
  permissionsOctal: string;
  owner: string;
  group: string;
  whereFrom: string[] | null;
  /** For dirs: computed lazily via dir_size, not here. */
  sizeOnDisk: number | null;
  itemCount: number | null;
}

export interface DirSizeEvent {
  bytes: number;
  entries: number;
  done: boolean;
}

/** Text preview payload from read_text_head. */
export interface TextPreview {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Command names (invoke keys) — keep in lockstep with lib.rs generate_handler!
// ---------------------------------------------------------------------------

export const COMMANDS = {
  // listing
  listDir: "list_dir",
  cancelListing: "cancel_listing",
  statPath: "stat_path", // (path, listingId) -> Entry | null
  // watching
  watchDir: "watch_dir", // (path, watchId, channel)
  unwatch: "unwatch",
  // ops
  runOp: "run_op",
  cancelOp: "cancel_op",
  respondConflict: "respond_conflict",
  trashPaths: "trash_paths", // (paths) -> void (undoable)
  deletePermanent: "delete_permanent", // (paths) -> void
  renamePath: "rename_path", // (path, newName) -> newPath
  newFolder: "new_folder", // (parent, name) -> path
  duplicatePaths: "duplicate_paths", // (paths, channel opEvent) — keep-both copy in place
  compressPaths: "compress_paths", // (opId, sources, destDir, channel opEvent) — ditto zip
  extractPaths: "extract_paths", // (opId, sources, destDir, channel opEvent) — ditto/tar
  undoLast: "undo_last", // () -> UndoResult | null
  redoLast: "redo_last",
  undoStackTop: "undo_stack_top", // () -> UndoDescription | null (for menu label)
  redoStackTop: "redo_stack_top",
  interruptedOps: "interrupted_ops", // () -> InterruptedOp[] (journal recovery report)
  // search
  search: "search",
  cancelSearch: "cancel_search",
  // macOS integration
  openPaths: "open_paths",
  openWith: "open_with", // (paths, appPath)
  openWithApps: "open_with_apps", // (path) -> AppCandidate[]
  revealInFinder: "reveal_in_finder",
  getTags: "get_tags",
  setTags: "set_tags",
  getInfo: "get_info",
  dirSize: "dir_size", // (path, channel DirSizeEvent)
  listVolumes: "list_volumes",
  eject: "eject", // (path)
  defaultFolders: "default_folders",
  checkFullDiskAccess: "check_full_disk_access",
  openFullDiskAccessSettings: "open_full_disk_access_settings",
  pbWriteFiles: "pb_write_files", // (paths, isCut)
  pbReadFiles: "pb_read_files", // () -> PasteboardContents | null
  pbWriteText: "pb_write_text",
  quicklookPanel: "quicklook_panel", // (paths) — qlmanage -p escape hatch
  readTextHead: "read_text_head", // (path, maxBytes) -> TextPreview
  registerPreview: "register_preview", // (path) -> token for preview://
  revokePreview: "revoke_preview", // (token)
  downloadIcloud: "download_icloud", // (paths)
} as const;

/** Global broadcast events (tauri emit). */
export const EVENTS = {
  volumesChanged: "fazi://volumes-changed",
  menuCommand: "fazi://menu", // payload: command id string
} as const;

// ---------------------------------------------------------------------------
// Protocol URL helpers
// ---------------------------------------------------------------------------

// On macOS WKWebView, Tauri custom protocols use the `scheme://localhost/…`
// origin form (the `http://scheme.localhost/…` form is Windows/Android).
// Fazi is macOS-only, so the scheme form is used directly.

/** Icon image URL for an entry's token at a given pixel size. */
export function iconUrl(token: string, size: number): string {
  return `icon://localhost/${token}?size=${size}`;
}

/** Thumbnail URL (falls back to icon server-side when generation fails). */
export function thumbUrl(token: string, size: number): string {
  return `thumb://localhost/${token}?size=${size}`;
}

/** Raw file bytes for a registered preview token (supports Range for AV). */
export function previewUrl(token: string): string {
  return `preview://localhost/${token}`;
}
