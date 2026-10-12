/**
 * Filter field (filters the active folder; ⏎ promotes it to a global search)
 * and the global-search scope controls, which live in the active pane's
 * header while a search runs.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { useApp, type SearchScope } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { useVolumes } from "../../stores/volumes";
import { captureBrowseFocus, restoreBrowseFocus } from "../../lib/keyboardFocus";

const SEARCH_DEBOUNCE_MS = 250;

const PREDICATE_HINTS: Array<[string, string]> = [
  ["kind:image", "images (also: video, audio, doc, pdf, folder, archive)"],
  ["date:7d", "modified in the last 7 days (also: today, yesterday, 30d, ISO..ISO)"],
  ["size:>10mb", "larger than 10 MB (also: <1gb, 10mb..1gb)"],
];

let debounce: ReturnType<typeof setTimeout> | null = null;

function scopePath(scope: SearchScope): string | null {
  if (scope === "home") return useVolumes.getState().folders?.home ?? null;
  if (scope === "mac") return null;
  const { activePaneId } = useApp.getState();
  const panes = usePanes.getState().panes;
  const pane = panes.find((p) => p.id === activePaneId) ?? panes[0];
  return (pane ? activeTabOf(pane)?.path : null) ?? "/";
}

/** Open (or retarget) the global search and run it after the debounce. */
function kickGlobalSearch(query: string, scope: SearchScope): void {
  useApp.getState().openGlobalSearch(query, scope);
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    useApp.getState().runGlobalSearch(query, scopePath(scope));
  }, SEARCH_DEBOUNCE_MS);
}

function cancelPendingSearch(): void {
  if (debounce) clearTimeout(debounce);
  debounce = null;
}

export function SearchField({ className }: { className?: string }) {
  const activePaneId = useApp((s) => s.activePaneId);
  const focusSeq = useApp((s) => s.searchFocusSeq);
  const globalSearch = useApp((s) => s.globalSearch);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState("");
  const [hintsOpen, setHintsOpen] = useState(false);

  useEffect(() => {
    if (focusSeq > 0) {
      returnFocusRef.current ??= captureBrowseFocus();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusSeq]);

  const restoreSearchFocus = () => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    inputRef.current?.blur();
    requestAnimationFrame(() => restoreBrowseFocus(target));
  };

  const onChange = (query: string) => {
    setValue(query);
    if (globalSearch.active) {
      kickGlobalSearch(query, globalSearch.scope);
    } else if (tab && pane) {
      usePanes.getState().setFilter(pane.id, tab.id, query);
    }
  };

  const clear = () => {
    setValue("");
    cancelPendingSearch();
    useApp.getState().closeGlobalSearch();
    if (tab && pane) usePanes.getState().setFilter(pane.id, tab.id, "");
  };

  return (
    <div
      className={clsx(
        "flex h-8 min-w-0 items-center gap-1.5 rounded-[9px] bg-field px-2.5",
        globalSearch.active
          ? "shadow-[inset_0_0_0_1.5px_var(--accent)]"
          : "shadow-[inset_0_0_0_0.5px_var(--border)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]",
        className,
      )}
    >
      <Search size={13} strokeWidth={1.75} className="shrink-0 text-tertiary" />
      <input
        ref={inputRef}
        value={value}
        placeholder={globalSearch.active ? "Search everywhere" : "Filter — ⏎ searches"}
        onChange={(e) => onChange(e.target.value)}
        onPointerDown={() => {
          returnFocusRef.current ??= captureBrowseFocus();
        }}
        onFocus={() => useApp.getState().setSearchFieldFocused(true)}
        onBlur={() => {
          useApp.getState().setSearchFieldFocused(false);
          returnFocusRef.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !globalSearch.active && value.trim() !== "") {
            // promote the filter to a global search
            if (tab && pane) usePanes.getState().setFilter(pane.id, tab.id, "");
            kickGlobalSearch(value, "folder");
          } else if (e.key === "Escape") {
            clear();
            restoreSearchFocus();
          }
        }}
        className="w-full min-w-0 bg-transparent text-xs text-primary outline-none placeholder:text-tertiary"
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
              className="absolute left-0 top-6 z-[90] w-[340px] rounded-lg border border-edge bg-raised p-3 text-left"
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
  );
}

/** Segmented control in the shared style (view toggle, search scopes). */
export function Segmented<T extends string | boolean>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, React.ReactNode, string?]>;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-hov p-0.5" role="group" aria-label={label}>
      {options.map(([v, content, title]) => (
        <button
          key={String(v)}
          title={title}
          aria-pressed={value === v}
          className={clsx(
            "flex h-[22px] cursor-default items-center rounded-[5px] px-2 text-[11.5px]",
            value === v
              ? "bg-tab text-primary shadow-[var(--shadow-tab)]"
              : "text-secondary hover:text-primary",
          )}
          onClick={() => onChange(v)}
        >
          {content}
        </button>
      ))}
    </div>
  );
}

/** Scope (folder / home / Mac) and match mode (filename / contents). */
export function SearchScopes() {
  const globalSearch = useApp((s) => s.globalSearch);
  if (!globalSearch.active) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Segmented<SearchScope>
        label="Search scope"
        value={globalSearch.scope}
        options={[
          ["folder", "This Folder"],
          ["home", "Home"],
          ["mac", "This Mac"],
        ]}
        onChange={(scope) => kickGlobalSearch(globalSearch.query, scope)}
      />
      <Segmented<boolean>
        label="Match"
        value={globalSearch.contents}
        options={[
          [false, "Filename"],
          [true, "Contents"],
        ]}
        onChange={(contents) => {
          if (globalSearch.contents === contents) return;
          useApp.getState().setSearchContents(contents);
          kickGlobalSearch(globalSearch.query, globalSearch.scope);
        }}
      />
    </div>
  );
}
