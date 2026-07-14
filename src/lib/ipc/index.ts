/**
 * Typed IPC wrappers — the ONLY module allowed to import @tauri-apps/api.
 * Everything else calls these functions.
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  COMMANDS,
  EVENTS,
  type AppCandidate,
  type ConflictPolicy,
  type DefaultFolders,
  type DirSizeEvent,
  type EmptyTrashEvent,
  type Entry,
  type FinderTag,
  type FuzzyEvent,
  type FuzzyIndexStatus,
  type FuzzyQueryArgs,
  type GetInfoResult,
  type HydrateItem,
  type InterruptedOp,
  type ListEvent,
  type OpEvent,
  type PasteboardContents,
  type ConflictResponse,
  type SearchArgs,
  type SearchEvent,
  type ShareServices,
  type TextPreview,
  type TrashStats,
  type UndoDescription,
  type UndoResult,
  type Volume,
  type WatchEvent,
} from "../../types/ipc";

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export function listDir(
  path: string,
  listingId: string,
  onEvent: (e: ListEvent) => void,
): Promise<void> {
  const channel = new Channel<ListEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.listDir, { path, listingId, channel });
}

export function cancelListing(listingId: string): Promise<void> {
  return invoke(COMMANDS.cancelListing, { listingId });
}

export function statPath(path: string, listingId: string): Promise<Entry | null> {
  return invoke(COMMANDS.statPath, { path, listingId });
}

export function statPaths(owner: string, paths: string[]): Promise<(Entry | null)[]> {
  return invoke(COMMANDS.statPaths, { owner, paths });
}

export function hydratePaths(
  listingId: string,
  items: HydrateItem[],
): Promise<(Entry | null)[]> {
  return invoke(COMMANDS.hydratePaths, { listingId, items });
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

export function watchDir(
  path: string,
  watchId: string,
  onEvent: (e: WatchEvent) => void,
): Promise<void> {
  const channel = new Channel<WatchEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.watchDir, { path, watchId, channel });
}

export function unwatch(watchId: string): Promise<void> {
  return invoke(COMMANDS.unwatch, { watchId });
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export function runOp(
  args: {
    opId: string;
    kind: "copy" | "move";
    sources: string[];
    destDir: string;
    policy: ConflictPolicy;
    verify?: boolean;
  },
  onEvent: (e: OpEvent) => void,
): Promise<void> {
  const channel = new Channel<OpEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.runOp, { ...args, channel });
}

export function cancelOp(opId: string): Promise<void> {
  return invoke(COMMANDS.cancelOp, { opId });
}

export function respondConflict(
  opId: string,
  conflictId: number,
  response: ConflictResponse,
  applyToAll: boolean,
): Promise<void> {
  return invoke(COMMANDS.respondConflict, { opId, conflictId, response, applyToAll });
}

export function trashPaths(paths: string[]): Promise<void> {
  return invoke(COMMANDS.trashPaths, { paths });
}

export function trashStats(): Promise<TrashStats> {
  return invoke(COMMANDS.trashStats);
}

export function emptyTrash(onEvent: (e: EmptyTrashEvent) => void): Promise<void> {
  const channel = new Channel<EmptyTrashEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.emptyTrash, { channel });
}

export function deletePermanent(paths: string[]): Promise<void> {
  return invoke(COMMANDS.deletePermanent, { paths });
}

export function renamePath(path: string, newName: string): Promise<string> {
  return invoke(COMMANDS.renamePath, { path, newName });
}

export function batchRename(
  renames: Array<{ from: string; toName: string }>,
): Promise<string[]> {
  return invoke(COMMANDS.batchRename, { renames });
}

export function newFolder(parent: string, name: string): Promise<string> {
  return invoke(COMMANDS.newFolder, { parent, name });
}

export function duplicatePaths(
  opId: string,
  paths: string[],
  onEvent: (e: OpEvent) => void,
): Promise<void> {
  const channel = new Channel<OpEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.duplicatePaths, { opId, paths, channel });
}

export function compressPaths(
  opId: string,
  sources: string[],
  destDir: string,
  onEvent: (e: OpEvent) => void,
): Promise<void> {
  const channel = new Channel<OpEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.compressPaths, { opId, sources, destDir, channel });
}

export function extractPaths(
  opId: string,
  sources: string[],
  destDir: string,
  onEvent: (e: OpEvent) => void,
): Promise<void> {
  const channel = new Channel<OpEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.extractPaths, { opId, sources, destDir, channel });
}

export function undoLast(): Promise<UndoResult | null> {
  return invoke(COMMANDS.undoLast);
}

export function redoLast(): Promise<UndoResult | null> {
  return invoke(COMMANDS.redoLast);
}

export function undoStackTop(): Promise<UndoDescription | null> {
  return invoke(COMMANDS.undoStackTop);
}

export function redoStackTop(): Promise<UndoDescription | null> {
  return invoke(COMMANDS.redoStackTop);
}

export function setShortcutRecording(recording: boolean): Promise<void> {
  return invoke(COMMANDS.setShortcutRecording, { recording });
}

export function setNativeMenuShortcuts(
  shortcuts: Record<string, string | null>,
): Promise<void> {
  return invoke(COMMANDS.setNativeMenuShortcuts, { shortcuts });
}

export function interruptedOps(): Promise<InterruptedOp[]> {
  return invoke(COMMANDS.interruptedOps);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function search(args: SearchArgs, onEvent: (e: SearchEvent) => void): Promise<void> {
  const channel = new Channel<SearchEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.search, { ...args, channel });
}

export function cancelSearch(searchId: string): Promise<void> {
  return invoke(COMMANDS.cancelSearch, { searchId });
}

// ---------------------------------------------------------------------------
// Fuzzy finder
// ---------------------------------------------------------------------------

export function fuzzyWarm(
  root: string,
  excludes: string[],
  maxEntries?: number,
  force?: boolean,
): Promise<FuzzyIndexStatus> {
  return invoke(COMMANDS.fuzzyWarm, { root, excludes, maxEntries, force });
}

export function fuzzyQuery(
  args: FuzzyQueryArgs,
  onEvent: (e: FuzzyEvent) => void,
): Promise<void> {
  const channel = new Channel<FuzzyEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.fuzzyQuery, { ...args, channel });
}

export function fuzzyCancel(queryId: string): Promise<void> {
  return invoke(COMMANDS.fuzzyCancel, { queryId });
}

export function fuzzyDrop(root: string): Promise<void> {
  return invoke(COMMANDS.fuzzyDrop, { root });
}

// ---------------------------------------------------------------------------
// macOS integration
// ---------------------------------------------------------------------------

export function openPaths(paths: string[]): Promise<void> {
  return invoke(COMMANDS.openPaths, { paths });
}

export function openWith(paths: string[], appPath: string): Promise<void> {
  return invoke(COMMANDS.openWith, { paths, appPath });
}

export function openWithApps(path: string): Promise<AppCandidate[]> {
  return invoke(COMMANDS.openWithApps, { path });
}

export function setDefaultApp(path: string, appPath: string): Promise<void> {
  return invoke(COMMANDS.setDefaultApp, { path, appPath });
}

export function dragModifiers(): Promise<{ alt: boolean }> {
  return invoke(COMMANDS.dragModifiers);
}

export function shareServices(paths: string[]): Promise<ShareServices> {
  return invoke(COMMANDS.shareServices, { paths });
}

export function sharePerform(
  generation: number,
  index: number,
  paths: string[],
): Promise<void> {
  return invoke(COMMANDS.sharePerform, { generation, index, paths });
}

export function sharePicker(paths: string[], x: number, y: number): Promise<void> {
  return invoke(COMMANDS.sharePicker, { paths, x, y });
}

export function revealInFinder(paths: string[]): Promise<void> {
  return invoke(COMMANDS.revealInFinder, { paths });
}

export function getTags(path: string): Promise<FinderTag[]> {
  return invoke(COMMANDS.getTags, { path });
}

export function setTags(path: string, tags: FinderTag[]): Promise<void> {
  return invoke(COMMANDS.setTags, { path, tags });
}

export function getInfo(path: string): Promise<GetInfoResult> {
  return invoke(COMMANDS.getInfo, { path });
}

export function dirSize(path: string, onEvent: (e: DirSizeEvent) => void): Promise<void> {
  const channel = new Channel<DirSizeEvent>();
  channel.onmessage = onEvent;
  return invoke(COMMANDS.dirSize, { path, channel });
}

export function listVolumes(): Promise<Volume[]> {
  return invoke(COMMANDS.listVolumes);
}

export function eject(path: string): Promise<void> {
  return invoke(COMMANDS.eject, { path });
}

export function defaultFolders(): Promise<DefaultFolders> {
  return invoke(COMMANDS.defaultFolders);
}

export function checkFullDiskAccess(): Promise<boolean> {
  return invoke(COMMANDS.checkFullDiskAccess);
}

export function openFullDiskAccessSettings(): Promise<void> {
  return invoke(COMMANDS.openFullDiskAccessSettings);
}

export function pbWriteFiles(paths: string[], isCut: boolean): Promise<void> {
  return invoke(COMMANDS.pbWriteFiles, { paths, isCut });
}

export function pbReadFiles(): Promise<PasteboardContents | null> {
  return invoke(COMMANDS.pbReadFiles);
}

export function pbWriteText(text: string): Promise<void> {
  return invoke(COMMANDS.pbWriteText, { text });
}

export function pbPasteNewFile(destDir: string): Promise<string | null> {
  return invoke(COMMANDS.pbPasteNewFile, { destDir });
}

export function quicklookPanel(paths: string[]): Promise<void> {
  return invoke(COMMANDS.quicklookPanel, { paths });
}

export function readTextHead(path: string, maxBytes: number): Promise<TextPreview> {
  return invoke(COMMANDS.readTextHead, { path, maxBytes });
}

export function registerPreview(path: string): Promise<string> {
  return invoke(COMMANDS.registerPreview, { path });
}

export function revokePreview(token: string): Promise<void> {
  return invoke(COMMANDS.revokePreview, { token });
}

// ---------------------------------------------------------------------------
// Broadcast events
// ---------------------------------------------------------------------------

export function onVolumesChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(EVENTS.volumesChanged, cb);
}

export function onMenuCommand(cb: (commandId: string) => void): Promise<UnlistenFn> {
  return listen<string>(EVENTS.menuCommand, (e) => cb(e.payload));
}
