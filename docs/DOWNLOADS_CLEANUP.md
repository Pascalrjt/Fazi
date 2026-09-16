# Downloads cleanup

An opt-in policy for the existing `~/Downloads` folder. Browsers and other apps keep their normal download destination. Cleanup is off by default; the retention default is 30 days, configurable from 1 to 3650 days.

## Dates and indicators

The backend computes eligibility as `max(Date Added, Date Modified) + retention`. An explicit extension is a lower bound on that date. Date Added comes from macOS `ATTR_CMN_ADDEDTIME`, independently of creation time and Spotlight indexing. When unavailable, a persisted first-seen timestamp starts the countdown. File identity uses device, inode, and birth time; renames retain Keep and extension choices. A newly created replacement file gets its own identity and retention policy.

The list's sortable Cleanup column and the grid badge share the backend deadline and formatting. They display days, hours, or minutes remaining; after expiry they say “Pending cleanup.” Amber highlighting begins at `min(retention × 20%, 7 days)`. Kept files show an exemption icon. Tooltips explain the date and daily schedule. The folder banner links to review and history.

## Execution and recovery

The Rust worker checks daily while the app process runs. It checks for overdue work within approximately a minute of launch; it has no external background agent. The UI refreshes metadata every minute and on focus. Enabling or changing a policy requires a backend-issued preview token and defers the next check for one day. An active preview pauses cleanup for up to ten minutes. Turning cleanup off takes effect without a preview.

Only regular files directly inside Downloads are eligible. The worker skips subfolders, packages stored as directories, symbolic links, hidden dotfiles, `.crdownload`, `.download`, `.part`, `.partial`, `.tmp`, Fazi staging files, and cloud-only files. Active Fazi operations defer the scan. A bounded `lsof` check skips files held open by another process; an inconclusive check also postpones the file. Metadata and identity are rechecked just before moving each file. Files skipped during a completed scan are reconsidered at the next daily check.

State is written atomically under the app data directory as `downloads-cleanup.json`. A failed or corrupt state read prevents automatic cleanup. Each Trash operation has a persisted intent and resulting path; successful batches also enter the existing undo stack. History's Restore and keep action refuses to overwrite an existing download and exempts the recovered file from future cleanup. Finder's Put Back remains available through the system Trash. Files already removed from Trash cannot be restored. If a crash occurs between the Trash move and recording its resulting path, history directs the user to system Trash.

The app never empties Trash as part of this feature. Moving files to Trash clears Downloads; storage is reclaimed when Trash is emptied separately. General “Reset all settings” preserves the cleanup policy and exemptions, as stated in the settings UI.

## Verification

Rust tests use isolated temporary Downloads and Trash directories with an injected Trash implementation. They cover date calculation, old modification dates on new files, persisted tracking, Keep/Extend across rename and restart, scope exclusions, configuration validation and preview, grace periods, active operations, edits during preflight, history, restore collisions, corrupt state, failed state writes, and open-file detection.

Frontend tests cover countdown units, warning thresholds at short and long retention periods, overdue/Kept states, cleanup sorting, hidden indicators while disabled, and preview-before-apply behavior. The list, grid, settings preview, and light/dark indicators were visually checked in Helium using fixture data; the user's actual Downloads cleanup remained disabled.
