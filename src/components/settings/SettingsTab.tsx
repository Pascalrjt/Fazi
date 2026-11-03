/**
 * Settings as a tab (⌘,). It takes the place of the pane cards while it's
 * the active tab, and nothing about it is modal: the sidebar, the tabs, and
 * the title strip stay live, so appearance changes show in the window as
 * you make them. Sections run along the top of the card; the title strip
 * shows Settings › Section in the address field and swaps its view controls
 * for a settings search. ⌘W closes the tab; any file tab switches back.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import clsx from "clsx";
import { Eye, Search, Settings2, X } from "lucide-react";
import { useApp, type SettingsSectionId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { getCommand } from "../../lib/commands/registry";
import { shortcutLabel } from "../../lib/keyboard";
import { SettingsFilterContext } from "./controls";
import { KeyboardPane } from "./KeyboardPane";
import {
  AppearanceSection,
  CleanupSection,
  GeneralSection,
  ResetSection,
  SearchSection,
  SidebarSection,
  TransfersSection,
} from "./SettingsSections";
import { modifiedCount, SECTIONS, sectionById } from "./sections";

const SECTION_BODY: Record<SettingsSectionId, () => React.ReactNode> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  sidebar: SidebarSection,
  keyboard: KeyboardPane,
  search: SearchSection,
  transfers: TransfersSection,
  cleanup: CleanupSection,
  reset: ResetSection,
};

function SectionBar() {
  const section = useApp((s) => s.settingsSection);
  const searching = useApp((s) => s.settingsQuery.trim() !== "");
  const setSection = useApp((s) => s.setSettingsSection);
  const values = useSettings();
  return (
    <nav
      className="flex shrink-0 justify-center gap-0.5 overflow-x-auto px-3 pt-2.5 shadow-[inset_0_-0.5px_0_var(--border)]"
      aria-label="Settings sections"
    >
      {SECTIONS.map((s) => {
        const on = s.id === section && !searching;
        const n = modifiedCount(values, s);
        return (
          <button
            key={s.id}
            className={clsx(
              "focusable relative flex min-w-[76px] cursor-default flex-col items-center gap-1 px-2 pb-2.5 pt-1.5 text-[11.5px]",
              on ? "font-semibold text-accent" : "text-secondary hover:text-primary",
            )}
            aria-current={on ? "page" : undefined}
            onClick={() => setSection(s.id)}
          >
            <s.icon size={17} strokeWidth={1.75} aria-hidden />
            {s.title}
            {n > 0 && (
              <span
                className="tnum absolute right-4 top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-bold text-white"
                title={`${n} changed`}
              >
                {n}
              </span>
            )}
            {on && <span className="absolute inset-x-3.5 bottom-0 h-0.5 rounded-full bg-accent" />}
          </button>
        );
      })}
    </nav>
  );
}

function SectionPage({ id }: { id: SettingsSectionId }) {
  const section = sectionById(id);
  const Body = SECTION_BODY[id];
  return (
    <>
      <h1 className="m-0 text-[22px] font-semibold tracking-[-0.015em]">{section.title}</h1>
      <p className="mb-[22px] mt-[3px] text-tertiary">{section.blurb}</p>
      {id === "appearance" && (
        <div className="mb-[22px] -mt-2 flex items-center gap-2 rounded-[9px] bg-accent-faint px-3 py-2.5 text-[12px] text-secondary">
          <Eye size={14} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden />
          Changes apply to this window as you make them. Switch to another tab to see a folder with them.
        </div>
      )}
      <Body />
    </>
  );
}

/** Every section stacked; rows filter themselves against the query. */
function SearchResults({ query }: { query: string }) {
  const setSection = useApp((s) => s.setSettingsSection);
  return (
    <>
      <h1 className="m-0 text-[22px] font-semibold tracking-[-0.015em]">Search</h1>
      <p className="mb-[22px] mt-[3px] text-tertiary">Settings and shortcuts matching “{query.trim()}”</p>
      {SECTIONS.map((s) => {
        const Body = SECTION_BODY[s.id];
        return (
          <div key={s.id} className="settings-section mb-7">
            <button
              className="mb-2 ml-1 cursor-default text-[13px] font-semibold text-accent hover:underline"
              onClick={() => setSection(s.id)}
            >
              {s.title}
            </button>
            <Body />
          </div>
        );
      })}
      <div className="settings-empty flex flex-col items-center gap-1.5 py-14 text-center text-secondary">
        <Search size={22} strokeWidth={1.75} className="mb-1 text-tertiary" aria-hidden />
        <div>No settings match “{query.trim()}”</div>
        <div className="text-[11.5px] text-tertiary">Try a word like “trash”, “tabs”, or “dark”.</div>
      </div>
    </>
  );
}

/** The Settings card, shown in place of the panes while its tab is active. */
export function SettingsTab() {
  const section = useApp((s) => s.settingsSection);
  const query = useApp((s) => s.settingsQuery);
  const density = useSettings((s) => s.density);
  const scrollRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();

  // Each section (and a new search) starts at the top.
  const searching = q !== "";
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [section, searching]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-pane shadow-[var(--shadow-card)]"
      aria-label="Settings"
      style={{ ["--settings-row-pad" as string]: density === "compact" ? "8px" : "11px" }}
    >
      <SectionBar />
      <div ref={scrollRef} className="settings-body min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-[26px]">
        <div className="mx-auto max-w-[660px]">
          <SettingsFilterContext.Provider value={q}>
            {searching ? <SearchResults query={query} /> : <SectionPage id={section} />}
          </SettingsFilterContext.Provider>
        </div>
      </div>
    </section>
  );
}

/** Address-field contents while Settings is the active tab. */
export function SettingsAddress() {
  const section = useApp((s) => s.settingsSection);
  const searching = useApp((s) => s.settingsQuery.trim() !== "");
  const setSection = useApp((s) => s.setSettingsSection);
  return (
    <div className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-[9px] bg-field pl-2.5 pr-1 text-tertiary shadow-[inset_0_0_0_0.5px_var(--border)]">
      <Settings2 size={14} strokeWidth={1.75} className="mr-0.5 shrink-0" aria-hidden />
      <button
        className="cursor-default rounded-[5px] px-1.5 py-0.5 text-secondary hover:bg-hov hover:text-primary"
        onClick={() => setSection("general")}
      >
        Settings
      </button>
      <span aria-hidden>›</span>
      <span className="truncate px-1.5 text-[13.5px] font-semibold text-primary">
        {searching ? "Search" : sectionById(section).title}
      </span>
    </div>
  );
}

/** The strip's settings search; ⌘F focuses it, Esc clears it. */
export function SettingsSearchField() {
  const query = useApp((s) => s.settingsQuery);
  const setQuery = useApp((s) => s.setSettingsQuery);
  const focusSeq = useApp((s) => s.settingsSearchFocusSeq);
  const ref = useRef<HTMLInputElement>(null);
  const shortcut = getCommand("focusSearch")?.shortcut;

  useEffect(() => {
    if (focusSeq === 0) return;
    ref.current?.focus();
    ref.current?.select();
  }, [focusSeq]);

  return (
    <label className="flex h-[30px] w-[260px] shrink-0 items-center gap-1.5 rounded-lg bg-field px-2.5 text-tertiary shadow-[inset_0_0_0_0.5px_var(--border)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]">
      <Search size={13} strokeWidth={1.75} className="shrink-0" aria-hidden />
      <input
        ref={ref}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-primary outline-none placeholder:text-tertiary"
        placeholder="Search settings"
        aria-label="Search settings"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (query !== "") setQuery("");
            else ref.current?.blur();
          }
        }}
      />
      {query === "" && shortcut && <kbd className="font-sans text-[11px]">{shortcutLabel(shortcut)}</kbd>}
    </label>
  );
}

/** The Settings row in the sidebar's tab list. */
export function SettingsTabRow() {
  const open = useApp((s) => s.settingsOpen);
  const active = useApp((s) => s.settingsActive);
  const setActive = useApp((s) => s.setSettingsActive);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const closeShortcut = getCommand("closeTab")?.shortcut;
  if (!open) return null;
  return (
    <div
      role="tab"
      aria-selected={active}
      data-sidebar-row
      data-sidebar-key="tab:settings"
      tabIndex={-1}
      className={clsx(
        "group flex h-8 cursor-default items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-accent",
        active ? "bg-tab text-primary shadow-[var(--shadow-tab)]" : "text-secondary hover:bg-hov",
      )}
      onMouseDown={(e) => {
        e.preventDefault();
        if (e.button === 1) setOpen(false);
      }}
      onAuxClick={(e) => e.preventDefault()}
      onClick={() => setActive(true)}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-accent text-white" aria-hidden>
        <Settings2 size={11} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1 truncate">Settings</span>
      <button
        className={clsx(
          "flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded text-tertiary hover:bg-hov hover:text-primary",
          !active && "invisible group-hover:visible",
        )}
        title={`Close Settings${closeShortcut ? ` (${shortcutLabel(closeShortcut)})` : ""}`}
        aria-label="Close Settings"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
      >
        <X size={11} strokeWidth={1.75} />
      </button>
    </div>
  );
}
