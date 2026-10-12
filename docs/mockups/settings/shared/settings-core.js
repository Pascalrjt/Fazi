/*
 * Fazi settings mockup engine. Every settings design shares this file: the
 * settings model (every setting the app has today, regrouped), the
 * shortcut recorder with conflict blocking, the cleanup rules, pinned
 * folders, search, per-setting reset, and the live preview. A design
 * supplies only its layout function and stylesheet, so behavior is
 * identical by construction.
 *
 * Plain script (no modules) so the pages open straight from disk.
 */
window.FaziSettings = (() => {
  "use strict";

  // -------------------------------------------------------------------------
  // Icons (lucide geometry, 24×24, stroke = currentColor)
  // -------------------------------------------------------------------------

  const ICONS = {
    settings:
      '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    palette:
      '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    keyboard:
      '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    transfer: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
    hourglass:
      '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    wrench:
      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronUp: '<path d="m18 15-6-6-6 6"/>',
    arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    grip: '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    monitor:
      '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    rows: '<path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/>',
    list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    alert:
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    house:
      '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    fileText:
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  };

  function icon(name, size = 14, cls = "") {
    return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // -------------------------------------------------------------------------
  // Keyboard model (labels match the app's shortcutLabel)
  // -------------------------------------------------------------------------

  const KEY_LABEL = {
    cmd: "⌘", shift: "⇧", opt: "⌥", ctrl: "⌃", up: "↑", down: "↓", left: "←", right: "→",
    enter: "↩", delete: "⌫", escape: "Esc", tab: "⇥", space: "Space",
  };
  const MOD_ORDER = ["ctrl", "opt", "shift", "cmd"];

  function shortcutLabel(sc) {
    if (!sc) return "";
    const parts = sc.split("+");
    const key = parts.pop();
    const mods = MOD_ORDER.filter((m) => parts.includes(m)).map((m) => KEY_LABEL[m]).join("");
    const k = KEY_LABEL[key] || (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
    return mods + k;
  }

  function shortcutFromEvent(e) {
    const named = {
      ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "enter",
      Backspace: "delete", Escape: "escape", Tab: "tab", " ": "space",
    };
    if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return null;
    let key = named[e.key];
    if (!key) {
      if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
      else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
      else if (e.code === "Period") key = ".";
      else if (e.code === "Comma") key = ",";
      else if (e.code === "Slash") key = "/";
      else if (e.code === "BracketLeft") key = "[";
      else if (e.code === "BracketRight") key = "]";
      else key = e.key.toLowerCase();
    }
    const mods = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("opt");
    if (e.shiftKey) mods.push("shift");
    if (e.metaKey) mods.push("cmd");
    return [...mods, key].join("+");
  }

  const VIM_RESERVED = new Set("h j k l g v y d p u m / 0 1 2 3 4 5 6 7 8 9".split(" "));
  const isVimReserved = (sc) => !sc.includes("+") && VIM_RESERVED.has(sc);

  /* Grouped for the mock; the app's registry would gain a `category`. */
  const COMMANDS = [
    ["Files", [
      ["open", "Open", "cmd+down"], ["openWith", "Open With…", null], ["getInfo", "Get Info", "cmd+i"],
      ["preview", "Quick Look", "space"], ["newFolder", "New Folder", "cmd+shift+n"], ["rename", "Rename", "enter"],
      ["batchRename", "Rename Multiple Items…", "cmd+shift+r"], ["duplicate", "Duplicate", "cmd+d"],
      ["compress", "Compress", null], ["share", "Share…", "cmd+shift+s"], ["revealInFinder", "Reveal in Finder", null],
    ]],
    ["Edit", [
      ["copy", "Copy", "cmd+c"], ["cut", "Cut", "cmd+x"], ["paste", "Paste", "cmd+v"],
      ["movePaste", "Move Items Here", "cmd+opt+v"], ["copyPathname", "Copy as Pathname", "cmd+opt+c"],
      ["undo", "Undo", "cmd+z"], ["redo", "Redo", "cmd+shift+z"], ["selectAll", "Select All", "cmd+a"],
    ]],
    ["Trash & cleanup", [
      ["trash", "Move to Trash", "cmd+delete"], ["deletePermanent", "Delete Immediately…", "cmd+opt+delete"],
      ["emptyTrash", "Empty Trash…", "cmd+shift+delete"], ["toggleCleanupKeep", "Keep (Skip Auto-cleanup)", "cmd+opt+k"],
      ["cleanupNow", "Run Auto-cleanup Now", null],
    ]],
    ["Go", [
      ["back", "Back", "cmd+["], ["forward", "Forward", "cmd+]"], ["up", "Enclosing Folder", "cmd+up"],
      ["goHome", "Go to Home", "cmd+shift+h"], ["goDownloads", "Go to Downloads", "cmd+opt+l"],
      ["goApplications", "Go to Applications", "cmd+shift+a"], ["openLocation", "Go to Folder…", "cmd+shift+g"],
    ]],
    ["Tabs & panes", [
      ["newTab", "New Tab", "cmd+t"], ["closeTab", "Close Tab", "cmd+w"], ["nextTab", "Next Tab", "ctrl+tab"],
      ["prevTab", "Previous Tab", "ctrl+shift+tab"], ["dualPane", "Toggle Dual Pane", "cmd+shift+d"],
      ["swapPane", "Focus Other Pane", "tab"], ["toggleSidebar", "Toggle Sidebar", "cmd+opt+s"],
    ]],
    ["View", [
      ["viewList", "View as List", "cmd+1"], ["viewGrid", "View as Icons", "cmd+2"],
      ["toggleHidden", "Toggle Hidden Files", "cmd+shift+."], ["refresh", "Refresh", "cmd+r"],
    ]],
    ["Search & commands", [
      ["focusSearch", "Search This Folder", "cmd+f"], ["fuzzyFinder", "Go to File…", "cmd+p"],
      ["globalSearch", "Search Everywhere", "cmd+shift+f"], ["palette", "Command Palette", "cmd+k"],
      ["toggleVimMode", "Toggle Vim Mode", null], ["settings", "Settings…", "cmd+,"],
    ]],
  ];
  const CMD = {};
  for (const [cat, list] of COMMANDS) for (const [id, title, sc] of list) CMD[id] = { id, title, sc, cat };

  const VIM_CHEATS = [
    ["j / k", "Move down / up (counts work: 12j)"], ["h / l", "Enclosing folder / open"],
    ["gg / G", "First / last item"], ["v", "Visual selection"], ["yy · dd · p", "Copy · cut · paste"],
    ["u / ⌃R", "Undo / redo"], ["/", "Filter this folder"], ["?", "Search everywhere"],
    [":", "Command palette"], ["gt / gT", "Next / previous tab"], ["gs", "Cycle sidebar and panes"],
    ["g?", "This cheat sheet"],
  ];

  // -------------------------------------------------------------------------
  // Settings model
  // -------------------------------------------------------------------------

  const DEFAULTS = {
    restoreTabs: true,
    viewMode: "list",
    sort: { key: "name", dir: "asc" },
    showHidden: false,
    showFolderSizes: false,
    confirmPermanentDelete: true,
    confirmEmptyTrash: true,
    theme: "system",
    accent: "",
    density: "normal",
    zebraStripes: true,
    sidebarPosition: "left",
    showTrash: true,
    vimMode: false,
    paneAccentLine: true,
    keys: {},
    searchContentsDefault: false,
    searchMaxResults: 10000,
    fuzzyExcludes: [".git", "node_modules", "Library/Caches", ".Trash"],
    fuzzyIndexEntryCap: 0,
    verifyCopies: false,
    opCardAutoHide: 4,
    dragOutEnabled: true,
    nativeSharePicker: false,
    cleanupEnabled: false,
    cleanupRules: [{ path: "~/Downloads", days: 14 }],
    cleanupSkipOpenedDays: 3,
    cleanupKeepFolder: "Keep",
  };

  /* Data that a reset leaves alone (favorites and kept items). */
  const DATA_DEFAULTS = {
    favorites: [
      { path: "~/Projects", name: "Projects" },
      { path: "~/Projects/Fazi", name: "Fazi" },
      { path: "~/Documents/Invoices", name: "Invoices" },
    ],
    kept: [
      { name: "tax-return-2025.pdf", path: "~/Downloads/tax-return-2025.pdf" },
      { name: "Lease scan.jpg", path: "~/Downloads/Lease scan.jpg" },
      { name: "fonts", path: "~/Downloads/fonts" },
    ],
  };

  const ACCENTS = [
    ["", "Default"], ["#e0383e", "Red"], ["#e8883a", "Orange"], ["#d4a92a", "Yellow"],
    ["#4fa356", "Green"], ["#9a6ee8", "Purple"], ["#e56ba5", "Pink"],
  ];

  /*
   * Every setting. `kw` adds search words. `block` puts the control under
   * the label (lists and editors). `needs` dims a row while its parent is off.
   */
  const SPEC = {
    restoreTabs: { label: "Reopen tabs at launch", hint: "Open the tabs and panes from your last session.", type: "toggle", kw: "restore session startup windows" },
    viewMode: { label: "View new tabs as", type: "seg", options: [["list", "List"], ["grid", "Icons"]], kw: "default view list icons grid" },
    sort: { label: "Sort new tabs by", type: "sort", kw: "default sort order name size modified kind ascending descending" },
    showHidden: { label: "Show hidden files", hint: "Show dotfiles and other hidden items. ⌘⇧. switches this anywhere.", type: "toggle", kw: "dotfiles invisible" },
    showFolderSizes: { label: "Show folder sizes", hint: "Calculate folder sizes in list view. Sizes are estimates and can lag behind changes.", type: "toggle", kw: "folder size calculate" },
    confirmPermanentDelete: { label: "Ask before deleting immediately", hint: "Confirm Delete Immediately (⌘⌥⌫), which skips the Trash.", type: "toggle", kw: "confirm permanent delete dialog" },
    confirmEmptyTrash: { label: "Ask before emptying the Trash", type: "toggle", kw: "confirm empty trash dialog" },
    theme: { label: "Theme", type: "theme", kw: "dark light mode system appearance" },
    accent: { label: "Accent color", hint: "Colors selection, focus, and switches.", type: "accent", kw: "accent color highlight tint" },
    density: { label: "Row height", hint: "Compact fits more rows on screen.", type: "seg", options: [["normal", "Regular"], ["compact", "Compact"]], kw: "density compact row spacing" },
    zebraStripes: { label: "Alternating row colors", hint: "Stripe list rows to make them easier to follow.", type: "toggle", kw: "zebra stripes rows" },
    sidebarPosition: { label: "Sidebar position", hint: "Dock the sidebar and its tabs to this edge of the window.", type: "seg", options: [["left", "Left"], ["right", "Right"]], kw: "sidebar dock side left right tabs" },
    showTrash: { label: "Show Trash in sidebar", type: "toggle", kw: "trash sidebar" },
    favorites: { label: "Pinned folders", hint: "Drag folders onto the sidebar to pin them. Drag here to reorder.", type: "favorites", block: true, data: true, kw: "favorites pins pinned folders" },
    vimMode: { label: "Vim mode", hint: "Move with hjkl, select with v, copy and paste with yy, dd, and p. Letter keys stop jumping to file names; press / to filter instead.", type: "toggle", kw: "vim hjkl modal keys" },
    paneAccentLine: { label: "Focus ring", hint: "Outline the pane that receives your keystrokes.", type: "toggle", needs: "vimMode", kw: "focus ring outline pane active vim" },
    vimCheats: { label: "Vim keys", type: "vimCheats", block: true, needs: "vimMode", virtual: true, kw: "cheat sheet vim keys" },
    keys: { label: "Shortcuts", hint: "Click a shortcut, then press the new keys. Esc cancels.", type: "shortcuts", block: true, kw: "keyboard shortcuts keybindings hotkeys rebind" },
    searchContentsDefault: { label: "Search file contents", hint: "New searches match text inside files as well as names.", type: "toggle", kw: "contents full text spotlight default" },
    searchMaxResults: { label: "Result limit", hint: "Stop listing results after this many.", type: "stepper", min: 100, max: 10000, step: 500, unit: "results", kw: "max results cap" },
    fuzzyExcludes: { label: "Skip when indexing", hint: "A name matches at any depth. A path like Library/Caches starts at your home folder.", type: "chips", block: true, kw: "fuzzy index excludes ignore node_modules go to file ⌘p" },
    fuzzyIndexEntryCap: { label: "Index size limit", hint: "Stop indexing after this many items. Use this when indexing a huge folder is slow.", type: "cap", kw: "fuzzy index entry cap limit" },
    verifyCopies: { label: "Verify copies", hint: "Compare each copied file with its original using a checksum. Copies take longer. Moves between disks are always verified.", type: "toggle", kw: "checksum blake3 verify integrity" },
    opCardAutoHide: { label: "Hide finished transfers after", hint: "Failed transfers stay until you close them.", type: "stepper", min: 1, max: 60, step: 1, unit: "s", kw: "op card progress auto hide operations" },
    dragOutEnabled: { label: "Drag files to other apps", hint: "Drag from Fazi into Finder, Mail, and other apps. Turn off to keep drags inside Fazi.", type: "toggle", kw: "native drag out drag and drop" },
    nativeSharePicker: { label: "Use the macOS share sheet", hint: "Share opens the system share sheet in place of Fazi's Share submenu.", type: "toggle", kw: "share picker airdrop" },
    cleanupEnabled: { label: "Auto-cleanup", hint: "Move old items in the folders below to the Trash. Fazi checks when it opens and every hour after. The first check runs an hour after you turn this on.", type: "toggle", kw: "auto cleanup trash old downloads" },
    cleanupRules: { label: "Folders", hint: "Only items directly inside each folder count. Age counts from when an item arrived.", type: "rules", block: true, kw: "cleanup folders rules days downloads" },
    cleanupSkipOpenedDays: { label: "Keep recently opened files", hint: "A file you opened within this window stays put.", type: "seg", options: [["0", "Off"], ["1", "1 day"], ["3", "3 days"], ["7", "7 days"]], num: true, kw: "skip opened recent" },
    cleanupKeepFolder: { label: "Protected subfolder", hint: "A subfolder with this name is never cleaned. Leave it empty for none.", type: "text", placeholder: "None", kw: "keep folder excluded subfolder" },
    kept: { label: "Kept items", hint: "Items you kept with ⌥⌘K or put back from the Trash. Auto-cleanup leaves them alone.", type: "kept", block: true, data: true, kw: "kept pinned skip cleanup" },
    resetAll: { label: "Reset all settings", hint: "Return every setting to its default. Pinned folders, kept items, and column widths stay.", type: "reset", virtual: true, kw: "reset defaults restore" },
  };

  const SECTIONS = [
    { id: "general", title: "General", icon: "settings", tint: "#7a8494", blurb: "Startup, new tabs, and confirmations.", groups: [
      { title: "Startup", ids: ["restoreTabs"] },
      { title: "New tabs", ids: ["viewMode", "sort", "showHidden", "showFolderSizes"] },
      { title: "Confirmations", ids: ["confirmPermanentDelete", "confirmEmptyTrash"] },
    ] },
    { id: "appearance", title: "Appearance", icon: "palette", tint: "#3d6ae0", blurb: "Theme, color, and how dense lists look.", preview: true, groups: [
      { title: "Look", ids: ["theme", "accent"] },
      { title: "Lists", ids: ["density", "zebraStripes"] },
      { title: "Layout", ids: ["sidebarPosition"] },
    ] },
    { id: "sidebar", title: "Sidebar", icon: "sidebar", tint: "#4c9bd6", blurb: "What the sidebar lists above your tabs.", groups: [
      { title: "Locations", ids: ["showTrash"] },
      { title: "Pinned", ids: ["favorites"] },
    ] },
    { id: "keyboard", title: "Keyboard", icon: "keyboard", tint: "#5e6675", blurb: "Vim mode and every shortcut.", groups: [
      { title: "Vim", ids: ["vimMode", "paneAccentLine", "vimCheats"] },
      { title: "Shortcuts", ids: ["keys"] },
    ] },
    { id: "search", title: "Search", icon: "search", tint: "#9a6ee8", blurb: "Search Everywhere and Go to File.", groups: [
      { title: "Search Everywhere", ids: ["searchContentsDefault", "searchMaxResults"] },
      { title: "Go to File index", ids: ["fuzzyExcludes", "fuzzyIndexEntryCap"] },
    ] },
    { id: "transfers", title: "Transfers", icon: "transfer", tint: "#3aa676", blurb: "Copying, moving, and dragging files out.", groups: [
      { title: "Copying", ids: ["verifyCopies", "opCardAutoHide"] },
      { title: "Other apps", ids: ["dragOutEnabled", "nativeSharePicker"] },
    ] },
    { id: "cleanup", title: "Auto-cleanup", icon: "hourglass", tint: "#e0883a", blurb: "Clear out folders that fill up on their own.", groups: [
      { title: null, ids: ["cleanupEnabled"] },
      { title: "Rules", ids: ["cleanupRules", "cleanupSkipOpenedDays", "cleanupKeepFolder"], needs: "cleanupEnabled" },
      { title: "Exceptions", ids: ["kept"] },
    ] },
    { id: "advanced", title: "Reset", icon: "rotate", tint: "#d0473f", blurb: "Start over with the defaults.", groups: [
      { title: null, ids: ["resetAll"] },
    ] },
  ];
  const SECTION_OF = {};
  for (const s of SECTIONS) for (const g of s.groups) for (const id of g.ids) SECTION_OF[id] = s.id;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const KEY = "fazi-settings-mock-v1";
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const V = Object.assign(clone(DEFAULTS), clone(DATA_DEFAULTS), JSON.parse(localStorage.getItem(KEY) || "{}"));
  const save = () => localStorage.setItem(KEY, JSON.stringify(V));

  /* UI state the engine owns; designs keep their own (section, scroll…). */
  const U = {
    open: true,
    query: "",
    keysQuery: "",
    recording: null, // command id
    capture: null, // { id, sc, conflictWith, vim }
    confirmReset: false,
    toasts: [],
    chipDraft: "",
    dragFav: null,
  };

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isModified = (id) => id in DEFAULTS && !same(V[id], DEFAULTS[id]);
  function modifiedIn(sectionId) {
    const s = SECTIONS.find((x) => x.id === sectionId);
    let n = 0;
    for (const g of s.groups) for (const id of g.ids) if (isModified(id)) n += id === "keys" ? Object.keys(V.keys).length : 1;
    return n;
  }
  const totalModified = () => SECTIONS.reduce((n, s) => n + modifiedIn(s.id), 0);

  function set(id, value) {
    V[id] = value;
    save();
    applyLook();
    render();
  }

  function resetSetting(id) {
    set(id, clone(DEFAULTS[id]));
    toast(`${SPEC[id].label} reset`);
  }

  // -------------------------------------------------------------------------
  // Shortcut bindings
  // -------------------------------------------------------------------------

  const bindingOf = (id) => (id in V.keys ? V.keys[id] : CMD[id].sc);

  function conflictFor(id, sc) {
    for (const other of Object.values(CMD)) {
      if (other.id !== id && bindingOf(other.id) === sc) return other.id;
    }
    return null;
  }

  function setBinding(id, sc) {
    const next = { ...V.keys };
    if (sc === CMD[id].sc) delete next[id];
    else next[id] = sc;
    set("keys", next);
  }

  function commandMatches(q) {
    if (!q) return Object.values(CMD);
    return Object.values(CMD).filter((c) =>
      `${c.title} ${c.cat} ${shortcutLabel(bindingOf(c.id) || "")} ${c.id}`.toLowerCase().includes(q),
    );
  }

  // -------------------------------------------------------------------------
  // Look (theme + accent apply to the page so every design is live)
  // -------------------------------------------------------------------------

  const media = matchMedia("(prefers-color-scheme: dark)");
  /* `#theme=` in the URL stands in for the system appearance (screenshots). */
  let systemTheme = null;
  const resolvedTheme = () =>
    V.theme === "system" ? systemTheme || (media.matches ? "dark" : "light") : V.theme;
  media.addEventListener?.("change", () => {
    applyLook();
    render();
  });

  let lookHook = null;
  function applyLook() {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme();
    root.dataset.density = V.density;
    root.dataset.sidebar = V.sidebarPosition;
    if (V.accent) {
      root.style.setProperty("--accent", V.accent);
      root.style.setProperty("--accent-dim", `color-mix(in srgb, ${V.accent} 22%, transparent)`);
      root.style.setProperty("--accent-faint", `color-mix(in srgb, ${V.accent} 10%, transparent)`);
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-dim");
      root.style.removeProperty("--accent-faint");
    }
    syncBackdrop();
    lookHook?.();
  }

  /* The A2 app mock behind the modal designs; mounted once, reloaded only
   * when the resolved theme changes. */
  let backdropEl = null;
  function syncBackdrop() {
    if (!backdropEl) return;
    const t = resolvedTheme();
    if (backdropEl.dataset.theme === t) return;
    backdropEl.dataset.theme = t;
    backdropEl.src = `../a-rail-address.html?${t}#shot&theme=${t}`;
  }

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------

  let toastSeq = 0;
  function toast(text) {
    const id = ++toastSeq;
    U.toasts.push({ id, text });
    render();
    setTimeout(() => {
      U.toasts = U.toasts.filter((t) => t.id !== id);
      render();
    }, 2400);
  }
  const toasts = () =>
    `<div class="s-toasts">${U.toasts.map((t) => `<div class="s-toast">${esc(t.text)}</div>`).join("")}</div>`;

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  const toggle = (id, on, disabled) =>
    `<button class="s-switch ${on ? "is-on" : ""}" role="switch" aria-checked="${on}" aria-label="${esc(SPEC[id]?.label || id)}" data-toggle="${id}" ${disabled ? "disabled" : ""}><span></span></button>`;

  function seg(id, value, options, extra = "") {
    return `<div class="s-seg ${extra}" role="radiogroup">${options
      .map(
        ([v, l]) =>
          `<button role="radio" aria-checked="${String(value) === v}" class="${String(value) === v ? "is-on" : ""}" data-set="${id}" data-val="${esc(v)}">${l}</button>`,
      )
      .join("")}</div>`;
  }

  function themeCards() {
    const opts = [["system", "Auto"], ["light", "Light"], ["dark", "Dark"]];
    return `<div class="s-themes" role="radiogroup">${opts
      .map(
        ([v, l]) => `<button role="radio" aria-checked="${V.theme === v}" class="s-theme ${V.theme === v ? "is-on" : ""}" data-set="theme" data-val="${v}">
          <span class="s-theme-art t-${v}"><i></i><b></b><b></b><b></b></span><span class="s-theme-label">${l}</span></button>`,
      )
      .join("")}</div>`;
  }

  function accentSwatches() {
    return `<div class="s-swatches" role="radiogroup">${ACCENTS.map(
      ([c, name]) =>
        `<button role="radio" aria-checked="${V.accent === c}" title="${name}" aria-label="${name}" class="s-swatch ${V.accent === c ? "is-on" : ""} ${c ? "" : "is-default"}" style="--sw:${c || "var(--accent-base)"}" data-set="accent" data-val="${c}">${V.accent === c ? icon("check", 11) : ""}</button>`,
    ).join("")}</div>`;
  }

  function sortControl() {
    return `<div class="s-inline">${seg("sort.key", V.sort.key, [["name", "Name"], ["size", "Size"], ["mtime", "Modified"], ["kind", "Kind"]])}
      <button class="s-dir" data-act="sortDir" title="${V.sort.dir === "asc" ? "Ascending" : "Descending"}" aria-label="Sort direction: ${V.sort.dir === "asc" ? "ascending" : "descending"}">${icon(V.sort.dir === "asc" ? "arrowUp" : "arrowDown", 13)}</button></div>`;
  }

  const fmtNum = (n) => n.toLocaleString("en-US");

  function stepper(id) {
    const s = SPEC[id];
    const v = V[id];
    return `<div class="s-stepper"><button data-step="${id}" data-dir="-1" aria-label="Decrease" ${v <= s.min ? "disabled" : ""}>${icon("minus", 12)}</button>
      <input id="num-${id}" class="tnum" data-num="${id}" value="${fmtNum(v)}" style="width:calc(${fmtNum(v).length}ch + 16px)" inputmode="numeric" aria-label="${esc(s.label)}"/><span class="s-unit">${s.unit}</span>
      <button data-step="${id}" data-dir="1" aria-label="Increase" ${v >= s.max ? "disabled" : ""}>${icon("plus", 12)}</button></div>`;
  }

  function capControl() {
    const on = V.fuzzyIndexEntryCap > 0;
    return `<div class="s-inline">${seg("capMode", on ? "on" : "off", [["off", "No limit"], ["on", "Limit"]])}${
      on
        ? `<div class="s-stepper"><button data-step="fuzzyIndexEntryCap" data-dir="-1" aria-label="Decrease">${icon("minus", 12)}</button><input id="num-fuzzyIndexEntryCap" class="tnum" data-num="fuzzyIndexEntryCap" value="${fmtNum(V.fuzzyIndexEntryCap)}" aria-label="Index size limit"/><span class="s-unit">items</span><button data-step="fuzzyIndexEntryCap" data-dir="1" aria-label="Increase">${icon("plus", 12)}</button></div>`
        : ""
    }</div>`;
  }

  function chips() {
    return `<div class="s-chips">${V.fuzzyExcludes
      .map((c, i) => `<span class="s-chip"><span class="mono">${esc(c)}</span><button data-act="chipRemove" data-i="${i}" aria-label="Remove ${esc(c)}">${icon("x", 10)}</button></span>`)
      .join("")}<input id="chip-input" class="s-chip-input mono" placeholder="Add a name or path…" value="${esc(U.chipDraft)}" data-chip-input aria-label="Add an excluded name or path"/></div>`;
  }

  function textField(id) {
    return `<input id="text-${id}" class="s-text" data-text="${id}" value="${esc(V[id])}" placeholder="${esc(SPEC[id].placeholder || "")}" spellcheck="false" aria-label="${esc(SPEC[id].label)}"/>`;
  }

  function favoritesEditor() {
    if (V.favorites.length === 0) return `<div class="s-empty">No pinned folders yet. Drag a folder onto the sidebar to pin it.</div>`;
    return `<div class="s-list">${V.favorites
      .map(
        (f, i) => `<div class="s-list-row ${U.dragFav === i ? "is-dragging" : ""}" draggable="true" data-fav="${i}">
          <span class="s-grip" aria-hidden="true">${icon("grip", 12)}</span>${icon("folder", 13, "s-fold")}
          <span class="s-list-name">${esc(f.name)}</span><span class="s-list-path">${esc(f.path)}</span>
          <button class="s-mini" data-act="favUp" data-i="${i}" aria-label="Move ${esc(f.name)} up" ${i === 0 ? "disabled" : ""}>${icon("chevronUp", 12)}</button>
          <button class="s-mini" data-act="favDown" data-i="${i}" aria-label="Move ${esc(f.name)} down" ${i === V.favorites.length - 1 ? "disabled" : ""}>${icon("chevronDown", 12)}</button>
          <button class="s-mini" data-act="favRemove" data-i="${i}" aria-label="Unpin ${esc(f.name)}">${icon("x", 12)}</button></div>`,
      )
      .join("")}</div><button class="s-add" data-act="favAdd">${icon("plus", 12)}Pin a Folder…</button>`;
  }

  /* Fake sweep forecast so the rules feel concrete. */
  function forecast(rule) {
    const seed = rule.path.length * 7;
    const n = Math.max(0, Math.round((seed + 40) / Math.sqrt(rule.days)) - (V.cleanupSkipOpenedDays * 2));
    const gb = (n * 0.071).toFixed(1);
    return { n, size: n === 0 ? "" : n * 0.071 >= 1 ? `${gb} GB` : `${Math.round(n * 71)} MB` };
  }

  function rulesEditor() {
    const off = !V.cleanupEnabled;
    return `<div class="s-list">${V.cleanupRules
      .map((r, i) => {
        const f = forecast(r);
        const name = r.path.split("/").pop();
        return `<div class="s-list-row s-rule">
          ${icon(name === "Downloads" ? "download" : "folder", 13, "s-fold")}
          <span class="s-list-name">${esc(name)}</span>
          <span class="s-rule-days">after<span class="s-stepper is-small"><button data-act="ruleDays" data-i="${i}" data-dir="-1" aria-label="Fewer days" ${r.days <= 1 ? "disabled" : ""}>${icon("minus", 11)}</button><input id="rule-${i}" class="tnum" data-rule="${i}" value="${r.days}" aria-label="Days before items in ${esc(name)} move to the Trash"/><button data-act="ruleDays" data-i="${i}" data-dir="1" aria-label="More days" ${r.days >= 365 ? "disabled" : ""}>${icon("plus", 11)}</button></span>${r.days === 1 ? "day" : "days"}</span>
          <button class="s-mini" data-act="ruleRemove" data-i="${i}" aria-label="Remove ${esc(name)}">${icon("x", 12)}</button>
          <div class="s-rule-forecast ${off ? "is-off" : ""}">${
            off
              ? "Paused while auto-cleanup is off"
              : f.n === 0
                ? "Nothing due at the next check"
                : `Next check moves ${f.n} item${f.n === 1 ? "" : "s"} (${f.size}) to the Trash · <button class="s-link" data-act="cleanupNow">Run now</button>`
          }</div></div>`;
      })
      .join("")}</div><button class="s-add" data-act="ruleAdd">${icon("plus", 12)}Add a Folder…</button>`;
  }

  function keptList() {
    if (V.kept.length === 0) return `<div class="s-empty">Nothing kept.</div>`;
    return `<div class="s-list">${V.kept
      .map(
        (k, i) => `<div class="s-list-row">${icon("fileText", 13, "s-fold")}<span class="s-list-name">${esc(k.name)}</span><span class="s-list-path">${esc(k.path.replace(/\/[^/]+$/, ""))}</span>
        <button class="s-mini s-mini-text" data-act="unkeep" data-i="${i}">Stop keeping</button></div>`,
      )
      .join("")}</div><button class="s-add s-add-quiet" data-act="clearKept">Stop keeping all ${V.kept.length}</button>`;
  }

  function vimCheats() {
    return `<div class="s-cheats">${VIM_CHEATS.map(([k, w]) => `<kbd>${k}</kbd><span>${w}</span>`).join("")}</div>`;
  }

  function resetControl() {
    const n = totalModified();
    if (U.confirmReset) {
      return `<div class="s-confirm" role="alert">${icon("alert", 14)}<span>Reset ${n} changed setting${n === 1 ? "" : "s"}?</span>
        <button class="s-btn" data-act="cancelReset">Cancel</button><button class="s-btn is-danger" data-act="doReset">Reset</button></div>`;
    }
    return `<button class="s-btn is-danger-quiet" data-act="askReset" ${n === 0 ? "disabled" : ""}>${n === 0 ? "Everything is at its default" : `Reset ${n} changed setting${n === 1 ? "" : "s"}…`}</button>`;
  }

  // ------------------------------------------------------------ shortcuts

  function shortcutCell(c) {
    const b = bindingOf(c.id);
    const rec = U.recording === c.id;
    const cap = U.capture?.id === c.id ? U.capture : null;
    const custom = c.id in V.keys;
    let face;
    if (cap) face = `<kbd class="is-bad">${shortcutLabel(cap.sc)}</kbd>`;
    else if (rec) face = `<span class="s-rec-hint">Press keys…</span>`;
    else face = b ? `<kbd>${shortcutLabel(b)}</kbd>` : `<span class="s-none">None</span>`;
    return `<button class="s-key ${rec ? "is-recording" : ""} ${custom ? "is-custom" : ""}" data-act="record" data-id="${c.id}" aria-label="${rec ? "Recording shortcut for" : "Change shortcut for"} ${esc(c.title)}">${face}</button>`;
  }

  function shortcutRow(c) {
    const custom = c.id in V.keys;
    const cap = U.capture?.id === c.id ? U.capture : null;
    const b = bindingOf(c.id);
    return `<div class="s-cmd ${custom ? "is-custom" : ""}" data-cmd="${c.id}">
      <span class="s-cmd-title">${hl(c.title)}${custom ? `<span class="s-dot" title="Changed"></span>` : ""}</span>
      <span class="s-cmd-acts">
        ${custom ? `<button class="s-mini" data-act="keyReset" data-id="${c.id}" title="Restore ${shortcutLabel(c.sc) || "no shortcut"}" aria-label="Restore default shortcut">${icon("rotate", 12)}</button>` : ""}
        ${b ? `<button class="s-mini" data-act="keyClear" data-id="${c.id}" title="Remove shortcut" aria-label="Remove shortcut">${icon("x", 12)}</button>` : ""}
      </span>
      ${shortcutCell(c)}
      ${
        cap
          ? `<div class="s-conflict" role="alert">${
              cap.vim
                ? `<span><kbd>${esc(cap.sc)}</kbd> belongs to Vim mode while it's on.</span><button class="s-btn" data-act="recordCancel">OK</button>`
                : `<span><b>${shortcutLabel(cap.sc)}</b> already runs “${esc(CMD[cap.conflictWith].title)}”.</span><button class="s-btn" data-act="recordCancel">Cancel</button><button class="s-btn is-primary" data-act="takeover">Move it here</button>`
            }</div>`
          : ""
      }</div>`;
  }

  function shortcutsTable(opts = {}) {
    const q = (opts.query ?? U.keysQuery).trim().toLowerCase();
    const filter = opts.showFilter !== false;
    const changed = Object.keys(V.keys).length;
    const head = filter
      ? `<div class="s-keys-head"><label class="s-field">${icon("search", 12)}<input id="keys-filter" data-keys-filter placeholder="Filter by name or keys" value="${esc(U.keysQuery)}" aria-label="Filter shortcuts"/></label>
        ${changed ? `<button class="s-link" data-act="keysResetAll">Restore ${changed} changed</button>` : ""}</div>`
      : "";
    const groups = COMMANDS.map(([cat]) => {
      const rows = commandMatches(q).filter((c) => c.cat === cat);
      if (rows.length === 0) return "";
      return `<div class="s-keys-group"><div class="s-keys-cat">${cat}</div>${rows.map(shortcutRow).join("")}</div>`;
    }).join("");
    return `<div class="s-keys">${head}${groups || `<div class="s-empty">No commands match.</div>`}</div>`;
  }

  // ------------------------------------------------------------ preview

  const PREVIEW_ROWS = [
    { n: ".config", dir: true, hidden: true, s: "—", d: "Sep 30" },
    { n: "Projects", dir: true, s: "18.2 GB", d: "Today" },
    { n: "Screenshots", dir: true, s: "641 MB", d: "Yesterday" },
    { n: ".zshrc", hidden: true, s: "2 KB", d: "Aug 12" },
    { n: "Budget 2026.numbers", s: "184 KB", d: "Oct 9", t: "sheet" },
    { n: "Notes.md", s: "6 KB", d: "Oct 11", t: "doc" },
    { n: "Trip photo.heic", s: "3.1 MB", d: "Oct 4", t: "img" },
  ];

  function previewRows() {
    let rows = PREVIEW_ROWS.filter((r) => V.showHidden || !r.hidden);
    const k = V.sort.key;
    const val = (r) => (k === "size" ? parseFloat(r.s) || 0 : k === "kind" ? (r.dir ? "0" : r.t || "z") : k === "mtime" ? r.d : r.n.replace(/^\./, ""));
    rows = [...rows].sort((a, b) => (val(a) > val(b) ? 1 : -1) * (V.sort.dir === "asc" ? 1 : -1));
    return rows;
  }

  function fileGlyph(r, size = 14) {
    if (r.dir)
      return `<svg class="gl" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6.5A2.5 2.5 0 0 1 4.5 4h4.2c.7 0 1.3.3 1.8.8L12 6.3h7.5A2.5 2.5 0 0 1 22 8.8v9.7a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5Z" fill="#3f8fd8"/><path d="M2 9.5A1.5 1.5 0 0 1 3.5 8h17A1.5 1.5 0 0 1 22 9.5v9A2.5 2.5 0 0 1 19.5 21h-15A2.5 2.5 0 0 1 2 18.5Z" fill="#5aaef2"/></svg>`;
    const fill = { img: "#e7a33e", sheet: "#3aa676", doc: "#8a94a6" }[r.t] || "#8a94a6";
    return `<svg class="gl" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" fill="var(--gl-page, #f4f5f7)" stroke="rgba(0,0,0,.25)" stroke-width=".8"/><rect x="7" y="13" width="10" height="5" rx="1" fill="${fill}"/></svg>`;
  }

  /* A miniature file list that follows the live settings. */
  function preview(opts = {}) {
    const rows = previewRows();
    const sortName = { name: "Name", size: "Size", mtime: "Modified", kind: "Kind" }[V.sort.key];
    const arrow = V.sort.dir === "asc" ? "↑" : "↓";
    if (V.viewMode === "grid") {
      return `<div class="s-preview is-grid ${opts.cls || ""}" aria-label="Preview">${rows
        .map((r, i) => `<div class="pv-tile ${i === 1 ? "is-sel" : ""} ${r.hidden ? "is-hidden" : ""}">${fileGlyph(r, 30)}<span>${esc(r.n)}</span></div>`)
        .join("")}</div>`;
    }
    const head = `<div class="pv-head"><span class="pv-name">Name${V.sort.key === "name" ? ` ${arrow}` : ""}</span><span class="pv-date">Modified${V.sort.key === "mtime" ? ` ${arrow}` : ""}</span><span class="pv-size">Size${V.sort.key === "size" ? ` ${arrow}` : ""}</span></div>`;
    return `<div class="s-preview ${V.zebraStripes ? "is-zebra" : ""} ${opts.cls || ""}" aria-label="Preview, sorted by ${sortName}">${head}${rows
      .map(
        (r, i) => `<div class="pv-row ${i === 1 ? "is-sel" : ""} ${r.hidden ? "is-hidden" : ""}">${fileGlyph(r)}<span class="pv-name">${esc(r.n)}</span><span class="pv-date">${r.d}</span><span class="pv-size tnum">${r.dir ? (V.showFolderSizes ? `≈ ${r.s}` : "—") : r.s}</span></div>`,
      )
      .join("")}</div>`;
  }

  // ------------------------------------------------------------ rows

  /* Highlight the current search query in a label. */
  function hl(text) {
    const q = U.query.trim();
    const safe = esc(text);
    if (!q) return safe;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return safe;
    return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
  }

  function control(id) {
    const s = SPEC[id];
    const needsOff = s.needs && !V[s.needs];
    switch (s.type) {
      case "toggle": return toggle(id, V[id], needsOff);
      case "seg": return seg(id, V[id], s.options);
      case "theme": return themeCards();
      case "accent": return accentSwatches();
      case "sort": return sortControl();
      case "stepper": return stepper(id);
      case "cap": return capControl();
      case "chips": return chips();
      case "text": return textField(id);
      case "favorites": return favoritesEditor();
      case "rules": return rulesEditor();
      case "kept": return keptList();
      case "vimCheats": return vimCheats();
      case "shortcuts": return shortcutsTable();
      case "reset": return resetControl();
      default: return "";
    }
  }

  /** One setting row: label, hint, changed marker, control. */
  function row(id, opts = {}) {
    const s = SPEC[id];
    if (s.type === "vimCheats" && !V.vimMode) return "";
    const mod = isModified(id) && id !== "keys";
    const needsOff = s.needs && !V[s.needs];
    const hint = opts.hint === false || !s.hint ? "" : `<div class="s-hint">${hl(s.hint)}</div>`;
    const needNote = needsOff && s.type !== "vimCheats" ? `<span class="s-badge">${esc(SPEC[s.needs].label)} only</span>` : "";
    const reset = mod ? `<button class="s-reset" data-reset="${id}" title="Restore default" aria-label="Restore default for ${esc(s.label)}">${icon("rotate", 11)}</button>` : "";
    const label = opts.noLabel ? "" : `<div class="s-label">${hl(s.label)}${needNote}${mod ? `<span class="s-dot" title="Changed from default"></span>` : ""}${reset}</div>`;
    if (s.type === "vimCheats") return `<div class="s-row is-block is-cheats" data-row="${id}">${control(id)}</div>`;
    return `<div class="s-row ${s.block ? "is-block" : ""} ${needsOff ? "is-dim" : ""} s-type-${s.type}" data-row="${id}">
      <div class="s-lab">${label}${hint}</div><div class="s-ctl">${control(id)}</div></div>`;
  }

  /** Default group markup; designs may build their own from SECTIONS. */
  function sectionBody(sectionId, opts = {}) {
    const sec = SECTIONS.find((s) => s.id === sectionId);
    const pv = sec.preview && opts.preview !== false ? `<div class="s-preview-wrap">${preview()}<div class="s-preview-cap">Preview</div></div>` : "";
    return (
      pv +
      sec.groups
        .map((g) => {
          const dim = g.needs && !V[g.needs];
          // A lone block row named like its group drops the repeated label.
          const solo = g.ids.length === 1 && SPEC[g.ids[0]].label === g.title;
          const rows = g.ids.map((id) => row(id, { ...opts, noLabel: solo })).join("");
          if (!rows) return "";
          return `<section class="s-group ${dim ? "is-dim" : ""}" aria-label="${esc(g.title || sec.title)}">${g.title ? `<h3 class="s-group-title">${esc(g.title)}</h3>` : ""}<div class="s-card">${rows}</div></section>`;
        })
        .join("")
    );
  }

  // ------------------------------------------------------------ search

  /** Matching settings and shortcut commands for the global query. */
  function search(query = U.query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const sec of SECTIONS) {
      const ids = [];
      for (const g of sec.groups)
        for (const id of g.ids) {
          const s = SPEC[id];
          if (s.type === "vimCheats") continue;
          if (`${s.label} ${s.hint || ""} ${s.kw || ""} ${sec.title} ${g.title || ""}`.toLowerCase().includes(q)) ids.push(id);
        }
      const cmds = sec.id === "keyboard" ? commandMatches(q).filter((c) => c.title.toLowerCase().includes(q)) : [];
      if (ids.length || cmds.length) out.push({ section: sec, ids: ids.filter((id) => id !== "keys" || cmds.length === 0), cmds });
    }
    return out;
  }

  /** Default search results markup: groups by section, live controls. */
  function searchResults(opts = {}) {
    const res = search();
    if (res.length === 0)
      return `<div class="s-noresults">${icon("search", 22)}<div>No settings match “${esc(U.query.trim())}”</div><div class="s-hint">Try a word like “trash”, “tabs”, or “dark”.</div></div>`;
    return res
      .map(
        ({ section, ids, cmds }) => `<section class="s-group s-result-group">
        <h3 class="s-group-title">${opts.sectionLink ? `<button class="s-link" data-goto="${section.id}">${esc(section.title)}</button>` : esc(section.title)}</h3>
        <div class="s-card">${ids.map((id) => row(id)).join("")}${
          cmds.length
            ? `<div class="s-row is-block"><div class="s-lab"><div class="s-label">Shortcuts</div></div><div class="s-ctl"><div class="s-keys">${cmds.map(shortcutRow).join("")}</div></div></div>`
            : ""
        }</div></section>`,
      )
      .join("");
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const FOLDER_POOL = [
    { path: "~/Desktop/Scans", name: "Scans" },
    { path: "~/Music/Stems", name: "Stems" },
    { path: "~/Pictures/Exports", name: "Exports" },
    { path: "~/Documents/Taxes", name: "Taxes" },
  ];
  const RULE_POOL = ["~/Desktop", "~/Pictures/Screenshots", "~/Movies/Captures"];

  function onAct(act, el) {
    const i = Number(el.dataset.i);
    switch (act) {
      case "sortDir": return set("sort", { ...V.sort, dir: V.sort.dir === "asc" ? "desc" : "asc" });
      case "favUp":
      case "favDown": {
        const f = [...V.favorites];
        const j = act === "favUp" ? i - 1 : i + 1;
        [f[i], f[j]] = [f[j], f[i]];
        return set("favorites", f);
      }
      case "favRemove": {
        const name = V.favorites[i].name;
        set("favorites", V.favorites.filter((_, k) => k !== i));
        return toast(`Unpinned ${name}`);
      }
      case "favAdd": {
        const next = FOLDER_POOL.find((p) => !V.favorites.some((f) => f.path === p.path));
        if (!next) return toast("Every demo folder is pinned");
        set("favorites", [...V.favorites, next]);
        return toast(`Pinned ${next.name}`);
      }
      case "ruleDays": {
        const r = [...V.cleanupRules];
        r[i] = { ...r[i], days: Math.max(1, Math.min(365, r[i].days + Number(el.dataset.dir))) };
        return set("cleanupRules", r);
      }
      case "ruleRemove": return set("cleanupRules", V.cleanupRules.filter((_, k) => k !== i));
      case "ruleAdd": {
        const p = RULE_POOL.find((x) => !V.cleanupRules.some((r) => r.path === x));
        if (!p) return toast("Every demo folder has a rule");
        return set("cleanupRules", [...V.cleanupRules, { path: p, days: 14 }]);
      }
      case "cleanupNow": return toast("Auto-cleanup ran. Moved items are in the Trash.");
      case "unkeep": {
        const name = V.kept[i].name;
        set("kept", V.kept.filter((_, k) => k !== i));
        return toast(`Stopped keeping ${name}`);
      }
      case "clearKept": return set("kept", []);
      case "chipRemove": return set("fuzzyExcludes", V.fuzzyExcludes.filter((_, k) => k !== i));
      case "askReset": U.confirmReset = true; return render();
      case "cancelReset": U.confirmReset = false; return render();
      case "doReset": {
        const keep = { favorites: V.favorites, kept: V.kept };
        Object.assign(V, clone(DEFAULTS), keep);
        U.confirmReset = false;
        save();
        applyLook();
        render();
        return toast("Settings reset to defaults");
      }
      case "record": {
        const id = el.dataset.id;
        U.capture = null;
        U.recording = U.recording === id ? null : id;
        return render();
      }
      case "recordCancel": U.recording = null; U.capture = null; return render();
      case "takeover": {
        const { id, sc, conflictWith } = U.capture;
        const next = { ...V.keys, [conflictWith]: null, [id]: sc };
        if (CMD[id].sc === sc) delete next[id];
        U.recording = null;
        U.capture = null;
        set("keys", next);
        return toast(`${shortcutLabel(sc)} now runs ${CMD[id].title}`);
      }
      case "keyReset": {
        const next = { ...V.keys };
        delete next[el.dataset.id];
        return set("keys", next);
      }
      case "keyClear": return setBinding(el.dataset.id, null);
      case "keysResetAll": return set("keys", {});
    }
  }

  function setFromString(id, raw) {
    if (id === "sort.key") return set("sort", { ...V.sort, key: raw });
    if (id === "capMode") return set("fuzzyIndexEntryCap", raw === "on" ? 500000 : 0);
    const s = SPEC[id];
    set(id, s?.num ? Number(raw) : raw);
  }

  function stepValue(id, dir) {
    if (id === "fuzzyIndexEntryCap") return set(id, Math.max(100000, Math.min(100000000, V[id] + dir * 100000)));
    const s = SPEC[id];
    let v = V[id] + dir * s.step;
    if (id === "searchMaxResults" && dir < 0 && V[id] === s.max) v = 9500;
    set(id, Math.max(s.min, Math.min(s.max, v)));
  }

  function onClick(e) {
    if (design.onClick?.(e) === true) return;
    const t = e.target.closest("[data-toggle],[data-set],[data-step],[data-reset],[data-act],[data-goto]");
    if (!t || t.disabled) return;
    if (t.dataset.goto) {
      U.query = "";
      design.goto?.(t.dataset.goto, t.dataset.row);
      return render();
    }
    if (t.dataset.toggle) return set(t.dataset.toggle, !V[t.dataset.toggle]);
    if (t.dataset.set) return setFromString(t.dataset.set, t.dataset.val);
    if (t.dataset.step) return stepValue(t.dataset.step, Number(t.dataset.dir));
    if (t.dataset.reset) return resetSetting(t.dataset.reset);
    if (t.dataset.act) return onAct(t.dataset.act, t);
  }

  function commitNumber(el) {
    const id = el.dataset.num;
    const s = SPEC[id] || { min: 100000, max: 100000000 };
    const n = Math.round(Number(el.value.replace(/[^\d.]/g, "")));
    if (Number.isFinite(n) && n > 0) set(id, Math.max(s.min, Math.min(s.max, n)));
    else render();
  }

  function onChange(e) {
    const el = e.target;
    if (el.dataset.num) return commitNumber(el);
    if (el.dataset.rule) {
      const i = Number(el.dataset.rule);
      const n = Math.round(Number(el.value));
      const r = [...V.cleanupRules];
      if (Number.isFinite(n) && n >= 1) r[i] = { ...r[i], days: Math.min(365, n) };
      return set("cleanupRules", r);
    }
    if (el.dataset.text) return set(el.dataset.text, el.value.trim());
  }

  function onInput(e) {
    const el = e.target;
    if (el.dataset.keysFilter != null) {
      U.keysQuery = el.value;
      return render();
    }
    if (el.dataset.chipInput != null) {
      U.chipDraft = el.value;
      return;
    }
    if (el.dataset.search != null) {
      U.query = el.value;
      U.confirmReset = false;
      design.onSearch?.(U.query);
      return render();
    }
    design.onInput?.(e);
  }

  function onKey(e) {
    // Recorder: capture everything until a usable combo or Esc.
    if (U.recording) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        U.recording = null;
        U.capture = null;
        return render();
      }
      const sc = shortcutFromEvent(e);
      if (!sc) return;
      const id = U.recording;
      if (V.vimMode && isVimReserved(sc)) {
        U.capture = { id, sc, vim: true };
        return render();
      }
      const clash = conflictFor(id, sc);
      if (clash) {
        U.capture = { id, sc, conflictWith: clash };
        return render();
      }
      U.recording = null;
      U.capture = null;
      setBinding(id, sc);
      return toast(`${CMD[id].title}: ${shortcutLabel(sc)}`);
    }
    const el = e.target;
    if (el.dataset?.chipInput != null) {
      if (e.key === "Enter" && el.value.trim()) {
        const v = el.value.trim();
        U.chipDraft = "";
        if (!V.fuzzyExcludes.includes(v)) set("fuzzyExcludes", [...V.fuzzyExcludes, v]);
        else render();
        return;
      }
      if (e.key === "Backspace" && el.value === "" && V.fuzzyExcludes.length) {
        return set("fuzzyExcludes", V.fuzzyExcludes.slice(0, -1));
      }
    }
    if (e.key === "Enter" && (el.dataset?.num || el.dataset?.rule || el.dataset?.text)) {
      el.blur();
      return;
    }
    if (design.onKey?.(e) === true) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (U.confirmReset) {
        U.confirmReset = false;
        return render();
      }
      if (U.query) {
        U.query = "";
        design.onSearch?.("");
        return render();
      }
      if (U.open) {
        U.open = false;
        return render();
      }
    }
    if (e.key === "," && e.metaKey) {
      e.preventDefault();
      U.open = !U.open;
      return render();
    }
    if (e.key === "f" && e.metaKey && U.open) {
      const f = document.querySelector("[data-search]");
      if (f) {
        e.preventDefault();
        f.focus();
        f.select();
      }
    }
  }

  // Pinned folders: drag to reorder.
  function onDragStart(e) {
    const r = e.target.closest?.("[data-fav]");
    if (!r) return;
    U.dragFav = Number(r.dataset.fav);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", r.dataset.fav);
  }
  function onDragOver(e) {
    if (U.dragFav == null) return;
    const r = e.target.closest?.("[data-fav]");
    if (!r) return;
    e.preventDefault();
    const to = Number(r.dataset.fav);
    if (to === U.dragFav) return;
    const f = [...V.favorites];
    const [it] = f.splice(U.dragFav, 1);
    f.splice(to, 0, it);
    U.dragFav = to;
    set("favorites", f);
  }
  function onDragEnd() {
    U.dragFav = null;
    render();
  }

  // -------------------------------------------------------------------------
  // Harness + render loop
  // -------------------------------------------------------------------------

  const DESIGNS = [
    ["a-sheet.html", "A · Sheet"],
    ["b-tab.html", "B · Tab"],
    ["c-page.html", "C · Page"],
    ["d-panel.html", "D · Panel"],
  ];

  function harness() {
    const here = location.pathname.split("/").pop();
    return `<a class="h-home" href="index.html">Fazi settings</a><nav class="h-designs">${DESIGNS.map(
      ([f, l]) => `<a href="${f}" class="${here === f ? "is-on" : ""}">${l}</a>`,
    ).join("")}</nav><span class="h-grow"></span>
      <span class="h-note">${totalModified()} changed</span>
      <button data-act-h="theme">${icon(resolvedTheme() === "dark" ? "sun" : "moon", 13)}${resolvedTheme() === "dark" ? "Light" : "Dark"}</button>
      <button data-act-h="open">${U.open ? "Close settings" : "Open settings"} <kbd>⌘,</kbd></button>
      <button data-act-h="wipe" title="Clear the demo's saved settings">Reset demo</button>`;
  }

  let design = null;
  let root = null;
  let bar = null;

  function render() {
    if (!design) return;
    const scroll = {};
    root.querySelectorAll("[data-scroll-key]").forEach((el) => (scroll[el.dataset.scrollKey] = el.scrollTop));
    const active = document.activeElement;
    const focusId = active?.id;
    const caret = focusId && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
    const focusAct = !focusId && active?.dataset ? Object.entries(active.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}="${CSS.escape(v)}"]`).join("") : "";

    root.innerHTML = design.render(api) + toasts();
    bar.innerHTML = harness();

    root.querySelectorAll("[data-scroll-key]").forEach((el) => {
      if (scroll[el.dataset.scrollKey] != null) el.scrollTop = scroll[el.dataset.scrollKey];
    });
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && el.setSelectionRange) try { el.setSelectionRange(caret[0], caret[1]); } catch {}
      }
    } else if (focusAct) {
      try {
        root.querySelector(focusAct)?.focus({ preventScroll: true });
      } catch {}
    }
    design.afterRender?.(api);
  }

  function onHarness(e) {
    const b = e.target.closest("[data-act-h]");
    if (!b) return;
    const a = b.dataset.actH;
    if (a === "theme") {
      const next = resolvedTheme() === "dark" ? "light" : "dark";
      if (V.theme !== "system") return set("theme", next);
      systemTheme = next;
      applyLook();
      render();
    }
    if (a === "open") {
      U.open = !U.open;
      render();
    }
    if (a === "wipe") {
      localStorage.removeItem(KEY);
      location.reload();
    }
  }

  function mount(d) {
    design = d;
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<header class="harness" id="harness"></header><main class="stage">${d.backdrop ? `<iframe class="s-backdrop" tabindex="-1" aria-hidden="true"></iframe>` : ""}<div class="s-root" id="s-root"></div></main>`,
    );
    root = document.getElementById("s-root");
    backdropEl = document.querySelector(".s-backdrop");
    bar = document.getElementById("harness");
    bar.addEventListener("click", onHarness);
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("shot")) document.body.classList.add("shot");
    if (params.has("theme")) systemTheme = params.get("theme");
    if (params.has("vim")) V.vimMode = true;
    if (params.has("q")) U.query = params.get("q");
    if (params.has("record")) U.recording = params.get("record");
    if (params.has("closed")) U.open = false;
    if (params.has("sidebar")) V.sidebarPosition = params.get("sidebar");
    if (params.has("conflict")) {
      // e.g. #conflict=newFolder:cmd+d shows the blocked-capture state.
      const [id, sc] = params.get("conflict").split(":");
      U.capture = { id, sc, conflictWith: conflictFor(id, sc) };
    }
    lookHook = () => d.onLook?.(api);
    d.init?.(api, params);
    applyLook();
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    root.addEventListener("input", onInput);
    root.addEventListener("dragstart", onDragStart);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragend", onDragEnd);
    root.addEventListener("focusout", (e) => {
      if (e.target.dataset?.num && document.contains(e.target)) commitNumber(e.target);
    });
    document.addEventListener("keydown", onKey, true);
    render();
  }

  const api = {
    V, U, SPEC, SECTIONS, SECTION_OF, COMMANDS, CMD, DEFAULTS,
    icon, esc, hl, row, control, sectionBody, searchResults, search, preview, shortcutsTable,
    themeCards, accentSwatches, seg, toggle, resolvedTheme, isModified, modifiedIn,
    totalModified, shortcutLabel, bindingOf, set, toast, render, fileGlyph, previewRows,
  };

  return { mount, ...api };
})();
