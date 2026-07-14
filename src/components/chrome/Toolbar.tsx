/**
 * Window toolbar: traffic-light padding + drag region, back/forward,
 * breadcrumb path bar (clickable crumbs, drop targets, editable mode),
 * search field with global-scope pills, view toggle, menu button.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  LayoutGrid,
  List,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { useApp, type SearchScope } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { useSettings } from "../../stores/settings";
import { useVolumes } from "../../stores/volumes";
import { pathSegments } from "../../lib/format";
import { activeDragPaths, isInvalidDrop, onDropHover, registerDropZone } from "../../lib/dnd";
import { runCommand, allCommands } from "../../lib/commands/registry";
import { showMenu, type MenuItem } from "../../stores/menu";

const SEARCH_DEBOUNCE_MS = 250;

function NavButton({
  icon: Icon,
  title,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "focusable flex h-7 w-7 cursor-default items-center justify-center rounded-md",
        disabled ? "text-tertiary" : "text-secondary hover:bg-hov hover:text-primary",
      )}
    >
      <Icon size={15} strokeWidth={1.75} />
    </button>
  );
}

function Breadcrumbs() {
  const activePaneId = useApp((s) => s.activePaneId);
  const editing = useApp((s) => s.pathBarEditing);
  const setEditing = useApp((s) => s.setPathBarEditing);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const navigate = usePanes((s) => s.navigate);
  const tab = pane ? activeTabOf(pane) : null;
  const [draft, setDraft] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing && tab) {
      setDraft(tab.path);
      // focus after mount
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Native drop target: each crumb accepts a drop into its directory. Crumb
  // rects are queried live from the DOM so navigation never leaves a stale
  // closure behind (same trick as the sidebar's insertIndexFromPoint).
  useEffect(() => {
    return registerDropZone({
      priority: 30,
      hitTest: (x, y) => {
        const crumbs = crumbsRef.current?.querySelectorAll<HTMLElement>("[data-crumb-path]");
        for (const el of crumbs ?? []) {
          const r = el.getBoundingClientRect();
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
          const dest = el.dataset.crumbPath;
          if (!dest) continue;
          const paths = activeDragPaths();
          if (paths != null && isInvalidDrop(paths, dest)) return null;
          return { action: "copyTo", destDir: dest, targetKey: `crumb:${dest}` };
        }
        return null;
      },
    });
  }, []);

  useEffect(() => {
    return onDropHover((h) =>
      setDropTarget(
        h != null && h.hit.action === "copyTo" && h.hit.targetKey?.startsWith("crumb:")
          ? h.hit.destDir
          : null,
      ),
    );
  }, []);

  if (!tab || !pane) return null;

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const path = draft.trim().replace(/^~(?=\/|$)/, useVolumes.getState().folders?.home ?? "~");
            if (path.startsWith("/")) {
              navigate(pane.id, tab.id, path.length > 1 ? path.replace(/\/+$/, "") : "/");
            }
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
        className="h-7 min-w-0 flex-1 rounded-md border border-accent bg-pane px-2 font-mono text-xs text-primary outline-none"
        spellCheck={false}
        placeholder="/path/to/folder"
      />
    );
  }

  const segs = pathSegments(tab.path);
  const shown = segs.length > 4 ? segs.slice(-4) : segs;
  const elided = segs.length > 4;

  return (
    <div
      ref={crumbsRef}
      className="flex h-7 min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-md px-1 hover:bg-hov/50"
      onDoubleClick={() => setEditing(true)}
      data-tauri-drag-region
    >
      {elided && <span className="shrink-0 px-1 text-xs text-tertiary">…</span>}
      {shown.map((seg, i) => (
        <span key={seg.path} className="flex min-w-0 items-center">
          {(i > 0 || elided) && <span className="px-0.5 text-[10px] text-tertiary">›</span>}
          <button
            className={clsx(
              "focusable min-w-0 cursor-default truncate rounded px-1.5 py-0.5 text-[13px]",
              i === shown.length - 1
                ? "font-medium text-primary"
                : "text-secondary hover:bg-hov hover:text-primary",
              dropTarget === seg.path && "drop-ring",
            )}
            onClick={() => {
              if (seg.path !== tab.path) navigate(pane.id, tab.id, seg.path);
            }}
            data-crumb-path={seg.path}
          >
            {seg.name}
          </button>
        </span>
      ))}
      <div className="h-full min-w-4 flex-1" onClick={() => setEditing(true)} data-tauri-drag-region />
    </div>
  );
}

const PREDICATE_HINTS: Array<[string, string]> = [
  ["kind:image", "images (also: video, audio, doc, pdf, folder, archive)"],
  ["date:7d", "modified in the last 7 days (also: today, yesterday, 30d, ISO..ISO)"],
  ["size:>10mb", "larger than 10 MB (also: <1gb, 10mb..1gb)"],
];

function SearchField() {
  const activePaneId = useApp((s) => s.activePaneId);
  const focusSeq = useApp((s) => s.searchFocusSeq);
  const globalSearch = useApp((s) => s.globalSearch);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const homePath = useVolumes((s) => s.folders?.home ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [value, setValue] = useState("");
  const [hintsOpen, setHintsOpen] = useState(false);

  useEffect(() => {
    if (focusSeq > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusSeq]);

  const scopePath = (scope: SearchScope): string | null => {
    if (scope === "folder") return tab?.path ?? "/";
    if (scope === "home") return homePath;
    return null;
  };

  const kickGlobal = (query: string, scope: SearchScope) => {
    const app = useApp.getState();
    app.openGlobalSearch(query, scope);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      useApp.getState().runGlobalSearch(query, scopePath(scope));
    }, SEARCH_DEBOUNCE_MS);
  };

  const onChange = (query: string) => {
    setValue(query);
    if (globalSearch.active) {
      kickGlobal(query, globalSearch.scope);
    } else if (tab && pane) {
      usePanes.getState().setFilter(pane.id, tab.id, query);
    }
  };

  const clear = () => {
    setValue("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    useApp.getState().closeGlobalSearch();
    if (tab && pane) usePanes.getState().setFilter(pane.id, tab.id, "");
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div
        className={clsx(
          "flex h-7 w-[200px] items-center gap-1.5 rounded-md border bg-pane px-2",
          globalSearch.active ? "border-accent" : "border-edge",
        )}
      >
        <Search size={12} strokeWidth={1.75} className="shrink-0 text-tertiary" />
        <input
          ref={inputRef}
          value={value}
          placeholder={globalSearch.active ? "Search everywhere" : "Filter — ⏎ searches"}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => useApp.getState().setSearchFieldFocused(true)}
          onBlur={() => useApp.getState().setSearchFieldFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !globalSearch.active && value.trim() !== "") {
              // promote the filter to a global search
              if (tab && pane) usePanes.getState().setFilter(pane.id, tab.id, "");
              kickGlobal(value, "folder");
            } else if (e.key === "Escape") {
              clear();
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-full bg-transparent text-xs text-primary outline-none placeholder:text-tertiary"
          spellCheck={false}
        />
        {value !== "" && (
          <button
            className="flex shrink-0 cursor-default items-center text-tertiary hover:text-secondary"
            onClick={clear}
            aria-label="Clear search"
          >
            <X size={11} strokeWidth={1.75} />
          </button>
        )}
        {globalSearch.active && (
          <div className="relative">
            <button
              className="cursor-default text-[10px] text-tertiary hover:text-secondary"
              title="Search predicates"
              onClick={() => setHintsOpen((v) => !v)}
            >
              ?
            </button>
            {hintsOpen && (
              <div
                className="absolute right-0 top-6 z-[90] w-[340px] rounded-lg border border-edge bg-raised p-3 text-left"
                style={{ boxShadow: "var(--shadow-overlay)" }}
                onMouseLeave={() => setHintsOpen(false)}
              >
                <div className="mb-1.5 text-[11px] font-semibold text-secondary">
                  Search predicates
                </div>
                {PREDICATE_HINTS.map(([token, desc]) => (
                  <div key={token} className="mb-1 flex gap-2 text-[11px]">
                    <code className="shrink-0 rounded bg-pane px-1 text-accent">{token}</code>
                    <span className="text-tertiary">{desc}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {globalSearch.active && (
        <div className="flex items-center gap-0.5 rounded-md bg-pane p-0.5">
          {(
            [
              ["folder", "This Folder"],
              ["home", "Home"],
              ["mac", "This Mac"],
            ] as const
          ).map(([scope, label]) => (
            <button
              key={scope}
              className={clsx(
                "cursor-default rounded px-1.5 py-0.5 text-[11px]",
                globalSearch.scope === scope
                  ? "bg-accent text-white"
                  : "text-secondary hover:bg-hov",
              )}
              onClick={() => kickGlobal(globalSearch.query, scope)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {globalSearch.active && (
        <div className="flex items-center gap-0.5 rounded-md bg-pane p-0.5">
          {(
            [
              [false, "Filename"],
              [true, "Contents"],
            ] as const
          ).map(([contents, label]) => (
            <button
              key={label}
              className={clsx(
                "cursor-default rounded px-1.5 py-0.5 text-[11px]",
                globalSearch.contents === contents
                  ? "bg-accent text-white"
                  : "text-secondary hover:bg-hov",
              )}
              onClick={() => {
                if (globalSearch.contents === contents) return;
                useApp.getState().setSearchContents(contents);
                kickGlobal(globalSearch.query, globalSearch.scope);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function toolbarMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  const byId = (id: string) => allCommands().find((c) => c.id === id);
  const add = (id: string, label?: string): void => {
    const cmd = byId(id);
    if (!cmd) return;
    items.push({
      type: "item",
      label: label ?? cmd.title,
      shortcut: cmd.shortcut,
      action: () => runCommand(id),
    });
  };
  add("newFolder");
  add("newTab");
  items.push({ type: "separator" });
  add("toggleHidden");
  add("toggleSidebar");
  add("dualPane");
  items.push({ type: "separator" });
  add("getInfo");
  add("revealInFinder");
  add("eject");
  items.push({ type: "separator" });
  add("palette", "Command Palette…");
  return items;
}

export function Toolbar() {
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const viewMode = useSettings((s) => s.viewMode);
  const setViewMode = useSettings((s) => s.setViewMode);
  const back = usePanes((s) => s.back);
  const forward = usePanes((s) => s.forward);
  const loading = tab?.loading ?? false;

  return (
    <div
      className="traffic-pad relative flex h-[46px] shrink-0 items-center gap-2 border-b border-edge bg-window pr-3"
      data-tauri-drag-region
    >
      {loading && <div className="loading-bar" />}
      <div className="flex shrink-0 items-center">
        <NavButton
          icon={ChevronLeft}
          title="Back (⌘[)"
          disabled={!tab || tab.back.length === 0}
          onClick={() => pane && tab && back(pane.id, tab.id)}
        />
        <NavButton
          icon={ChevronRight}
          title="Forward (⌘])"
          disabled={!tab || tab.forward.length === 0}
          onClick={() => pane && tab && forward(pane.id, tab.id)}
        />
      </div>
      <Breadcrumbs />
      <SearchField />
      <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-pane p-0.5">
        <button
          title="List view (⌘1)"
          className={clsx(
            "flex cursor-default items-center rounded px-1.5 py-0.5",
            viewMode === "list" ? "bg-raised text-primary" : "text-tertiary hover:text-secondary",
          )}
          onClick={() => setViewMode("list")}
        >
          <List size={13} strokeWidth={1.75} />
        </button>
        <button
          title="Icon view (⌘2)"
          className={clsx(
            "flex cursor-default items-center rounded px-1.5 py-0.5",
            viewMode === "grid" ? "bg-raised text-primary" : "text-tertiary hover:text-secondary",
          )}
          onClick={() => setViewMode("grid")}
        >
          <LayoutGrid size={13} strokeWidth={1.75} />
        </button>
      </div>
      <button
        title="Menu"
        className="focusable flex h-7 w-7 shrink-0 cursor-default items-center justify-center rounded-md text-secondary hover:bg-hov hover:text-primary"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          showMenu(rect.right - 232, rect.bottom + 4, toolbarMenuItems());
        }}
      >
        <Ellipsis size={15} strokeWidth={1.75} />
      </button>
    </div>
  );
}
