/*
 * Fazi mockup engine. Every design page shares this file: the fake
 * filesystem, the state model, every action, the keyboard map, and the
 * renderers for surfaces that look the same in each design (file list,
 * grid, search results, banners, Get Info, overlays). A design supplies
 * only its layout function and stylesheet, so behavior is identical by
 * construction.
 *
 * Plain script (no modules) so the pages open straight from disk.
 */
window.Fazi = (() => {
  "use strict";

  // -------------------------------------------------------------------------
  // Icons (lucide geometry, 24×24, stroke = currentColor)
  // -------------------------------------------------------------------------

  const ICONS = {
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    house:
      '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    monitor:
      '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    fileText:
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    apps:
      '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    list:
      '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
    grid:
      '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    hardDrive:
      '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
    database:
      '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronUp: '<path d="m18 15-6-6-6 6"/>',
    arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    ellipsis:
      '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    hourglass:
      '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
    sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    sidebarRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eject: '<path d="M5 14h14L12 5z"/><path d="M5 19h14"/>',
    command:
      '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    panelCollapse: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
    panelExpand: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
    star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  };

  function icon(name, size = 14, cls = "") {
    return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  /** Filled Finder-style glyph for an entry (folder, document, image…). */
  function glyph(entry, size = 16) {
    const t = entry.dir ? (entry.app ? "app" : "folder") : entry.type || "doc";
    if (t === "folder") {
      return `<svg class="gl" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6.5A2.5 2.5 0 0 1 4.5 4h4.2c.7 0 1.3.3 1.8.8L12 6.3h7.5A2.5 2.5 0 0 1 22 8.8v9.7a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5Z" fill="var(--gl-folder-back)"/><path d="M2 9.5A1.5 1.5 0 0 1 3.5 8h17A1.5 1.5 0 0 1 22 9.5v9A2.5 2.5 0 0 1 19.5 21h-15A2.5 2.5 0 0 1 2 18.5Z" fill="var(--gl-folder)"/></svg>`;
    }
    if (t === "app") {
      return `<svg class="gl" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="${entry.tint || "#6b7cff"}"/><path d="M8 15.5 12 7l4 8.5M9.3 13h5.4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    const band = {
      pdf: "#e5534b",
      image: "#3fa66b",
      code: "#8a63d2",
      data: "#d4a72c",
      archive: "#8c8f96",
      text: "#7d8590",
      doc: "#4f8ef7",
      disk: "#8c8f96",
      sheet: "#2f9e5b",
      slides: "#e0812f",
    }[t] || "#7d8590";
    const label = size >= 40 ? (entry.ext || "").toUpperCase().slice(0, 4) : "";
    return `<svg class="gl" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 2h9L20 7.5v13A1.5 1.5 0 0 1 18.5 22h-13A1.5 1.5 0 0 1 4 20.5v-17A1.5 1.5 0 0 1 5.5 2Z" fill="var(--gl-page)" stroke="var(--gl-page-edge)" stroke-width=".6"/><path d="M14.5 2v4A1.5 1.5 0 0 0 16 7.5h4" fill="var(--gl-page-fold)" stroke="var(--gl-page-edge)" stroke-width=".6"/>${
      size >= 40
        ? `<rect x="4" y="14.5" width="16" height="5" fill="${band}"/><text x="12" y="18.4" text-anchor="middle" font-size="3.6" font-weight="700" fill="#fff" font-family="-apple-system,system-ui">${label}</text>`
        : `<rect x="7" y="13" width="10" height="2.4" rx=".6" fill="${band}"/>`
    }</svg>`;
  }

  // -------------------------------------------------------------------------
  // Fake filesystem
  // -------------------------------------------------------------------------

  const HOME = "/Users/pascal";
  const NOW = new Date(2026, 9, 3, 10, 12).getTime(); // Sat 3 Oct 2026, 10:12
  const DAY = 86_400_000;
  const ago = (days, h = 0, m = 0) => NOW - days * DAY - h * 3_600_000 - m * 60_000;

  const KINDS = {
    pdf: ["PDF Document", "pdf"],
    png: ["PNG Image", "image"],
    jpg: ["JPEG Image", "image"],
    heic: ["HEIC Image", "image"],
    svg: ["SVG Image", "image"],
    ts: ["TS Source", "code"],
    tsx: ["TSX Source", "code"],
    rs: ["Rust Source", "code"],
    json: ["JSON Source", "data"],
    md: ["Markdown Document", "text"],
    txt: ["Plain Text", "text"],
    zip: ["ZIP Archive", "archive"],
    tar: ["Tar Archive", "archive"],
    dmg: ["Disk Image", "disk"],
    pkg: ["Installer Package", "disk"],
    xlsx: ["Excel Workbook", "sheet"],
    key: ["Keynote Presentation", "slides"],
    pages: ["Pages Document", "doc"],
    docx: ["Word Document", "doc"],
    mov: ["QuickTime Movie", "image"],
    sketch: ["Sketch Document", "doc"],
  };

  function file(name, size, mod, extra = {}) {
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const [kind, type] = KINDS[ext] || ["Document", "doc"];
    return { name, dir: false, kind, type, ext, size, mod, tags: [], ...extra };
  }
  function dir(name, mod, extra = {}) {
    return { name, dir: true, kind: "Folder", size: null, mod, tags: [], ...extra };
  }
  function app(name, size, mod, tint) {
    return { name, dir: true, app: true, kind: "Application", size, mod, tags: [], tint };
  }

  const SHOW = `${HOME}/Projects/fileManager/Tazi/Fazi Showcase`;

  const FS = {
    "/": [dir("Applications", ago(2)), dir("Library", ago(40)), dir("System", ago(90)), dir("Users", ago(120))],
    "/Users": [dir("pascal", ago(0, 1)), dir("Shared", ago(200))],
    [HOME]: [
      dir("Applications", ago(30)),
      dir("Desktop", ago(0, 2)),
      dir("Documents", ago(1, 4)),
      dir("Downloads", ago(0, 0, 40)),
      dir("Movies", ago(60)),
      dir("Music", ago(80)),
      dir("Pictures", ago(5)),
      dir("Projects", ago(0, 3)),
      dir(".config", ago(14), { hidden: true }),
      file(".zshrc", 2_310, ago(9), { hidden: true }),
    ],
    [`${HOME}/Desktop`]: [
      dir("Moodboard", ago(3)),
      file("Screenshot 2026-09-30 at 10.42.png", 1_840_000, ago(3, 0, 30)),
      file("invoice-0932.pdf", 88_400, ago(1, 2)),
      file("todo.txt", 640, ago(0, 1, 5)),
    ],
    [`${HOME}/Desktop/Moodboard`]: [
      file("palette-studies.png", 3_200_000, ago(3)),
      file("type-specimen.pdf", 940_000, ago(4)),
    ],
    [`${HOME}/Documents`]: [
      dir("Contracts", ago(12)),
      dir("Taxes 2025", ago(70)),
      file("Résumé.pages", 412_000, ago(22)),
      file("Notes.md", 9_800, ago(0, 5)),
      file("Budget 2026.xlsx", 156_000, ago(6), { tags: [2] }),
    ],
    [`${HOME}/Documents/Contracts`]: [file("Studio lease.pdf", 1_220_000, ago(40)), file("NDA – Northwind.pdf", 210_000, ago(12))],
    [`${HOME}/Documents/Taxes 2025`]: [],
    [`${HOME}/Downloads`]: [
      dir("Keep", ago(30)),
      dir("fonts", ago(2)),
      file("Fazi_0.6.0_aarch64.dmg", 9_400_000, ago(13, 2), { added: ago(13, 2) }),
      file("IMG_4411.HEIC", 2_700_000, ago(13, 5), { added: ago(13, 5) }),
      file("node-v24.9.0.pkg", 74_000_000, ago(13, 8), { added: ago(13, 8) }),
      file("figma-export.zip", 18_300_000, ago(10), { added: ago(10) }),
      file("quarterly-report.xlsx", 340_000, ago(5), { added: ago(5) }),
      file("boarding-pass.pdf", 120_000, ago(0, 3), { added: ago(0, 3) }),
    ],
    [`${HOME}/Downloads/Keep`]: [file("passport-scan.pdf", 2_100_000, ago(30))],
    [`${HOME}/Downloads/fonts`]: [file("Inter.zip", 4_800_000, ago(2))],
    [`${HOME}/Movies`]: [file("standup-recording.mov", 412_000_000, ago(60))],
    [`${HOME}/Music`]: [],
    [`${HOME}/Pictures`]: [
      file("Coastal Survey.png", 3_500_000, ago(5)),
      file("Studio Notes.png", 2_900_000, ago(5)),
      file("IMG_2210.jpg", 4_100_000, ago(19)),
    ],
    [`${HOME}/Projects`]: [
      dir("Fazi", ago(0, 1)),
      dir("fileManager", ago(0, 3)),
      dir("website", ago(8)),
      dir("dotfiles", ago(31)),
    ],
    [`${HOME}/Projects/Fazi`]: [
      dir("src", ago(0, 1)),
      dir("src-tauri", ago(0, 2)),
      dir("docs", ago(1)),
      file("package.json", 1_120, ago(2)),
      file("README.md", 7_400, ago(1)),
    ],
    [`${HOME}/Projects/Fazi/src`]: [file("App.tsx", 6_300, ago(0, 1)), file("styles.css", 11_200, ago(1)), file("main.tsx", 420, ago(30))],
    [`${HOME}/Projects/Fazi/src-tauri`]: [file("Cargo.toml", 1_900, ago(4)), file("lib.rs", 8_800, ago(0, 2))],
    [`${HOME}/Projects/Fazi/docs`]: [file("ROADMAP.md", 12_000, ago(1)), file("ARCHITECTURE.md", 21_000, ago(9))],
    [`${HOME}/Projects/fileManager`]: [dir("Tazi", ago(0, 3)), file("README.md", 3_100, ago(20))],
    [`${HOME}/Projects/fileManager/Tazi`]: [dir("Fazi Showcase", ago(0, 3)), file("notes.txt", 1_400, ago(3))],
    [SHOW]: [
      dir("Photos", ago(86)),
      dir("Client Assets", ago(82)),
      dir("Projects", ago(83)),
      dir("Invoices", ago(87)),
      dir("Archive", ago(90)),
      file("Release Checklist.pdf", 55_700, ago(84), { tags: [2] }),
      file("sync-engine.ts", 21_200, ago(88)),
      file("build-config.json", 1_600, ago(85)),
      file("Q2 Product Brief.pdf", 33_900, ago(1, 0, 25), { tags: [4] }),
      file("Launch Notes.txt", 4_500, ago(89)),
    ],
    [`${SHOW}/Photos`]: [file("Coastal Survey.png", 3_500_000, ago(0, 0, 13)), file("Studio Notes.png", 2_900_000, ago(0, 0, 13))],
    [`${SHOW}/Client Assets`]: [file("logo-final.svg", 14_000, ago(82)), file("brand-guide.pdf", 6_200_000, ago(82))],
    [`${SHOW}/Projects`]: [file("Architecture Notes.md", 8_200, ago(0, 0, 13)), file("Product Roadmap.md", 6_700, ago(0, 0, 13))],
    [`${SHOW}/Invoices`]: [file("INV-2026-031.pdf", 74_000, ago(87)), file("INV-2026-032.pdf", 71_000, ago(60))],
    [`${SHOW}/Archive`]: [],
    [`${HOME}/Projects/website`]: [file("index.html", 9_100, ago(8)), file("site.css", 4_400, ago(8))],
    [`${HOME}/Projects/dotfiles`]: [file("install.sh", 2_000, ago(31))],
    [`${HOME}/.Trash`]: [
      dir("Untitled folder", ago(4)),
      file("old-logo.svg", 12_000, ago(6)),
      file("draft v2.key", 8_800_000, ago(9)),
      file("Screenshot 2026-09-12.png", 1_200_000, ago(21)),
    ],
    "/Applications": [
      app("Fazi.app", 31_000_000, ago(2), "#7b6cf6"),
      app("Figma.app", 410_000_000, ago(9), "#e8613c"),
      app("Safari.app", 14_000_000, ago(40), "#2f8cf0"),
      app("Notes.app", 22_000_000, ago(40), "#e9b730"),
      app("Xcode.app", 11_000_000_000, ago(25), "#1d7af2"),
    ],
    "/Library": [],
    "/System": [],
    "/Users/Shared": [],
    "/Volumes/Disk-D": [dir("Backups", ago(15)), dir("footage", ago(44)), file("archive.tar", 2_400_000_000, ago(44))],
    "/Volumes/Disk-D/Backups": [],
    "/Volumes/Disk-D/footage": [],
    [`${HOME}/.config`]: [],
  };

  const FOLDERS = {
    home: HOME,
    desktop: `${HOME}/Desktop`,
    documents: `${HOME}/Documents`,
    downloads: `${HOME}/Downloads`,
    applications: "/Applications",
    trash: `${HOME}/.Trash`,
  };
  const FAVORITES = [
    { name: "Projects", path: `${HOME}/Projects` },
    { name: "Fazi Showcase", path: SHOW },
  ];
  const VOLUMES = [
    { name: "Macintosh HD", path: "/", root: true, free: 182_000_000_000 },
    { name: "Disk-D", path: "/Volumes/Disk-D", ejectable: true, free: 640_000_000_000 },
  ];
  const CLEANUP = { folder: FOLDERS.downloads, days: 14 };

  const TAGS = {
    1: ["Gray", "#9a9aa0"],
    2: ["Green", "#3fb950"],
    3: ["Purple", "#a371f7"],
    4: ["Blue", "#4f8ef7"],
    5: ["Yellow", "#e3b341"],
    6: ["Red", "#f85149"],
    7: ["Orange", "#f0883e"],
  };

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const basename = (p) => (p === "/" ? "Macintosh HD" : p.split("/").filter(Boolean).pop() || "/");
  const dirname = (p) => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  };
  const join = (d, n) => (d === "/" ? `/${n}` : `${d}/${n}`);
  const tilde = (p) => (p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);

  function bytes(n) {
    if (n == null) return "--";
    if (n < 1000) return `${n} bytes`;
    const u = ["KB", "MB", "GB", "TB"];
    let v = n / 1000;
    let i = 0;
    while (v >= 1000 && i < u.length - 1) {
      v /= 1000;
      i++;
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true });
  const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
  function when(ts) {
    const d = new Date(ts);
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    if (ts >= today.getTime()) return `Today at ${timeFmt.format(d)}`;
    if (ts >= today.getTime() - DAY) return `Yesterday at ${timeFmt.format(d)}`;
    return dateFmt.format(d);
  }
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

  const KEYSYM = { cmd: "⌘", shift: "⇧", opt: "⌥", ctrl: "⌃", enter: "↩", delete: "⌫", tab: "⇥", escape: "⎋", up: "↑", down: "↓", left: "←", right: "→", space: "Space" };
  function kbd(spec) {
    if (!spec) return "";
    const parts = spec.split("+");
    const key = parts.pop();
    const order = ["ctrl", "opt", "shift", "cmd"];
    const mods = order.filter((m) => parts.includes(m)).map((m) => KEYSYM[m]).join("");
    return mods + (KEYSYM[key] || key.toUpperCase());
  }

  // -------------------------------------------------------------------------
  // Cleanup model (Downloads, 14 days from Date Added)
  // -------------------------------------------------------------------------

  function cleanupInfo(entry, path) {
    if (dirname(path) !== CLEANUP.folder || entry.added == null || !S.cleanupOn) return null;
    if (S.kept.has(path)) return { kept: true, label: "Kept", tone: "kept" };
    const left = Math.ceil((entry.added + CLEANUP.days * DAY - NOW) / DAY);
    if (left <= 1) return { left, label: "Tomorrow", tone: "due" };
    return { left, label: `In ${left} days`, tone: left <= 4 ? "soon" : "later" };
  }
  function leavingSoon() {
    return (FS[CLEANUP.folder] || []).filter((e) => {
      const c = cleanupInfo(e, join(CLEANUP.folder, e.name));
      return c && c.tone === "due";
    });
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let tabSeq = 0;
  function mkTab(path) {
    return { id: `t${++tabSeq}`, path, back: [], forward: [], sel: new Set(), lead: null, filter: "", sort: { key: "name", dir: "asc" } };
  }

  const S = {
    theme: "dark",
    split: false,
    activePane: "left",
    panes: {
      left: { tabs: [mkTab(SHOW), mkTab(`${HOME}/Projects`), mkTab(`${HOME}/Pictures`), mkTab(`${SHOW}/Projects`)], active: null },
      right: { tabs: [mkTab(`${SHOW}/Photos`)], active: null },
    },
    view: "list",
    sidebar: true,
    info: false,
    hidden: false,
    vim: localStorage.getItem("fazi-mock-vim") !== "off",
    vimMode: "normal",
    vimPending: "",
    fda: false,
    cleanupOn: true,
    cleanupDismissed: false,
    kept: new Set(),
    search: { active: false, query: "", scope: "folder", contents: false },
    filterFocused: false,
    pathEdit: null,
    overlay: null,
    menu: null,
    toasts: [],
    ops: [],
    loading: null,
    ui: {},
  };
  S.panes.left.active = S.panes.left.tabs[0].id;
  S.panes.right.active = S.panes.right.tabs[0].id;
  {
    // Recreate the README screenshot: four selected in the showcase tab.
    const t = S.panes.left.tabs[0];
    ["Release Checklist.pdf", "sync-engine.ts", "build-config.json", "Q2 Product Brief.pdf"].forEach((n) => t.sel.add(n));
    t.lead = "Q2 Product Brief.pdf";
  }

  const pane = (id) => S.panes[id];
  const tabOf = (id) => {
    const p = pane(id);
    return p.tabs.find((t) => t.id === p.active) || p.tabs[0];
  };
  const activeTab = () => tabOf(S.activePane);

  function sortEntries(list, sort) {
    const key = sort.key;
    const mul = sort.dir === "asc" ? 1 : -1;
    const cmp = (a, b) => {
      let r = 0;
      if (key === "name") r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      else if (key === "kind") r = a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
      else if (key === "size") r = (a.size ?? -1) - (b.size ?? -1);
      else if (key === "date") r = a.mod - b.mod;
      return r * mul;
    };
    // Finder keeps folders first only when sorting by name.
    return [...list].sort((a, b) => (key === "name" && a.dir !== b.dir && !a.app && !b.app ? (a.dir ? -1 : 1) : cmp(a, b)));
  }

  function visible(tab) {
    const all = FS[tab.path] || [];
    const f = tab.filter.trim().toLowerCase();
    return sortEntries(
      all.filter((e) => (S.hidden || !e.hidden) && (f === "" || e.name.toLowerCase().includes(f))),
      tab.sort,
    );
  }

  /** Two tabs in one pane with the same name get their parent as a hint. */
  function tabHints(p) {
    const counts = {};
    p.tabs.forEach((t) => (counts[basename(t.path)] = (counts[basename(t.path)] || 0) + 1));
    return p.tabs.map((t) => (counts[basename(t.path)] > 1 ? basename(dirname(t.path)) : ""));
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  let toastSeq = 0;
  function toast(message, opts = {}) {
    const id = ++toastSeq;
    S.toasts.push({ id, message, ...opts });
    if (!opts.sticky) setTimeout(() => {
      S.toasts = S.toasts.filter((t) => t.id !== id);
      render();
    }, 3600);
  }

  function flashLoading() {
    S.loading = Date.now();
    const at = S.loading;
    setTimeout(() => {
      if (S.loading === at) {
        S.loading = null;
        render();
      }
    }, 260);
  }

  function navigate(paneId, path, opts = {}) {
    if (!(path in FS)) {
      toast(`The folder “${basename(path)}” can't be found.`);
      return;
    }
    const tab = tabOf(paneId);
    if (tab.path === path && !opts.select) return;
    if (!opts.history) {
      tab.back.push(tab.path);
      tab.forward = [];
    }
    tab.path = path;
    tab.sel = new Set(opts.select ? [opts.select] : []);
    tab.lead = opts.select || null;
    tab.filter = "";
    S.search.active = false;
    S.activePane = paneId;
    flashLoading();
  }

  function openEntry(paneId, name) {
    const tab = tabOf(paneId);
    const entry = (FS[tab.path] || []).find((e) => e.name === name);
    if (!entry) return;
    if (entry.dir && !entry.app) navigate(paneId, join(tab.path, name));
    else toast(`Opened “${name}”`);
  }

  function openTab(paneId, path) {
    const p = pane(paneId);
    const t = mkTab(path);
    const at = p.tabs.findIndex((x) => x.id === p.active);
    p.tabs.splice(at + 1, 0, t);
    p.active = t.id;
    S.activePane = paneId;
  }

  function closeTab(paneId, id) {
    const p = pane(paneId);
    if (p.tabs.length === 1) {
      if (paneId === "right" || S.split) {
        S.split = false;
        S.activePane = "left";
      }
      return;
    }
    const i = p.tabs.findIndex((t) => t.id === id);
    p.tabs.splice(i, 1);
    if (p.active === id) p.active = p.tabs[Math.min(i, p.tabs.length - 1)].id;
  }

  function cycleTab(delta) {
    const p = pane(S.activePane);
    const i = p.tabs.findIndex((t) => t.id === p.active);
    p.active = p.tabs[(i + delta + p.tabs.length) % p.tabs.length].id;
  }

  function moveSel(delta, extend) {
    const tab = activeTab();
    const list = visible(tab);
    if (list.length === 0) return;
    const i = list.findIndex((e) => e.name === tab.lead);
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + delta))];
    if (extend || S.vimMode === "visual") tab.sel.add(next.name);
    else tab.sel = new Set([next.name]);
    tab.lead = next.name;
    requestAnimationFrame(() => document.querySelector(`[data-pane="${S.activePane}"] [data-row="${CSS.escape(next.name)}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  function selectRow(paneId, name, e) {
    const tab = tabOf(paneId);
    S.activePane = paneId;
    if (e.metaKey) {
      if (tab.sel.has(name)) tab.sel.delete(name);
      else tab.sel.add(name);
      tab.lead = name;
    } else if (e.shiftKey && tab.lead) {
      const list = visible(tab).map((x) => x.name);
      const a = list.indexOf(tab.lead);
      const b = list.indexOf(name);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      tab.sel = new Set(list.slice(lo, hi + 1));
    } else {
      tab.sel = new Set([name]);
      tab.lead = name;
    }
  }

  function allPaths() {
    const out = [];
    for (const [d, list] of Object.entries(FS)) for (const e of list) out.push({ ...e, path: join(d, e.name), parent: d });
    return out;
  }

  function searchHits() {
    const q = S.search.query.trim().toLowerCase();
    if (q === "") return [];
    const scopeRoot = S.search.scope === "folder" ? activeTab().path : S.search.scope === "home" ? HOME : "/";
    return allPaths()
      .filter((e) => (e.parent === scopeRoot || e.parent.startsWith(scopeRoot === "/" ? "/" : scopeRoot + "/")) && !e.hidden)
      .filter((e) => e.name.toLowerCase().includes(q) || (S.search.contents && !e.dir && e.kind.toLowerCase().includes(q)))
      .slice(0, 200);
  }

  function fuzzyScore(name, q) {
    let i = 0;
    let score = 0;
    let last = -2;
    const n = name.toLowerCase();
    for (const ch of q.toLowerCase()) {
      const at = n.indexOf(ch, i);
      if (at < 0) return -1;
      score += at === last + 1 ? 3 : 1;
      last = at;
      i = at + 1;
    }
    return score - n.length * 0.01;
  }

  function startOp() {
    const id = Date.now();
    const op = { id, label: "Copying 3 items to “Disk-D”", done: 0, total: 2_480_000_000, rate: 0, current: "standup-recording.mov", status: "running" };
    S.ops.push(op);
    const tick = setInterval(() => {
      if (op.status !== "running") return clearInterval(tick);
      op.rate = 380_000_000 + Math.random() * 40_000_000;
      op.done = Math.min(op.total, op.done + op.rate / 5);
      if (op.done >= op.total) {
        op.status = "done";
        op.label = "Copied 3 items to “Disk-D”";
        clearInterval(tick);
        setTimeout(() => {
          S.ops = S.ops.filter((o) => o.id !== id);
          render();
        }, 4000);
      }
      render();
    }, 200);
  }

  const COMMANDS = [
    { id: "newTab", title: "New Tab", sc: "cmd+t", run: () => openTab(S.activePane, activeTab().path) },
    { id: "closeTab", title: "Close Tab", sc: "cmd+w", run: () => closeTab(S.activePane, activeTab().id) },
    { id: "nextTab", title: "Next Tab", sc: "ctrl+tab", run: () => cycleTab(1) },
    { id: "prevTab", title: "Previous Tab", sc: "ctrl+shift+tab", run: () => cycleTab(-1) },
    { id: "dualPane", title: "Toggle Dual Pane", sc: "cmd+shift+d", run: () => toggleSplit() },
    { id: "swapPane", title: "Switch Pane", sc: "tab", run: () => S.split && (S.activePane = S.activePane === "left" ? "right" : "left") },
    { id: "toggleSidebar", title: "Toggle Sidebar", sc: "cmd+opt+s", run: () => (S.sidebar = !S.sidebar) },
    { id: "viewList", title: "View as List", sc: "cmd+1", run: () => (S.view = "list") },
    { id: "viewGrid", title: "View as Icons", sc: "cmd+2", run: () => (S.view = "grid") },
    { id: "getInfo", title: "Get Info", sc: "cmd+i", run: () => (S.info = !S.info) },
    { id: "toggleHidden", title: "Show Hidden Files", sc: "cmd+shift+.", run: () => (S.hidden = !S.hidden) },
    { id: "focusSearch", title: "Filter This Folder", sc: "cmd+f", run: () => focusFilter() },
    { id: "globalSearch", title: "Search Everywhere", sc: "cmd+shift+f", run: () => ((S.search.active = true), (S.search.scope = "home"), focusFilter()) },
    { id: "fuzzyFinder", title: "Go to File…", sc: "cmd+p", run: () => openOverlay("fuzzy") },
    { id: "openLocation", title: "Go to Folder…", sc: "cmd+shift+g", run: () => (S.pathEdit = S.activePane) },
    { id: "back", title: "Back", sc: "cmd+[", run: () => back(S.activePane) },
    { id: "forward", title: "Forward", sc: "cmd+]", run: () => forward(S.activePane) },
    { id: "up", title: "Enclosing Folder", sc: "cmd+up", run: () => up(S.activePane) },
    { id: "goHome", title: "Go to Home", sc: "cmd+shift+h", run: () => navigate(S.activePane, HOME) },
    { id: "goDownloads", title: "Go to Downloads", sc: "cmd+opt+l", run: () => navigate(S.activePane, FOLDERS.downloads) },
    { id: "goApplications", title: "Go to Applications", sc: "cmd+shift+a", run: () => navigate(S.activePane, FOLDERS.applications) },
    { id: "newFolder", title: "New Folder", sc: "cmd+shift+n", run: () => toast("Created “untitled folder”") },
    { id: "batchRename", title: "Rename Items…", sc: "cmd+shift+r", run: () => toast("Batch rename opens here") },
    { id: "trash", title: "Move to Trash", sc: "cmd+delete", run: () => trashSelection() },
    { id: "keep", title: "Keep (Skip Auto-Cleanup)", sc: "cmd+opt+k", run: () => keepSelection() },
    { id: "copy", title: "Copy", sc: "cmd+c", run: () => toast(`Copied ${plural(activeTab().sel.size, "item")}`) },
    { id: "copyOp", title: "Copy to Disk-D (demo progress)", run: () => startOp() },
    { id: "preview", title: "Quick Look", sc: "space", run: () => openOverlay("preview") },
    { id: "vim", title: "Toggle Vim Mode", run: () => toggleVim() },
    { id: "vimHelp", title: "Vim Cheat Sheet", sc: "g ?", run: () => openOverlay("vimhelp") },
    { id: "theme", title: "Toggle Light/Dark", run: () => setTheme(S.theme === "dark" ? "light" : "dark") },
    { id: "settings", title: "Settings…", sc: "cmd+,", run: () => toast("Settings opens here. Layout lives under Appearance.") },
    { id: "emptyTrash", title: "Empty Trash…", sc: "cmd+shift+delete", run: () => confirmEmptyTrash() },
  ];
  const cmd = (id) => COMMANDS.find((c) => c.id === id);

  function back(paneId) {
    const tab = tabOf(paneId);
    if (!tab.back.length) return;
    tab.forward.push(tab.path);
    navigate(paneId, tab.back.pop(), { history: true });
  }
  function forward(paneId) {
    const tab = tabOf(paneId);
    if (!tab.forward.length) return;
    tab.back.push(tab.path);
    navigate(paneId, tab.forward.pop(), { history: true });
  }
  function up(paneId) {
    const tab = tabOf(paneId);
    if (tab.path !== "/") navigate(paneId, dirname(tab.path), { select: basename(tab.path) });
  }
  function toggleSplit() {
    S.split = !S.split;
    S.activePane = S.split ? "right" : "left";
  }
  function focusFilter() {
    requestAnimationFrame(() => {
      const el = document.getElementById("filter");
      el?.focus();
      el?.select();
    });
  }
  function openOverlay(kind) {
    if (kind === "preview") {
      const tab = activeTab();
      if (!tab.lead) return toast("Select an item to preview");
    }
    S.overlay = { kind, q: "", idx: 0 };
    if (kind === "palette" || kind === "fuzzy") requestAnimationFrame(() => document.getElementById("ovl-input")?.focus());
  }
  function toggleVim() {
    S.vim = !S.vim;
    localStorage.setItem("fazi-mock-vim", S.vim ? "on" : "off");
    toast(S.vim ? "Vim mode is on" : "Vim mode is off");
  }
  function setTheme(t) {
    S.theme = t;
    localStorage.setItem(`fazi-mock-theme-${design.id}`, t);
  }
  function trashSelection() {
    const tab = activeTab();
    if (!tab.sel.size) return;
    const names = [...tab.sel];
    FS[tab.path] = FS[tab.path].filter((e) => !tab.sel.has(e.name));
    FS[FOLDERS.trash].push(...names.map((n) => file(n, 1000, NOW)));
    tab.sel = new Set();
    toast(`Moved ${plural(names.length, "item")} to the Trash`, { action: "Undo" });
  }
  function keepSelection() {
    const tab = activeTab();
    if (tab.path !== CLEANUP.folder) return toast("Keep applies to items in an auto-cleanup folder");
    for (const n of tab.sel) {
      const p = join(tab.path, n);
      if (S.kept.has(p)) S.kept.delete(p);
      else S.kept.add(p);
    }
    toast(`Kept ${plural(tab.sel.size, "item")}`);
  }
  function confirmEmptyTrash() {
    const n = (FS[FOLDERS.trash] || []).length;
    S.overlay = {
      kind: "confirm",
      title: "Empty the Trash?",
      message: `${plural(n, "item")} will be deleted permanently. You can't undo this.`,
      confirm: "Empty Trash",
      danger: true,
      run: () => {
        FS[FOLDERS.trash] = [];
        toast("Emptied the Trash");
      },
    };
  }

  function rowMenu(paneId, name) {
    const tab = tabOf(paneId);
    const entry = (FS[tab.path] || []).find((e) => e.name === name);
    if (!tab.sel.has(name)) selectRow(paneId, name, {});
    const n = tab.sel.size;
    const items = [
      { label: "Open", sc: "cmd+down", run: () => openEntry(paneId, name) },
      entry?.dir && !entry.app ? { label: "Open in New Tab", run: () => openTab(paneId, join(tab.path, name)) } : null,
      { label: "Open With", sub: true, run: () => toast("Open With submenu") },
      { sep: true },
      { label: "Move to Trash", sc: "cmd+delete", run: () => trashSelection() },
      { sep: true },
      { label: "Get Info", sc: "cmd+i", run: () => (S.info = true) },
      { label: n > 1 ? `Rename ${n} Items…` : "Rename", sc: n > 1 ? "cmd+shift+r" : "enter", run: () => toast("Rename") },
      { label: `Compress ${n > 1 ? plural(n, "item") : `“${name}”`}`, run: () => toast("Compressing…") },
      { label: "Duplicate", sc: "cmd+d", run: () => toast("Duplicated") },
      { label: "Quick Look", sc: "space", run: () => openOverlay("preview") },
      { sep: true },
      { label: "Copy", sc: "cmd+c", run: () => toast(`Copied ${plural(n, "item")}`) },
      { label: "Share", sub: true, run: () => toast("Share submenu") },
      tab.path === CLEANUP.folder ? { sep: true } : null,
      tab.path === CLEANUP.folder ? { label: "Keep", sc: "cmd+opt+k", run: () => keepSelection() } : null,
      { tags: true },
    ];
    return items.filter(Boolean);
  }

  function tabMenu(paneId, id) {
    const tab = pane(paneId).tabs.find((t) => t.id === id);
    return [
      { label: "New Tab", sc: "cmd+t", run: () => openTab(paneId, tab.path) },
      { label: "Close Tab", sc: "cmd+w", run: () => closeTab(paneId, id) },
    ];
  }

  function placeMenu(place) {
    const items = [{ label: "Open in New Tab", run: () => openTab(S.activePane, place.path) }];
    if (place.favorite) items.push({ sep: true }, { label: "Remove from Sidebar", run: () => toast(`Removed “${place.label}” from the sidebar`) });
    if (place.trash) items.push({ sep: true }, { label: "Empty Trash…", run: () => confirmEmptyTrash() });
    if (place.ejectable) items.push({ sep: true }, { label: `Eject “${place.label}”`, run: () => toast(`Ejected “${place.label}”`) });
    return items;
  }

  function moreMenu() {
    return ["newFolder", "newTab", null, "toggleHidden", "toggleSidebar", "dualPane", null, "getInfo", null, "copyOp", null]
      .map((id) => (id ? { label: cmd(id).title, sc: cmd(id).sc, run: cmd(id).run } : { sep: true }))
      .concat([
        { label: "Reveal in Finder", run: () => toast("Revealed in Finder") },
        { label: "Eject", run: () => toast("Nothing to eject here") },
        { sep: true },
        { label: "Command Palette…", sc: "cmd+k", run: () => openOverlay("palette") },
      ]);
  }

  // -------------------------------------------------------------------------
  // Shared renderers
  // -------------------------------------------------------------------------

  /** Locations as data; each design renders them its own way. */
  function places() {
    const cur = activeTab().path;
    const soon = leavingSoon().length;
    const row = (key, label, path, ic, extra = {}) => ({ key, label, path, icon: ic, current: cur === path, ...extra });
    return {
      favorites: [
        row("home", "Home", FOLDERS.home, "house", { sc: "cmd+shift+h" }),
        row("desktop", "Desktop", FOLDERS.desktop, "monitor"),
        row("documents", "Documents", FOLDERS.documents, "fileText"),
        row("downloads", "Downloads", FOLDERS.downloads, "download", { sc: "cmd+opt+l", badge: S.cleanupOn && soon ? soon : 0 }),
        row("applications", "Applications", FOLDERS.applications, "apps", { sc: "cmd+shift+a" }),
        ...FAVORITES.map((f) => row(`fav:${f.path}`, f.name, f.path, "folder", { favorite: true })),
      ],
      trash: row("trash", "Trash", FOLDERS.trash, "trash", { trash: true, count: (FS[FOLDERS.trash] || []).length }),
      volumes: VOLUMES.map((v) =>
        row(`vol:${v.path}`, v.name, v.path, v.root ? "hardDrive" : "database", { ejectable: v.ejectable, free: bytes(v.free) }),
      ),
    };
  }

  /** "~/Projects/fileManager/Tazi" → "fileManager/Tazi"; home reads "Home". */
  function shortParent(path) {
    const parent = tilde(dirname(path));
    if (parent === "~") return "Home";
    const parts = parent.split("/").filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join("/") : parent;
  }
  /** "Fazi Showcase" → "FS", "Projects" → "Pr". */
  function monogram(name) {
    const words = name.split(/[\s_-]+/).filter(Boolean);
    return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : name.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  }

  /** Tabs of one pane as data. */
  function tabs(paneId) {
    const p = pane(paneId);
    const hints = tabHints(p);
    return p.tabs.map((t, i) => ({
      id: t.id,
      paneId,
      path: t.path,
      name: basename(t.path),
      parent: tilde(dirname(t.path)),
      where: shortParent(t.path),
      mono: monogram(basename(t.path)),
      hint: hints[i],
      active: t.id === p.active,
      focused: t.id === p.active && S.activePane === paneId,
      count: visible(t).length,
      selected: t.sel.size,
      leaving: t.path === CLEANUP.folder && S.cleanupOn ? leavingSoon().length : 0,
    }));
  }

  /** Attributes for a tab element: wires click, middle-click, context menu. */
  const tabAttrs = (t) => `data-tab="${t.id}" data-pane-id="${t.paneId}" title="${esc(tilde(t.path))}"`;
  const placeAttrs = (p) => `data-place="${esc(p.key)}" data-path="${esc(p.path)}" title="${esc(p.volume ? p.label : tilde(p.path))}"`;

  function crumbs(paneId, { max = 4, sep = "›", root = true, home = false } = {}) {
    const tab = tabOf(paneId);
    if (S.pathEdit === paneId) {
      return `<input id="pathedit" class="path-edit" data-pane-id="${paneId}" value="${esc(tilde(tab.path))}" spellcheck="false" />`;
    }
    const segs = [];
    let p = tab.path;
    const underHome = home && (p === HOME || p.startsWith(HOME + "/"));
    while (true) {
      segs.unshift({ path: p, name: underHome && p === HOME ? "~" : basename(p) });
      if (p === "/" || (underHome && p === HOME)) break;
      p = dirname(p);
    }
    const all = root || underHome ? segs : segs.slice(1);
    const shown = all.length > max ? all.slice(-max) : all;
    const elided = all.length > max;
    return `<div class="crumbs" data-crumbs="${paneId}">${elided ? `<span class="crumb-ellipsis">…</span>` : ""}${shown
      .map(
        (s, i) =>
          `${i > 0 || elided ? `<span class="crumb-sep">${sep}</span>` : ""}<button class="crumb ${i === shown.length - 1 ? "is-current" : ""}" data-act="navigate" data-pane-id="${paneId}" data-path="${esc(s.path)}">${esc(s.name)}</button>`,
      )
      .join("")}<span class="crumb-fill" data-act="editPath" data-pane-id="${paneId}"></span></div>`;
  }

  function navButtons(paneId = S.activePane) {
    const tab = tabOf(paneId);
    return `<div class="nav-buttons"><button class="icon-btn" data-act="back" data-pane-id="${paneId}" ${tab.back.length ? "" : "disabled"} title="Back (⌘[)">${icon("chevronLeft", 16)}</button><button class="icon-btn" data-act="forward" data-pane-id="${paneId}" ${tab.forward.length ? "" : "disabled"} title="Forward (⌘])">${icon("chevronRight", 16)}</button></div>`;
  }

  function filterField({ placeholder } = {}) {
    const tab = activeTab();
    const value = S.search.active ? S.search.query : tab.filter;
    const ph = placeholder || (S.search.active ? "Search everywhere" : "Filter · ⏎ searches");
    return `<label class="filter ${S.search.active ? "is-global" : ""} ${value ? "has-value" : ""}">${icon("search", 13)}<input id="filter" value="${esc(value)}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off" />${
      value ? `<button class="filter-clear" data-act="clearSearch" aria-label="Clear">${icon("x", 11)}</button>` : ""
    }</label>`;
  }

  function searchScopes() {
    if (!S.search.active) return "";
    const seg = (items, cur, act) =>
      `<div class="seg">${items.map(([v, l]) => `<button class="${cur === v ? "is-on" : ""}" data-act="${act}" data-value="${v}">${l}</button>`).join("")}</div>`;
    return `<div class="scopes">${seg(
      [
        ["folder", "This Folder"],
        ["home", "Home"],
        ["mac", "This Mac"],
      ],
      S.search.scope,
      "scope",
    )}${seg(
      [
        ["name", "Filename"],
        ["contents", "Contents"],
      ],
      S.search.contents ? "contents" : "name",
      "contents",
    )}</div>`;
  }

  function viewToggle() {
    return `<div class="seg view-toggle"><button class="${S.view === "list" ? "is-on" : ""}" data-act="view" data-value="list" title="List (⌘1)">${icon("list", 14)}</button><button class="${S.view === "grid" ? "is-on" : ""}" data-act="view" data-value="grid" title="Icons (⌘2)">${icon("grid", 14)}</button></div>`;
  }

  const moreButton = () => `<button class="icon-btn" data-act="more" title="More">${icon("ellipsis", 16)}</button>`;
  const infoButton = () => `<button class="icon-btn ${S.info ? "is-on" : ""}" data-act="info" title="Get Info (⌘I)">${icon("info", 15)}</button>`;
  const splitButton = () => `<button class="icon-btn ${S.split ? "is-on" : ""}" data-act="split" title="Dual pane (⌘⇧D)">${icon("columns", 15)}</button>`;
  const loadingBar = () => (S.loading ? `<div class="loading-bar"></div>` : "");

  function fdaBanner() {
    if (!S.fda) return "";
    return `<div class="banner banner-fda">${icon("lock", 18)}<div class="banner-text"><strong>Grant Full Disk Access</strong><span>Fazi needs Full Disk Access to browse protected folders like Desktop, Documents, and external drives.</span></div><button class="btn btn-primary" data-act="toast" data-msg="Opens System Settings → Privacy &amp; Security">Open Settings</button><button class="btn-x" data-act="fdaDismiss" aria-label="Dismiss">${icon("x", 12)}</button></div>`;
  }

  function banners(paneId) {
    const tab = tabOf(paneId);
    if (S.search.active && S.activePane === paneId) return "";
    if (tab.path === FOLDERS.trash) {
      const n = (FS[tab.path] || []).length;
      return `<div class="banner banner-trash"><span>${n === 0 ? "The Trash is empty" : plural(n, "item")}</span><span class="grow"></span><button class="btn" data-act="emptyTrash" ${n ? "" : "disabled"}>Empty Trash…</button></div>`;
    }
    if (tab.path === CLEANUP.folder && S.cleanupOn && !S.cleanupDismissed) {
      const leaving = leavingSoon();
      if (!leaving.length) return "";
      const size = bytes(leaving.reduce((a, e) => a + (e.size || 0), 0));
      return `<div class="banner banner-cleanup">${icon("hourglass", 14)}<div class="banner-text grow"><span><strong>Auto-cleanup is on.</strong> Items move to the Trash ${CLEANUP.days} days after they arrive. <em class="danger">${plural(leaving.length, "item")} (${size}) go tomorrow.</em></span></div><button class="btn" data-act="cleanupSelect" data-pane-id="${paneId}">Select Them</button><button class="btn" data-act="cleanupPause">Pause</button><button class="btn-x" data-act="cleanupDismiss" title="Hide until the list changes">${icon("x", 12)}</button></div>`;
    }
    return "";
  }

  function tagDots(tags) {
    return tags.length ? `<span class="tags">${tags.map((c) => `<i style="background:${TAGS[c][1]}" title="${TAGS[c][0]}"></i>`).join("")}</span>` : "";
  }

  function listView(paneId) {
    const tab = tabOf(paneId);
    const list = visible(tab);
    const cleanup = tab.path === CLEANUP.folder && S.cleanupOn;
    const head = (label, key, cls = "") => {
      const on = tab.sort.key === key;
      return `<button class="th ${cls} ${on ? "is-sorted" : ""}" ${key ? `data-act="sort" data-pane-id="${paneId}" data-value="${key}"` : ""}>${label}${on ? `<span class="sort-caret">${tab.sort.dir === "asc" ? "▲" : "▼"}</span>` : ""}</button>`;
    };
    if (list.length === 0) return emptyState(tab);
    return `<div class="list ${cleanup ? "has-cleanup" : ""}">
      <div class="list-head">${head("Name", "name", "c-name")}${head("Kind", "kind", "c-kind")}${head("Size", "size", "c-size")}${head("Date Modified", "date", "c-date")}${head("Tags", null, "c-tags")}${cleanup ? head("Cleanup", null, "c-clean") : ""}</div>
      <div class="list-body" data-scroll-key="${paneId}:${tab.id}">${list
        .map((e) => {
          const path = join(tab.path, e.name);
          const c = cleanupInfo(e, path);
          return `<div class="row ${tab.sel.has(e.name) ? "is-sel" : ""} ${tab.lead === e.name ? "is-lead" : ""}" data-row="${esc(e.name)}" data-pane-id="${paneId}">
            <span class="c-name">${glyph(e, 16)}<span class="name">${esc(e.name)}</span></span>
            <span class="c-kind">${esc(e.kind)}</span>
            <span class="c-size tnum">${e.dir && !e.app ? "--" : bytes(e.size)}</span>
            <span class="c-date tnum">${when(e.mod)}</span>
            <span class="c-tags">${tagDots(e.tags)}</span>
            ${cleanup ? `<span class="c-clean tnum ${c ? `tone-${c.tone}` : ""}">${c ? c.label : "Never"}</span>` : ""}
          </div>`;
        })
        .join("")}</div></div>`;
  }

  function gridView(paneId) {
    const tab = tabOf(paneId);
    const list = visible(tab);
    if (list.length === 0) return emptyState(tab);
    return `<div class="gridv" data-scroll-key="${paneId}:${tab.id}:g">${list
      .map(
        (e) => `<div class="tile ${tab.sel.has(e.name) ? "is-sel" : ""}" data-row="${esc(e.name)}" data-pane-id="${paneId}">
          <div class="tile-art">${e.type === "image" ? `<div class="thumb" style="--h:${(e.name.length * 37) % 360}"></div>` : glyph(e, 56)}</div>
          <div class="tile-name">${esc(e.name)}</div>${tagDots(e.tags)}
        </div>`,
      )
      .join("")}</div>`;
  }

  function emptyState(tab) {
    if (tab.filter) return `<div class="empty"><strong>No items match “${esc(tab.filter)}”</strong><span>Press ⏎ to search everywhere instead.</span></div>`;
    if (tab.path === FOLDERS.trash) return `<div class="empty"><strong>The Trash is empty</strong><span>Items you delete land here first.</span></div>`;
    return `<div class="empty"><strong>This folder is empty</strong><span>Drop files here or press ⌘⇧N for a new folder.</span></div>`;
  }

  function searchResults() {
    const hits = searchHits();
    const scope = { folder: `“${basename(activeTab().path)}”`, home: "Home", mac: "This Mac" }[S.search.scope];
    if (S.search.query.trim() === "") return `<div class="empty"><strong>Search ${scope}</strong><span>Try <code>kind:pdf</code>, <code>date:7d</code>, or <code>size:&gt;10mb</code>.</span></div>`;
    if (!hits.length) return `<div class="empty"><strong>No results in ${scope}</strong><span>Try a wider scope, or search file contents.</span></div>`;
    return `<div class="list search">
      <div class="list-head"><span class="th c-name">${plural(hits.length, "result")} in ${scope}</span><span class="th c-where">Where</span><span class="th c-kind">Kind</span></div>
      <div class="list-body">${hits
        .map(
          (e) => `<div class="row" data-hit="${esc(e.path)}"><span class="c-name">${glyph(e, 16)}<span class="name">${esc(e.name)}</span></span><span class="c-where">${esc(tilde(e.parent))}</span><span class="c-kind">${esc(e.kind)}</span></div>`,
        )
        .join("")}</div></div>`;
  }

  /** Banners + list/grid/search: everything below a pane's header. */
  function body(paneId) {
    const showSearch = S.search.active && S.activePane === paneId;
    return `${banners(paneId)}<div class="pane-content">${showSearch ? searchResults() : S.view === "grid" ? gridView(paneId) : listView(paneId)}</div>`;
  }

  function status() {
    const tab = activeTab();
    const list = visible(tab);
    let text = plural(list.length, "item");
    let size = "";
    if (S.search.active) text = plural(searchHits().length, "result");
    else if (tab.sel.size) {
      text = `${list.length} items, ${tab.sel.size} selected`;
      size = bytes(list.filter((e) => tab.sel.has(e.name)).reduce((a, e) => a + (e.size || 0), 0));
    }
    const soon = S.cleanupOn ? leavingSoon().length : 0;
    const vimLabel = S.filterFocused ? "FILTER" : S.vimMode === "visual" ? "VISUAL" : "NORMAL";
    return {
      text,
      size,
      hidden: S.hidden,
      vim: S.vim ? { label: vimLabel, pending: S.vimPending, visual: S.vimMode === "visual" } : null,
      cleanup: soon ? `${soon} to Trash by tomorrow` : "",
      sweep: "next sweep 11:00 am",
      path: tilde(tab.path),
    };
  }

  function info() {
    if (!S.info) return "";
    const tab = activeTab();
    const entries = FS[tab.path] || [];
    const selected = entries.filter((e) => tab.sel.has(e.name));
    const e =
      selected.length === 1
        ? selected[0]
        : selected.length === 0
          ? { ...dir(basename(tab.path), NOW - DAY), size: entries.reduce((a, x) => a + (x.size || 0), 0) }
          : null;
    const path = e ? (selected.length ? join(tab.path, e.name) : tab.path) : tab.path;
    const row = (k, v) => `<div class="info-row"><span>${k}</span><span>${v}</span></div>`;
    const tagColors = new Set(e ? e.tags : []);
    return `<aside class="info-panel">
      <div class="info-head"><span>Info</span><button class="btn-x" data-act="info" aria-label="Close">${icon("x", 12)}</button></div>
      <div class="info-hero">${e ? (e.type === "image" ? `<div class="thumb big" style="--h:${(e.name.length * 37) % 360}"></div>` : glyph(e, 72)) : `<div class="stack">${selected.slice(0, 3).map((x) => glyph(x, 48)).join("")}</div>`}
        <div class="info-name">${e ? esc(e.name) : plural(selected.length, "item")}</div>
        <div class="info-sub">${e ? `${esc(e.kind)} · ${e.size != null ? bytes(e.size) : "--"}` : bytes(selected.reduce((a, x) => a + (x.size || 0), 0))}</div>
      </div>
      <div class="info-rows">
        ${e ? row("Where", esc(tilde(dirname(path)))) : ""}
        ${e ? row("Created", when(e.mod - 20 * DAY)) : ""}
        ${e ? row("Modified", when(e.mod)) : ""}
        ${e && e.added ? row("Added", when(e.added)) : ""}
        ${e && !e.dir ? row("Where from", "github.com") : ""}
        ${row("Permissions", "You can read and write")}
      </div>
      <div class="info-tags"><span>Tags</span><div>${Object.entries(TAGS)
        .map(([c, [n, css]]) => `<button class="tag-dot ${tagColors.has(+c) ? "is-on" : ""}" style="background:${css}" title="${n}" data-act="tag" data-value="${c}"></button>`)
        .join("")}</div></div>
    </aside>`;
  }

  function opCards() {
    return S.ops
      .map((o) => {
        const f = o.done / o.total;
        const eta = o.rate ? Math.max(1, Math.round((o.total - o.done) / o.rate)) : null;
        return `<div class="op-card"><div class="op-top"><span>${esc(o.label)}</span><button class="btn-x" data-act="opCancel" data-value="${o.id}" title="${o.status === "running" ? "Cancel" : "Dismiss"}">${icon("x", 12)}</button></div>${
          o.status === "running"
            ? `<div class="op-progress"><div style="width:${(f * 100).toFixed(1)}%"></div></div><div class="op-meta tnum"><span>${bytes(o.done)} of ${bytes(o.total)}</span><span>${bytes(o.rate)}/s${eta ? ` · ${eta}s left` : ""}</span></div><div class="op-file">${esc(o.current)}</div>`
            : `<div class="op-meta">Done</div>`
        }</div>`;
      })
      .join("");
  }

  function toasts() {
    return S.toasts
      .map(
        (t) => `<div class="toast"><span>${esc(t.message)}</span>${t.action ? `<button class="toast-action" data-act="toastDismiss" data-value="${t.id}">${esc(t.action)}</button>` : ""}<button class="btn-x" data-act="toastDismiss" data-value="${t.id}">${icon("x", 11)}</button></div>`,
      )
      .join("");
  }

  function overlay() {
    const o = S.overlay;
    if (!o) return "";
    if (o.kind === "palette" || o.kind === "fuzzy") {
      const items = overlayItems();
      return `<div class="scrim" data-act="closeOverlay"></div><div class="palette" role="dialog">
        <div class="palette-input">${icon(o.kind === "palette" ? "command" : "search", 15)}<input id="ovl-input" value="${esc(o.q)}" placeholder="${o.kind === "palette" ? "Type a command" : "Go to file in Home"}" spellcheck="false" autocomplete="off" /></div>
        <div class="palette-list">${
          items.length
            ? items
                .map(
                  (it, i) => `<div class="palette-item ${i === o.idx ? "is-on" : ""}" data-pick="${i}">${it.glyph || ""}<span class="pi-title">${esc(it.title)}</span>${it.sub ? `<span class="pi-sub">${esc(it.sub)}</span>` : ""}${it.sc ? `<kbd>${kbd(it.sc)}</kbd>` : ""}</div>`,
                )
                .join("")
            : `<div class="palette-empty">No matches</div>`
        }</div></div>`;
    }
    if (o.kind === "preview") {
      const tab = activeTab();
      const list = visible(tab);
      const i = list.findIndex((e) => e.name === tab.lead);
      const e = list[i];
      return `<div class="scrim dark" data-act="closeOverlay"></div><div class="preview"><div class="preview-bar"><span>${esc(e.name)}</span><span class="dim">${i + 1} of ${list.length}</span></div><div class="preview-art">${e.type === "image" ? `<div class="thumb huge" style="--h:${(e.name.length * 37) % 360}"></div>` : glyph(e, 160)}</div></div>`;
    }
    if (o.kind === "confirm") {
      return `<div class="scrim" data-act="closeOverlay"></div><div class="dialog"><strong>${esc(o.title)}</strong><p>${esc(o.message)}</p><div class="dialog-actions"><button class="btn" data-act="closeOverlay">Cancel</button><button class="btn ${o.danger ? "btn-danger" : "btn-primary"}" data-act="confirmOverlay">${esc(o.confirm)}</button></div></div>`;
    }
    if (o.kind === "vimhelp") {
      const rows = [
        ["h j k l", "Move"], ["gg  G", "First / last item"], ["12j", "Counts"], ["v", "Visual selection"],
        ["yy  dd  p", "Copy, cut, paste"], ["m", "Context menu"], ["gs", "Cycle sidebar / panes"], ["/", "Filter"],
        [":", "Command palette"], ["⌃P", "Go to file"], ["gt  gT", "Next / previous tab"], ["g?", "This sheet"],
      ];
      return `<div class="scrim" data-act="closeOverlay"></div><div class="dialog vimhelp"><strong>Vim keys</strong><div class="vim-grid">${rows.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join("")}</div><div class="dialog-actions"><button class="btn" data-act="closeOverlay">Done</button></div></div>`;
    }
    return "";
  }

  function overlayItems() {
    const o = S.overlay;
    const q = o.q.trim();
    if (o.kind === "palette") {
      return COMMANDS.map((c) => ({ ...c, score: q ? fuzzyScore(c.title, q) : 0 }))
        .filter((c) => c.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
    }
    return allPaths()
      .filter((e) => !e.hidden && e.path.startsWith(HOME))
      .map((e) => ({ title: e.name, sub: tilde(e.parent), glyph: glyph(e, 16), entry: e, score: q ? fuzzyScore(e.name, q) : 0 }))
      .filter((e) => e.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }

  function pickOverlay(i) {
    const items = overlayItems();
    const it = items[i];
    S.overlay = null;
    if (!it) return;
    if (it.run) it.run();
    else navigate(S.activePane, it.entry.parent, { select: it.entry.name });
  }

  function menu() {
    if (!S.menu) return "";
    const { x, y, items } = S.menu;
    const left = Math.min(x, window.innerWidth - 250);
    const top = Math.min(y, window.innerHeight - items.length * 24 - 20);
    return `<div class="menu" style="left:${left}px;top:${top}px">${items
      .map((it, i) =>
        it.sep
          ? `<div class="menu-sep"></div>`
          : it.tags
            ? `<div class="menu-tags">${Object.entries(TAGS).map(([c, [n, css]]) => `<button style="background:${css}" title="${n}" data-act="tag" data-value="${c}"></button>`).join("")}</div>`
            : `<button class="menu-item" data-menu="${i}"><span>${esc(it.label)}</span>${it.sub ? "<span>›</span>" : it.sc ? `<kbd>${kbd(it.sc)}</kbd>` : ""}</button>`,
      )
      .join("")}</div>`;
  }

  function harness() {
    const designs = [
      ["a-rail.html", "A · Rail"],
      ["b-strip.html", "B · Strip"],
      ["c-trail.html", "C · Trail"],
      ["d-console.html", "D · Console"],
      ["a-rail-address.html", "A2 · Rail + address bar"],
    ];
    const here = location.pathname.split("/").pop();
    return `<a class="h-home" href="index.html">Fazi layouts</a><nav class="h-designs">${designs
      .map(([f, l]) => `<a href="${f}" class="${here === f ? "is-on" : ""}">${l}</a>`)
      .join("")}</nav><span class="h-grow"></span>
      ${design.harnessExtra ? design.harnessExtra(S) : ""}
      <button data-act="theme">${icon(S.theme === "dark" ? "sun" : "moon", 13)}${S.theme === "dark" ? "Light" : "Dark"}</button>
      <button data-act="split" class="${S.split ? "is-on" : ""}">Dual pane</button>
      <button data-act="vim" class="${S.vim ? "is-on" : ""}">Vim</button>
      <button data-act="fda" class="${S.fda ? "is-on" : ""}">FDA banner</button>
      <button data-act="opDemo">Copy demo</button>
      <button data-act="palette">⌘K</button>`;
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  let design = null;
  let win = null;
  let bar = null;

  function render() {
    if (!design) return;
    document.documentElement.dataset.theme = S.theme;
    // keep scroll + focus across innerHTML swaps
    const scroll = {};
    win.querySelectorAll("[data-scroll-key]").forEach((el) => (scroll[el.dataset.scrollKey] = el.scrollTop));
    const focusId = document.activeElement?.id;
    const caret = focusId ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;

    win.className = `window design-${design.id} ${S.split ? "is-split" : ""} ${S.sidebar ? "" : "no-sidebar"} ${S.info ? "has-info" : ""} ${S.vim ? "vim-on" : ""}`;
    win.innerHTML = `${design.layout(R, S)}<div class="op-stack">${opCards()}</div><div class="toast-stack">${toasts()}</div>${overlay()}${menu()}`;
    bar.innerHTML = harness();

    win.querySelectorAll("[data-scroll-key]").forEach((el) => {
      if (scroll[el.dataset.scrollKey] != null) el.scrollTop = scroll[el.dataset.scrollKey];
    });
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && el.setSelectionRange && caret[0] != null) el.setSelectionRange(caret[0], caret[1]);
      }
    }
    const pe = document.getElementById("pathedit");
    if (pe && document.activeElement !== pe) {
      pe.focus();
      pe.select();
    }
  }

  function run(fn) {
    fn();
    render();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function paneOf(el) {
    return el.closest("[data-pane-id]")?.dataset.paneId || el.closest("[data-pane]")?.dataset.pane || S.activePane;
  }

  const ACTIONS = {
    navigate: (el) => navigate(paneOf(el), el.dataset.path),
    place: (el) => navigate(S.activePane, el.dataset.path),
    back: (el) => back(paneOf(el)),
    forward: (el) => forward(paneOf(el)),
    up: (el) => up(paneOf(el)),
    newTab: (el) => openTab(paneOf(el), tabOf(paneOf(el)).path),
    closeTab: (el) => closeTab(el.dataset.paneId, el.dataset.tabId),
    split: () => toggleSplit(),
    swap: () => S.split && (S.activePane = S.activePane === "left" ? "right" : "left"),
    view: (el) => (S.view = el.dataset.value),
    sidebar: () => (S.sidebar = !S.sidebar),
    info: () => (S.info = !S.info),
    sort: (el) => {
      const tab = tabOf(el.dataset.paneId);
      const key = el.dataset.value;
      tab.sort = tab.sort.key === key ? { key, dir: tab.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "date" || key === "size" ? "desc" : "asc" };
    },
    scope: (el) => (S.search.scope = el.dataset.value),
    contents: (el) => (S.search.contents = el.dataset.value === "contents"),
    clearSearch: () => {
      S.search.active = false;
      S.search.query = "";
      activeTab().filter = "";
    },
    editPath: (el) => (S.pathEdit = paneOf(el)),
    more: (el) => {
      const r = el.getBoundingClientRect();
      S.menu = { x: r.right - 240, y: r.bottom + 4, items: moreMenu() };
    },
    emptyTrash: () => confirmEmptyTrash(),
    cleanupSelect: (el) => {
      const tab = tabOf(el.dataset.paneId);
      const names = leavingSoon().map((e) => e.name);
      tab.sel = new Set(names);
      tab.lead = names[0];
    },
    cleanupPause: () => {
      S.cleanupOn = false;
      toast("Auto-cleanup is off", { action: "Turn On" });
    },
    cleanupDismiss: () => (S.cleanupDismissed = true),
    fdaDismiss: () => (S.fda = false),
    fda: () => (S.fda = !S.fda),
    opDemo: () => startOp(),
    opCancel: (el) => {
      const op = S.ops.find((o) => o.id === +el.dataset.value);
      if (op && op.status === "running") toast("Copy cancelled");
      S.ops = S.ops.filter((o) => o.id !== +el.dataset.value);
    },
    toastDismiss: (el) => (S.toasts = S.toasts.filter((t) => t.id !== +el.dataset.value)),
    toast: (el) => toast(el.dataset.msg),
    tag: (el) => {
      const tab = activeTab();
      const c = +el.dataset.value;
      for (const e of FS[tab.path] || []) {
        if (!tab.sel.has(e.name)) continue;
        e.tags = e.tags.includes(c) ? e.tags.filter((x) => x !== c) : [...e.tags, c];
      }
      S.menu = null;
    },
    closeOverlay: () => (S.overlay = null),
    confirmOverlay: () => {
      const o = S.overlay;
      S.overlay = null;
      o?.run?.();
    },
    palette: () => openOverlay("palette"),
    fuzzy: () => openOverlay("fuzzy"),
    vim: () => toggleVim(),
    vimHelp: () => openOverlay("vimhelp"),
    theme: () => setTheme(S.theme === "dark" ? "light" : "dark"),
    ui: (el) => (S.ui[el.dataset.value] = !S.ui[el.dataset.value]),
    setPane: (el) => (S.activePane = el.dataset.paneId),
  };

  function onClick(e) {
    const t = e.target;
    if (S.menu && !t.closest(".menu")) {
      S.menu = null;
      if (!t.closest("[data-act]")) return render();
    }
    const menuItem = t.closest("[data-menu]");
    if (menuItem) {
      const it = S.menu?.items[+menuItem.dataset.menu];
      S.menu = null;
      return run(() => it?.run());
    }
    const pick = t.closest("[data-pick]");
    if (pick) return run(() => pickOverlay(+pick.dataset.pick));
    const act = t.closest("[data-act]");
    if (act && !act.disabled) {
      e.stopPropagation();
      return run(() => ACTIONS[act.dataset.act]?.(act));
    }
    const tabEl = t.closest("[data-tab]");
    if (tabEl) {
      return run(() => {
        const p = tabEl.dataset.paneId;
        pane(p).active = tabEl.dataset.tab;
        S.activePane = p;
        S.search.active = false;
      });
    }
    const place = t.closest("[data-place]");
    if (place) return run(() => navigate(S.activePane, place.dataset.path));
    const row = t.closest("[data-row]");
    if (row) return run(() => selectRow(row.dataset.paneId, row.dataset.row, e));
    const hit = t.closest("[data-hit]");
    if (hit) return run(() => navigate(S.activePane, dirname(hit.dataset.hit), { select: basename(hit.dataset.hit) }));
    const p = t.closest("[data-pane]");
    if (p) {
      const id = p.dataset.pane;
      if (t.closest(".list-body, .gridv") && !t.closest("[data-row]")) {
        return run(() => {
          tabOf(id).sel = new Set();
          S.activePane = id;
        });
      }
      if (S.activePane !== id) run(() => (S.activePane = id));
    }
  }

  function onDblClick(e) {
    const row = e.target.closest("[data-row]");
    if (row) return run(() => openEntry(row.dataset.paneId, row.dataset.row));
    const crumbsEl = e.target.closest("[data-crumbs]");
    if (crumbsEl) return run(() => (S.pathEdit = crumbsEl.dataset.crumbs));
  }

  function onAux(e) {
    if (e.button !== 1) return;
    const tabEl = e.target.closest("[data-tab]");
    if (tabEl) {
      e.preventDefault();
      run(() => closeTab(tabEl.dataset.paneId, tabEl.dataset.tab));
    }
  }

  function onContext(e) {
    const row = e.target.closest("[data-row]");
    const tabEl = e.target.closest("[data-tab]");
    const place = e.target.closest("[data-place]");
    let items = null;
    if (row) items = rowMenu(row.dataset.paneId, row.dataset.row);
    else if (tabEl) items = tabMenu(tabEl.dataset.paneId, tabEl.dataset.tab);
    else if (place) {
      const all = places();
      const p = [...all.favorites, all.trash, ...all.volumes].find((x) => x.key === place.dataset.place);
      items = placeMenu(p);
    }
    if (!items) return;
    e.preventDefault();
    run(() => (S.menu = { x: e.clientX, y: e.clientY, items }));
  }

  function onInput(e) {
    if (e.target.id === "filter") {
      const v = e.target.value;
      run(() => {
        if (S.search.active) S.search.query = v;
        else activeTab().filter = v;
      });
    } else if (e.target.id === "ovl-input") {
      run(() => {
        S.overlay.q = e.target.value;
        S.overlay.idx = 0;
      });
    }
  }

  function onFocus(e) {
    if (e.target.id === "filter" && !S.filterFocused) run(() => (S.filterFocused = true));
  }
  function onBlur(e) {
    if (e.target.id === "filter") setTimeout(() => document.activeElement?.id !== "filter" && S.filterFocused && run(() => (S.filterFocused = false)));
    if (e.target.id === "pathedit") setTimeout(() => S.pathEdit && document.activeElement?.id !== "pathedit" && run(() => (S.pathEdit = null)));
  }

  function shortcutOf(e) {
    const mods = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("opt");
    if (e.shiftKey) mods.push("shift");
    if (e.metaKey) mods.push("cmd");
    let key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    if (e.code === "Period") key = ".";
    if (e.code === "BracketLeft") key = "[";
    if (e.code === "BracketRight") key = "]";
    if (e.code === "Backspace") key = "delete";
    if (e.code === "Space") key = "space";
    if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
    const map = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right" };
    key = map[key] || key;
    return [...mods.filter((m) => m !== "shift" || !["{", "}"].includes(key)), key].join("+");
  }

  /** "cmd+shift+d" and "shift+cmd+d" → one canonical order. */
  function canon(sc) {
    const parts = sc.split("+");
    const key = parts.pop();
    return [...["ctrl", "opt", "shift", "cmd"].filter((m) => parts.includes(m)), key].join("+");
  }

  // Browsers keep ⌘T/⌘W for themselves; ⌥ works as a stand-in in the mocks.
  const ALIASES = { "opt+t": "cmd+t", "opt+w": "cmd+w", "opt+k": "cmd+k", "opt+p": "cmd+p", "opt+n": "cmd+shift+n" };

  function onKey(e) {
    const target = e.target;
    if (target.id === "filter") {
      if (e.key === "Enter" && !S.search.active && target.value.trim()) {
        e.preventDefault();
        return run(() => {
          S.search = { ...S.search, active: true, query: target.value, scope: "folder" };
          activeTab().filter = "";
        });
      }
      if (e.key === "Escape") {
        return run(() => {
          ACTIONS.clearSearch();
          target.blur();
          S.filterFocused = false;
        });
      }
      if (e.key === "ArrowDown") {
        target.blur();
        S.filterFocused = false;
      } else return;
    }
    if (target.id === "pathedit") {
      if (e.key === "Enter") {
        const raw = target.value.trim().replace(/^~(?=\/|$)/, HOME);
        const p = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
        return run(() => {
          const paneId = S.pathEdit;
          S.pathEdit = null;
          navigate(paneId, p);
        });
      }
      if (e.key === "Escape") return run(() => (S.pathEdit = null));
      return;
    }
    if (target.id === "ovl-input") {
      const n = overlayItems().length;
      if (e.key === "ArrowDown") return e.preventDefault(), run(() => (S.overlay.idx = Math.min(n - 1, S.overlay.idx + 1)));
      if (e.key === "ArrowUp") return e.preventDefault(), run(() => (S.overlay.idx = Math.max(0, S.overlay.idx - 1)));
      if (e.key === "Enter") return e.preventDefault(), run(() => pickOverlay(S.overlay.idx));
      if (e.key === "Escape") return run(() => (S.overlay = null));
      return;
    }
    if (target.matches("input, textarea")) return;

    if (S.overlay) {
      if (e.key === "Escape" || (S.overlay.kind === "preview" && e.key === " ")) {
        e.preventDefault();
        return run(() => (S.overlay = null));
      }
      if (S.overlay.kind === "preview" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        return run(() => moveSel(e.key === "ArrowDown" ? 1 : -1, false));
      }
      return;
    }
    if (S.menu && e.key === "Escape") return run(() => (S.menu = null));

    let sc = shortcutOf(e);
    sc = ALIASES[sc] || sc;
    sc = canon(sc);

    // Vim layer (bare keys only)
    if (S.vim && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = e.key;
      const p = S.vimPending;
      const done = (fn) => {
        e.preventDefault();
        run(() => {
          S.vimPending = "";
          fn?.();
        });
      };
      if (p === "g") {
        if (k === "g") return done(() => moveSel(-1e6, false));
        if (k === "t") return done(() => cycleTab(1));
        if (k === "T") return done(() => cycleTab(-1));
        if (k === "?") return done(() => openOverlay("vimhelp"));
        if (k === "s") return done(() => S.split && (S.activePane = S.activePane === "left" ? "right" : "left"));
        return done();
      }
      if (p === "y" || p === "d") {
        if (k === p) return done(() => toast(`${p === "y" ? "Copied" : "Cut"} ${plural(Math.max(1, activeTab().sel.size), "item")}`));
        return done();
      }
      if (k === "j") return done(() => moveSel(1, false));
      if (k === "k") return done(() => moveSel(-1, false));
      if (k === "l") return done(() => activeTab().lead && openEntry(S.activePane, activeTab().lead));
      if (k === "h") return done(() => up(S.activePane));
      if (k === "G") return done(() => moveSel(1e6, false));
      if (k === "v") return done(() => (S.vimMode = S.vimMode === "visual" ? "normal" : "visual"));
      if (k === "p") return done(() => toast("Pasted"));
      if (k === "/") return done(() => focusFilter());
      if (k === ":") return done(() => openOverlay("palette"));
      if (k === "m") {
        e.preventDefault();
        const tab = activeTab();
        const el = document.querySelector(`[data-pane="${S.activePane}"] [data-row="${CSS.escape(tab.lead || "")}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          return run(() => (S.menu = { x: r.left + 40, y: r.bottom, items: rowMenu(S.activePane, tab.lead) }));
        }
        return;
      }
      if (k === "g" || k === "y" || k === "d") {
        e.preventDefault();
        return run(() => (S.vimPending = k));
      }
      if (k === "Escape" && S.vimMode === "visual") return done(() => (S.vimMode = "normal"));
    }
    if (S.vim && e.ctrlKey && e.key === "p") {
      e.preventDefault();
      return run(() => openOverlay("fuzzy"));
    }

    const byKey = {
      down: () => moveSel(1, false),
      up: () => moveSel(-1, false),
      "shift+down": () => moveSel(1, true),
      "shift+up": () => moveSel(-1, true),
      right: () => S.view === "grid" && moveSel(1, false),
      left: () => S.view === "grid" && moveSel(-1, false),
      "cmd+down": () => activeTab().lead && openEntry(S.activePane, activeTab().lead),
      "cmd+a": () => {
        const tab = activeTab();
        tab.sel = new Set(visible(tab).map((x) => x.name));
      },
      escape: () => {
        if (S.search.active) ACTIONS.clearSearch();
        else activeTab().sel = new Set();
      },
      enter: () => activeTab().lead && toast(`Rename “${activeTab().lead}”`),
      "cmd+k": () => openOverlay("palette"),
      "cmd+f": () => focusFilter(),
    };
    for (const c of COMMANDS) if (c.sc && !byKey[canon(c.sc)]) byKey[canon(c.sc)] = c.run;
    if (!S.split) delete byKey.tab;
    const fn = byKey[sc];
    if (fn) {
      e.preventDefault();
      run(fn);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const R = {
    icon,
    glyph,
    esc,
    kbd,
    tilde,
    basename,
    bytes,
    plural,
    places,
    tabs,
    tabAttrs,
    placeAttrs,
    crumbs,
    navButtons,
    filterField,
    searchScopes,
    viewToggle,
    moreButton,
    infoButton,
    splitButton,
    loadingBar,
    fdaBanner,
    body,
    status,
    info,
    tabOf,
    activeTab,
    HOME,
  };

  /** Demo states from the URL, e.g. a-rail.html#split&info&theme=dark. */
  function applyHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("theme")) S.theme = params.get("theme");
    if (params.has("split")) toggleSplit();
    if (params.has("info")) S.info = true;
    if (params.has("grid")) S.view = "grid";
    if (params.has("nosidebar")) S.sidebar = false;
    if (params.has("fda")) S.fda = true;
    if (params.has("novim")) S.vim = false;
    if (params.has("go")) navigate(S.activePane, params.get("go").replace(/^~/, HOME));
    if (params.has("search")) S.search = { ...S.search, active: true, query: params.get("search"), scope: params.get("scope") || "home" };
    if (params.has("palette")) openOverlay("palette");
    if (params.has("menu")) S.menu = { x: 520, y: 220, items: rowMenu(S.activePane, activeTab().lead || visible(activeTab())[0].name) };
    if (params.has("op")) startOp();
    if (params.has("toast")) toast(params.get("toast") || "Moved 2 items to the Trash", { action: "Undo", sticky: true });
    if (params.has("collapsed")) S.ui.collapsed = true;
    if (params.has("shot")) document.body.classList.add("shot");
    S.loading = null;
  }

  function mount(d) {
    design = d;
    S.theme = localStorage.getItem(`fazi-mock-theme-${d.id}`) || d.defaultTheme || "dark";
    document.body.insertAdjacentHTML("afterbegin", `<header class="harness" id="harness"></header><main class="stage"><div id="window"></div></main>`);
    win = document.getElementById("window");
    bar = document.getElementById("harness");
    d.init?.(S);
    applyHash();
    document.addEventListener("click", onClick);
    document.addEventListener("dblclick", onDblClick);
    document.addEventListener("auxclick", onAux);
    document.addEventListener("mousedown", (e) => e.button === 1 && e.target.closest("[data-tab]") && e.preventDefault());
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("input", onInput);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("keydown", onKey);
    render();
  }

  return { mount, R, S, render };
})();
