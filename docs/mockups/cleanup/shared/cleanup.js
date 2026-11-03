/**
 * Shared pieces for the auto-cleanup mockups: navigation, the details
 * popover (A and D), and the harness extras. Each design page mounts A2 with
 * its own banner, footer, and address hooks.
 */
window.Cleanup = (() => {
  const NAV = [
    ["a-pill.html", "A · Footer pill"],
    ["b-group.html", "B · List group"],
    ["c-slim.html", "C · Slim strip"],
    ["d-chip.html", "D · Address chip"],
  ];

  const harnessExtra = () => `<button data-act="cleanupReset">Reset cleanup</button>`;

  /** The details popover: what leaves, when, and what you can do about it. */
  function details(R, S, { place }) {
    const c = R.cleanup();
    const items = c.leaving
      .map(
        (it) => `<div class="pop-item">${R.glyph(it.entry, 16)}<span class="pop-name">${R.esc(it.name)}</span><span class="pop-size tnum">${it.size}</span></div>`,
      )
      .join("");
    const actions = c.here
      ? `<button class="btn btn-primary" data-act="cleanupSelect">Select</button>
         <button class="btn" data-act="cleanupKeep" title="Never clean these up (⌥⌘K)">Keep</button>`
      : `<button class="btn btn-primary" data-act="cleanupGo">Show in ${R.esc(c.folderName)}</button>`;
    return `<div class="pop pop-${place}" role="dialog" aria-label="Auto-cleanup">
      <div class="pop-head">
        <span class="pop-title">${R.plural(c.count, "item")} leave ${c.when}</span>
        <span class="pop-total tnum">${c.size}</span>
      </div>
      <div class="pop-items">${items}</div>
      <div class="pop-rule">${R.icon("hourglass", 12)}Cleared after ${c.days} days</div>
      <div class="pop-actions">
        ${actions}
        <span class="grow"></span>
        <button class="icon-btn" data-act="cleanupPause" title="Pause auto-cleanup">${R.icon("pause", 14)}</button>
        <button class="icon-btn" data-act="cleanupSettings" title="Auto-cleanup settings">${R.icon("settings", 14)}</button>
      </div>
    </div>`;
  }

  function mount(opts) {
    A2.mount({
      nav: NAV,
      home: "Cleanup designs",
      startPath: "~/Downloads",
      defaultTheme: "dark",
      harnessExtra,
      ...opts,
    });
  }

  return { mount, details };
})();
