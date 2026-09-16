import { useContext, useEffect, useState } from "react";
import { useDownloadsCleanup } from "../../stores/downloadsCleanup";
import * as ipc from "../../lib/ipc";
import {
  CLEANUP_DAY,
  cleanupLabel,
  cleanupNear,
  cleanupTooltip,
  type CleanupItem,
  type CleanupPreview,
} from "../../lib/downloadsCleanup";
import { formatBytes } from "../../lib/format";
import { SettingRow, SettingsFilterContext, Toggle } from "./controls";

const button =
  "rounded border border-edge px-2 py-1 text-[11px] text-secondary hover:bg-hov focus-visible:outline-accent disabled:opacity-40";
export function DownloadsPane() {
  const query = useContext(SettingsFilterContext);
  const snapshot = useDownloadsCleanup((s) => s.snapshot);
  const error = useDownloadsCleanup((s) => s.error);
  const now = useDownloadsCleanup((s) => s.now);
  const [enabled, setEnabled] = useState(snapshot?.config.enabled ?? false);
  const [days, setDays] = useState(
    String(snapshot?.config.retentionDays ?? 30),
  );
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    void useDownloadsCleanup.getState().refresh();
  }, []);
  useEffect(() => {
    if (snapshot) {
      setEnabled(snapshot.config.enabled);
      setDays(String(snapshot.config.retentionDays));
    }
  }, [snapshot?.config.enabled, snapshot?.config.retentionDays]);
  async function perform(f: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  const valid =
    Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 3650;
  const changed =
    snapshot &&
    (enabled !== snapshot.config.enabled ||
      Number(days) !== snapshot.config.retentionDays);
  const shown = preview?.snapshot ?? snapshot;
  const items = shown?.items ?? [];
  const due = items.filter(
    (i) => !i.keep && i.deadline != null && i.deadline <= now,
  );
  const upcoming = items.filter(
    (i) => shown && cleanupNear(i, shown.config.retentionDays, now),
  );
  const visible = all ? items : upcoming;
  const action = (item: CleanupItem, kind: "keep" | "resume" | "extend") =>
    void perform(async () => {
      await useDownloadsCleanup.getState().itemAction(item, kind);
      setPreview(null);
    });
  return (
    <>
      <SettingRow
        label="Automatically clean Downloads"
        hint="Applies to files downloaded by every app into ~/Downloads. Moves regular files directly inside this folder to Trash."
      >
        <div className="flex items-center gap-2 text-xs text-primary">
          <Toggle
            label="Automatically clean Downloads"
            checked={enabled}
            disabled={busy || !snapshot}
            onChange={(value) => {
              setEnabled(value);
              setPreview(null);
            }}
          />
          {enabled ? "Enabled" : "Off"}
        </div>
      </SettingRow>
      <SettingRow
        label="Retention period"
        hint="Days since added to Downloads or last edited, whichever is later. Opening or previewing a file leaves its countdown unchanged."
      >
        <input
          aria-label="Retention days"
          type="number"
          min={1}
          max={3650}
          step={1}
          value={days}
          disabled={busy}
          onChange={(e) => {
            setDays(e.target.value);
            setPreview(null);
          }}
          className="w-20 rounded border border-edge bg-pane px-2 py-1 text-xs"
        />
        <span className="ml-2 text-xs text-secondary">days</span>
        <div className="mt-2 flex gap-1">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              className={button}
              disabled={busy}
              onClick={() => {
                setDays(String(n));
                setPreview(null);
              }}
            >
              {n}
            </button>
          ))}
        </div>
        {!valid && (
          <p className="mt-1 text-xs text-danger">
            Enter a whole number from 1 to 3650.
          </p>
        )}
      </SettingRow>
      <SettingRow
        label="Schedule and exclusions"
        hint="Checks daily while Fazi is running, with a catch-up check after launch. Folders, links, incomplete downloads, cloud-only files, and files in use are skipped."
      >
        <p className="text-[11px] text-secondary">
          Keep exempts a file. Extend adds 7 days to its remaining time. Changes
          to this policy allow one day before the next cleanup.
        </p>
        <p className="mt-2 text-[11px] text-tertiary">
          {!snapshot?.config.enabled
            ? "Cleanup is off."
            : snapshot.lastRun
              ? `Next check: ${new Date(snapshot.lastRun + CLEANUP_DAY).toLocaleString()} (while running)`
              : "First check after enabling."}
        </p>
      </SettingRow>
      <SettingRow
        label="Apply cleanup settings"
        hint="Review the affected files before enabling or changing retention."
      >
        <button
          className={button}
          disabled={busy || !valid || !changed || !!preview}
          onClick={() =>
            void perform(async () => {
              setPreview(
                await ipc.downloadsCleanupPreview({
                  enabled,
                  retentionDays: Number(days),
                }),
              );
              setAll(true);
            })
          }
        >
          Preview changes
        </button>
        {changed && !preview && (
          <p className="mt-2 text-[11px] text-secondary">
            Unsaved changes. Preview and apply to update cleanup.
          </p>
        )}
        {snapshot?.config.enabled && (
          <button
            className={`${button} mt-2`}
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                useDownloadsCleanup
                  .getState()
                  .accept(await ipc.downloadsCleanupDisable());
                setPreview(null);
              })
            }
          >
            Turn off now
          </button>
        )}
      </SettingRow>
      {(!query ||
        "downloads cleanup retention review history keep extend".includes(
          query,
        )) && (
        <div className="py-3">
          {(message || error) && (
            <p role="alert" className="mb-3 text-xs text-danger">
              {message || error}
            </p>
          )}
          {preview && (
            <div className="mb-3 rounded-md border border-edge-strong bg-window p-3 text-xs">
              <p className="font-medium text-primary">
                {preview.snapshot.config.enabled
                  ? `${due.length} file${due.length === 1 ? "" : "s"} already eligible (${formatBytes(due.reduce((sum, i) => sum + i.size, 0))})`
                  : "Automatic cleanup will be turned off"}
              </p>
              <p className="mt-1 text-secondary">
                {preview.snapshot.config.enabled
                  ? "These files can move to Trash at the next daily check, at least one day after applying. Keep or extend individual files below."
                  : "Files stay in Downloads. Your Keep exemptions are preserved."}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  className={`${button} bg-accent text-white`}
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      useDownloadsCleanup
                        .getState()
                        .accept(await ipc.downloadsCleanupApply(preview.token));
                      setPreview(null);
                      setMessage("Cleanup settings saved.");
                    })
                  }
                >
                  Apply settings
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => setPreview(null)}
                >
                  Cancel preview
                </button>
              </div>
            </div>
          )}
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-primary">
              {history
                ? "Cleanup history"
                : `Downloads review (${visible.length})`}
            </span>
            <div className="flex gap-2">
              {!history && (
                <button className={button} onClick={() => setAll(!all)}>
                  {all ? "Upcoming only" : "Show all"}
                </button>
              )}
              <button className={button} onClick={() => setHistory(!history)}>
                {history ? "Review files" : "History"}
              </button>
            </div>
          </div>
          {history ? (
            <div className="max-h-64 overflow-auto divide-y divide-edge">
              {snapshot?.history.length === 0 && (
                <p className="py-3 text-xs text-secondary">
                  Cleanup history will appear here.
                </p>
              )}
              {snapshot?.history.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center gap-2 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate" title={h.original}>
                      {h.original.split("/").pop()}
                    </div>
                    <div className="text-[11px] text-tertiary">
                      {new Date(h.at).toLocaleString()}
                    </div>
                  </div>
                  {h.restored ? (
                    <span className="text-secondary">Restored and kept</span>
                  ) : (
                    <button
                      className={button}
                      disabled={busy || !h.trashed}
                      onClick={() =>
                        void perform(async () =>
                          useDownloadsCleanup.getState().restore(h.id),
                        )
                      }
                    >
                      {h.trashed ? "Restore and keep" : "Check system Trash"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="max-h-72 overflow-auto divide-y divide-edge">
              {!snapshot && !error && (
                <p className="py-3 text-xs text-secondary">
                  Reading Downloads…
                </p>
              )}
              {snapshot && visible.length === 0 && (
                <p className="py-3 text-xs text-secondary">
                  {all
                    ? "No eligible regular files in Downloads."
                    : "No files nearing cleanup."}
                </p>
              )}
              {visible.map((item) => (
                <div key={item.path} className="py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-primary"
                      title={item.name}
                    >
                      {item.name}
                    </span>
                    <span className="shrink-0 text-tertiary">
                      {formatBytes(item.size)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      title={cleanupTooltip(item)}
                      className={`mr-auto ${shown && cleanupNear(item, shown.config.retentionDays, now) ? "text-warning" : "text-secondary"}`}
                    >
                      {item.keep
                        ? "Kept"
                        : shown?.config.enabled
                          ? cleanupLabel(item, now)
                          : "Cleanup off"}
                    </span>
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        action(item, item.keep ? "resume" : "keep")
                      }
                    >
                      {item.keep ? "Resume" : "Keep"}
                    </button>
                    {!item.keep && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => action(item, "extend")}
                      >
                        +7 days
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
