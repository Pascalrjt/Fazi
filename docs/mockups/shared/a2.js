/**
 * A2 · Rail + address bar, as a reusable layout. a-rail-address.html mounts
 * it as is; the cleanup mockups pass hooks:
 *   footCleanup(R, S)    footer content in place of the cleanup note
 *   addressEnd(R, S)     extra content at the end of the address field
 *   cleanupBanner(R, S, paneId), nav, home, startPath, ... (see core.js)
 */
window.A2 = {
  mount(X = {}) {
    const TRAFFIC = '<div class="traffic"><i></i><i></i><i></i></div>';

    function tile(R, p) {
      return `<div class="tile-place ${p.current ? "is-current" : ""}" ${R.placeAttrs(p)}>
        ${R.icon(p.icon, 17)}
        ${p.badge ? `<span class="tile-badge" title="${p.badge} go to the Trash by tomorrow">${p.badge}</span>` : ""}
      </div>`;
    }

    function loc(R, p, meta = "") {
      return `<div class="loc ${p.current ? "is-current" : ""}" ${R.placeAttrs(p)}>
        ${R.icon(p.icon, 15)}<span class="grow">${R.esc(p.label)}</span>${meta}
        ${p.ejectable ? `<button class="btn-x eject" data-act="toast" data-msg="Ejected “${R.esc(p.label)}”" title="Eject">${R.icon("eject", 12)}</button>` : ""}
      </div>`;
    }

    function tabGroup(R, S, paneId) {
      const head = S.split
        ? `<div class="group-head ${S.activePane === paneId ? "is-active" : ""}"><span class="side-mark ${paneId}"></span>${paneId === "left" ? "Left pane" : "Right pane"}</div>`
        : "";
      const rows = R.tabs(paneId)
        .map(
          (t) => `<div class="vtab ${t.active ? "is-active" : ""} ${t.focused ? "is-focused" : ""}" ${R.tabAttrs(t)}>
            ${R.glyph({ dir: true }, 16)}
            <span class="vtab-name">${R.esc(t.name)}${t.hint ? ` <small>${R.esc(t.hint)}</small>` : ""}</span>
            ${t.leaving ? `<span class="vtab-badge">${R.icon("hourglass", 11)}${t.leaving}</span>` : ""}
            <button class="btn-x vtab-x" data-act="closeTab" data-pane-id="${paneId}" data-tab-id="${t.id}" title="Close tab (⌘W)">${R.icon("x", 11)}</button>
          </div>`,
        )
        .join("");
      return `${head}${rows}<button class="new-tab" data-act="newTab" data-pane-id="${paneId}">${R.icon("plus", 14)}New tab</button>`;
    }

    function rail(R, S) {
      const pl = R.places();
      const panes = S.split ? ["left", "right"] : ["left"];
      return `<aside class="rail" data-vim-surface="sidebar">
        ${R.filterField()}
        <div class="tiles">${pl.favorites.filter((p) => !p.favorite).map((p) => tile(R, p)).join("")}</div>
        <div class="pins">${pl.favorites.filter((p) => p.favorite).map((p) => loc(R, p)).join("")}</div>
        <div class="tab-groups">${panes.map((id) => tabGroup(R, S, id)).join("")}</div>
        <div class="rail-foot">
          ${loc(R, pl.trash, pl.trash.count ? `<span class="loc-meta tnum">${pl.trash.count}</span>` : "")}
          ${pl.volumes.map((v) => loc(R, v, `<span class="loc-meta vol tnum">${v.free}</span>`)).join("")}
        </div>
      </aside>`;
    }

    function card(R, S, paneId) {
      const active = S.activePane === paneId;
      const t = R.tabs(paneId).find((x) => x.active);
      const st = R.status();
      const searching = S.search.active && active;
      const foot = active
        ? `${st.vim ? `<button class="vim-label ${st.vim.visual ? "visual" : ""}" data-act="vimHelp" title="Vim keys (g?)">${st.vim.label}${st.vim.pending ? ` ${st.vim.pending}` : ""}</button>` : ""}
           <span class="tnum">${st.text}</span>${st.size ? `<span class="tnum dim">${st.size}</span>` : ""}
           <span class="grow"></span>
           ${st.hidden ? `<span class="dim">Hidden files shown</span>` : ""}
           ${X.footCleanup ? X.footCleanup(R, S) : st.cleanup ? `<span class="danger">${st.cleanup}</span><span class="dim">${st.sweep}</span>` : ""}`
        : `<span class="tnum dim">${R.plural(t.count, "item")}</span>`;
      return `<section class="card pane zebra ${active ? "is-active" : ""}" data-pane="${paneId}">
        ${active ? R.loadingBar() : ""}
        ${S.split ? `<div class="caption"><span class="side-mark ${paneId}"></span>${R.esc(t.name)}</div>` : ""}
        ${searching ? `<div class="search-bar">${R.searchScopes()}</div>` : ""}
        ${R.body(paneId)}
        <div class="card-foot">${foot}</div>
      </section>`;
    }

    function strip(R, S) {
      const right = !!S.ui.right;
      const toggle = `<button class="icon-btn" data-act="sidebar" title="${S.sidebar ? "Hide" : "Show"} sidebar (⌥⌘S)">${R.icon(
        right ? "sidebarRight" : S.sidebar ? "panelCollapse" : "panelExpand",
        15,
      )}</button>`;
      const paneTag = S.split ? `<span class="address-pane">${S.activePane === "left" ? "Left" : "Right"}</span>` : "";
      return `<header class="strip">
        ${R.loadingBar()}
        ${TRAFFIC}<span class="lights-room"></span>
        ${right ? "" : toggle}
        ${R.navButtons()}
        <button class="icon-btn" data-act="up" title="Enclosing folder (⌘↑)">${R.icon("arrowUp", 15)}</button>
        <div class="address" title="Double-click or ⌘⇧G to type a path">
          <span class="address-mark">${R.icon("folder", 14)}</span>${paneTag}
          ${R.crumbs(S.activePane, { max: 6, home: true })}
          ${X.addressEnd ? X.addressEnd(R, S) : ""}
        </div>
        <div class="strip-tools">${R.viewToggle()}${R.infoButton()}${R.splitButton()}${R.moreButton()}</div>
        ${right ? `<div class="strip-end" style="${S.sidebar ? "" : "width:auto"}">${toggle}</div>` : ""}
      </header>`;
    }

    Fazi.mount({
      id: "strip",
      defaultTheme: "light",
      ...X,
      init(S) {
        S.ui.right = new URLSearchParams(location.hash.slice(1)).has("right");
        X.init?.(S);
      },
      harnessExtra: (S) =>
        `${X.harnessExtra ? X.harnessExtra(S) : ""}<button data-act="ui" data-value="right" class="${S.ui.right ? "is-on" : ""}">Sidebar on right</button>`,
      layout(R, S) {
        const panes = S.split ? ["left", "right"] : ["left"];
        return `${strip(R, S)}
          <div class="body ${S.ui.right ? "dock-right" : ""}">
            ${S.sidebar ? rail(R, S) : ""}
            <div class="main">${R.fdaBanner()}
              <div class="cards">${panes.map((id) => card(R, S, id)).join("")}
              ${S.info ? `<div class="info-card">${R.info()}</div>` : ""}</div>
            </div>
          </div>`;
      },
    });
  },
};
