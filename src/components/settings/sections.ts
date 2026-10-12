/** Sections of the Settings tab: order, labels, and the keys each owns. */
import {
  ArrowRightLeft,
  Hourglass,
  Keyboard,
  Palette,
  PanelLeft,
  RotateCcw,
  Search,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import type { SettingsSectionId } from "../../stores/app";
import { SETTINGS_DEFAULTS, type SettingsValues } from "../../stores/settings";

export type SettingKey = keyof SettingsValues;

export interface SettingsSection {
  id: SettingsSectionId;
  title: string;
  icon: LucideIcon;
  blurb: string;
  /** Settings whose changes count toward the section's badge. */
  keys: SettingKey[];
}

export const SECTIONS: SettingsSection[] = [
  {
    id: "general",
    title: "General",
    icon: Settings2,
    blurb: "Startup, new tabs, and confirmations.",
    keys: [
      "restoreTabs",
      "viewMode",
      "showFolderSizes",
      "defaultSortKey",
      "defaultSortDir",
      "showHidden",
      "confirmPermanentDelete",
      "confirmEmptyTrash",
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    icon: Palette,
    blurb: "Theme, color, and how dense lists look.",
    keys: ["theme", "accent", "density", "zebraStripes", "sidebarPosition"],
  },
  {
    id: "sidebar",
    title: "Sidebar",
    icon: PanelLeft,
    blurb: "What the sidebar lists above your tabs.",
    keys: ["showTrashInSidebar"],
  },
  {
    id: "keyboard",
    title: "Keyboard",
    icon: Keyboard,
    blurb: "Vim mode and every shortcut.",
    keys: ["vimMode", "paneAccentLine", "keybindingOverrides"],
  },
  {
    id: "search",
    title: "Search",
    icon: Search,
    blurb: "Search Everywhere and Go to File.",
    keys: ["searchContentsDefault", "searchMaxResults", "fuzzyExcludes", "fuzzyIndexEntryCap"],
  },
  {
    id: "transfers",
    title: "Transfers",
    icon: ArrowRightLeft,
    blurb: "Copying, moving, and dragging files out.",
    keys: ["verifyCopies", "opCardAutoHideMs", "dragOutEnabled", "nativeSharePicker"],
  },
  {
    id: "cleanup",
    title: "Auto-cleanup",
    icon: Hourglass,
    blurb: "Clear out folders that fill up on their own.",
    keys: ["cleanupEnabled", "cleanupRules", "cleanupSkipOpenedDays", "cleanupKeepFolder"],
  },
  {
    id: "reset",
    title: "Reset",
    icon: RotateCcw,
    blurb: "Start over with the defaults.",
    keys: [],
  },
];

export function sectionById(id: SettingsSectionId): SettingsSection {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function isModified(values: SettingsValues, key: SettingKey): boolean {
  return !same(values[key], SETTINGS_DEFAULTS[key]);
}

/** Changed settings in a section; each rebound shortcut counts as one. */
export function modifiedCount(values: SettingsValues, section: SettingsSection): number {
  let n = 0;
  for (const key of section.keys) {
    if (key === "keybindingOverrides") n += Object.keys(values.keybindingOverrides).length;
    else if (isModified(values, key)) n++;
  }
  return n;
}

export function totalModified(values: SettingsValues): number {
  return SECTIONS.reduce((n, s) => n + modifiedCount(values, s), 0);
}
