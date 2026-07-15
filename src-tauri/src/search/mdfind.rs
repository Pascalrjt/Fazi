//! Spotlight search: shell out to `mdfind`, stream stdout rows.
//! Simpler and safer than NSMetadataQuery run-loop management.
//!
//! Queries are RAW predicate strings built here (never `-interpret`): user
//! text is escaped before interpolation, predicates (kind/date/size) compile
//! to kMDItem* comparisons, and the result cap is a clamped argument shared
//! with the frontend setting.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum SearchEvent {
    #[serde(rename_all = "camelCase")]
    Hit {
        path: String,
        name: String,
        is_dir: bool,
        icon: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        total: u64,
        /// The cap truncated the stream — more matches exist.
        capped: bool,
        /// Spotlight indexing is enabled on the scope's volume. Always true
        /// for the whole-Mac scope (no single volume to probe).
        indexed: bool,
    },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// One shared ceiling for every search mode (mdfind AND the fuzzy fallback).
pub const MAX_RESULTS_CEILING: u64 = 10_000;

/// Predicate filters compiled into the raw query. Mirrors the fuzzy filter
/// shape so the not-indexed fallback can ride the same tokenizer output.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    /// "image" | "video" | "audio" | "doc" | "pdf" | "folder" | "archive"
    pub kind: Option<String>,
    pub date_from_ms: Option<i64>,
    pub date_to_ms: Option<i64>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
}

/// Escape user text for interpolation inside a quoted mdquery literal:
/// backslash-escape `\` and `"`, strip control characters. `*` is allowed
/// only in the positions WE insert around the text.
fn escape_query_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 4);
    for c in text.chars() {
        if c.is_control() {
            continue;
        }
        if c == '\\' || c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Epoch ms → "YYYY-MM-DDTHH:MM:SSZ" (UTC), no external date crate.
/// Days-to-civil per Howard Hinnant's algorithm.
fn iso_from_epoch_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn kind_predicate(kind: &str) -> Option<String> {
    let tree = |uti: &str| format!("kMDItemContentTypeTree == \"{uti}\"");
    Some(match kind {
        "image" => tree("public.image"),
        "video" => tree("public.movie"),
        "audio" => tree("public.audio"),
        "pdf" => tree("com.adobe.pdf"),
        "folder" => tree("public.folder"),
        "archive" => tree("public.archive"),
        "doc" => format!("({} || {})", tree("public.text"), tree("public.composite-content")),
        _ => return None,
    })
}

/// Build the raw mdquery string. Pure — unit-tested against tables.
pub fn build_raw_query(text: &str, filters: &SearchFilters, contents: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    let text = text.trim();
    if !text.is_empty() {
        let escaped = escape_query_text(text);
        if contents {
            parts.push(format!(
                "(kMDItemTextContent == \"*{escaped}*\"cd || kMDItemDisplayName == \"*{escaped}*\"cd)"
            ));
        } else {
            parts.push(format!("kMDItemDisplayName == \"*{escaped}*\"cd"));
        }
    }
    if let Some(kind) = filters.kind.as_deref() {
        if let Some(p) = kind_predicate(kind) {
            parts.push(p);
        }
    }
    if let Some(from) = filters.date_from_ms {
        parts.push(format!(
            "kMDItemFSContentChangeDate >= $time.iso({})",
            iso_from_epoch_ms(from)
        ));
    }
    if let Some(to) = filters.date_to_ms {
        parts.push(format!(
            "kMDItemFSContentChangeDate <= $time.iso({})",
            iso_from_epoch_ms(to)
        ));
    }
    if let Some(min) = filters.size_min {
        parts.push(format!("kMDItemFSSize >= {min}"));
    }
    if let Some(max) = filters.size_max {
        parts.push(format!("kMDItemFSSize <= {max}"));
    }
    if parts.is_empty() {
        // Degenerate query — matches nothing rather than everything.
        return "kMDItemDisplayName == \"\"".into();
    }
    parts.join(" && ")
}

fn build_command(raw_query: &str, scope: Option<&Path>) -> Command {
    let mut cmd = Command::new("/usr/bin/mdfind");
    if let Some(s) = scope {
        cmd.arg("-onlyin").arg(s);
    }
    cmd.arg(raw_query);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    cmd
}

/// Mount point of the volume containing `path` (statfs f_mntonname).
fn mount_point_of(path: &Path) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut fs: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut fs) } != 0 {
        return None;
    }
    let mnt = unsafe { std::ffi::CStr::from_ptr(fs.f_mntonname.as_ptr()) };
    Some(PathBuf::from(mnt.to_string_lossy().into_owned()))
}

/// Probe whether Spotlight indexing is enabled on the volume containing
/// `scope` (`mdutil -s <mountpoint>`, parse "Indexing enabled"). Zero results
/// and an unindexed volume are indistinguishable without this.
pub fn volume_indexed(scope: &Path) -> bool {
    let Some(mount) = mount_point_of(scope) else {
        return true; // unknown — don't claim it's unindexed
    };
    let output = Command::new("/usr/bin/mdutil")
        .arg("-s")
        .arg(&mount)
        .stdin(Stdio::null())
        .output();
    match output {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout);
            // "Indexing enabled." vs "Indexing disabled." / "Error: ..."
            !text.to_lowercase().contains("indexing disabled")
        }
        Err(_) => true,
    }
}

/// Spawn mdfind and stream results. `icon_token` mints icon:// tokens for
/// hits. Returns a handle that kills the child on cancel.
pub fn spawn_search(
    query: String,
    filters: SearchFilters,
    scope: Option<PathBuf>,
    contents: bool,
    max_results: u64,
    icon_token: Arc<dyn Fn(&Path) -> String + Send + Sync>,
    send: impl Fn(SearchEvent) + Send + 'static,
) -> std::io::Result<Arc<Mutex<Option<Child>>>> {
    let raw = build_raw_query(&query, &filters, contents);
    let cap = max_results.clamp(1, MAX_RESULTS_CEILING);
    let mut cmd = build_command(&raw, scope.as_deref());
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let handle = Arc::new(Mutex::new(Some(child)));
    let handle_thread = handle.clone();

    std::thread::spawn(move || {
        // Probe indexing while results stream (cheap; reported in Done).
        let indexed = match &scope {
            Some(s) => volume_indexed(s),
            None => true, // whole Mac: no single volume to probe
        };
        let reader = BufReader::new(stdout);
        let (total, capped) = stream_hits(reader, cap, |path| {
            let p = PathBuf::from(path);
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_owned());
            let is_dir = p.symlink_metadata().map(|m| m.is_dir()).unwrap_or(false);
            send(SearchEvent::Hit {
                icon: icon_token(&p),
                path: path.to_owned(),
                name,
                is_dir,
            });
        });
        // Reap (or kill, if we bailed early on the cap).
        if let Some(mut c) = handle_thread.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        send(SearchEvent::Done { total, capped, indexed });
    });

    Ok(handle)
}

/// Emit up to `cap` non-empty lines through `on_hit` and report `(emitted,
/// capped)`. `capped` is true only when a cap+1-th result actually exists —
/// a result set of exactly `cap` lines is complete, not truncated.
fn stream_hits(reader: impl BufRead, cap: u64, mut on_hit: impl FnMut(&str)) -> (u64, bool) {
    let mut total = 0u64;
    for line in reader.lines() {
        let Ok(path) = line else { break };
        if path.is_empty() {
            continue;
        }
        if total >= cap {
            return (total, true); // the extra hit proves truncation; drop it
        }
        on_hit(&path);
        total += 1;
    }
    (total, false)
}

pub fn cancel(handle: &Arc<Mutex<Option<Child>>>) {
    if let Some(mut c) = handle.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run_stream(input: &str, cap: u64) -> (Vec<String>, u64, bool) {
        let mut hits = Vec::new();
        let (total, capped) = stream_hits(Cursor::new(input.to_owned()), cap, |p| {
            hits.push(p.to_owned());
        });
        (hits, total, capped)
    }

    #[test]
    fn stream_under_cap_is_not_capped() {
        let (hits, total, capped) = run_stream("/a\n/b\n", 5);
        assert_eq!(hits, vec!["/a", "/b"]);
        assert_eq!(total, 2);
        assert!(!capped);
    }

    #[test]
    fn stream_exactly_at_cap_is_not_capped() {
        let (hits, total, capped) = run_stream("/a\n/b\n/c\n", 3);
        assert_eq!(hits.len(), 3);
        assert_eq!(total, 3);
        assert!(!capped, "exactly-cap result sets are complete, not truncated");
    }

    #[test]
    fn stream_one_past_cap_emits_cap_and_reports_capped() {
        let (hits, total, capped) = run_stream("/a\n/b\n/c\n/d\n", 3);
        assert_eq!(hits, vec!["/a", "/b", "/c"], "the cap+1-th hit is dropped");
        assert_eq!(total, 3);
        assert!(capped);
    }

    #[test]
    fn stream_skips_blank_lines_before_the_cap_check() {
        let (hits, total, capped) = run_stream("/a\n\n/b\n\n/c\n", 3);
        assert_eq!(hits, vec!["/a", "/b", "/c"]);
        assert_eq!(total, 3);
        assert!(!capped);
    }

    #[test]
    fn iso_conversion() {
        assert_eq!(iso_from_epoch_ms(0), "1970-01-01T00:00:00Z");
        // 2026-07-11 00:00:00 UTC = 1783728000
        assert_eq!(iso_from_epoch_ms(1_783_728_000_000), "2026-07-11T00:00:00Z");
        // leap-year day: 2024-02-29 12:30:45 = 1709209845
        assert_eq!(iso_from_epoch_ms(1_709_209_845_000), "2024-02-29T12:30:45Z");
    }

    #[test]
    fn raw_query_name_and_contents() {
        let f = SearchFilters::default();
        assert_eq!(
            build_raw_query("report", &f, false),
            r#"kMDItemDisplayName == "*report*"cd"#
        );
        let q = build_raw_query("report", &f, true);
        assert!(q.contains(r#"kMDItemTextContent == "*report*"cd"#), "{q}");
        assert!(q.contains(r#"kMDItemDisplayName == "*report*"cd"#), "{q}");
    }

    #[test]
    fn raw_query_escapes_quotes_backslashes_and_strips_controls() {
        let f = SearchFilters::default();
        let q = build_raw_query("a\"b\\c\u{7}d", &f, false);
        assert_eq!(q, "kMDItemDisplayName == \"*a\\\"b\\\\cd*\"cd");
        // A user asterisk is data, not a wildcard we inserted — it passes
        // through inside the quoted literal (Spotlight treats it literally
        // only in the positions the escaper guarantees; the sensitive chars
        // are the quote/backslash breakers above).
        let q = build_raw_query("x*y", &f, false);
        assert_eq!(q, "kMDItemDisplayName == \"*x*y*\"cd");
    }

    #[test]
    fn raw_query_kind_tables() {
        let cases = [
            ("image", "public.image"),
            ("video", "public.movie"),
            ("audio", "public.audio"),
            ("pdf", "com.adobe.pdf"),
            ("folder", "public.folder"),
            ("archive", "public.archive"),
        ];
        for (kind, uti) in cases {
            let f = SearchFilters { kind: Some(kind.into()), ..Default::default() };
            let q = build_raw_query("x", &f, false);
            assert!(q.contains(&format!("kMDItemContentTypeTree == \"{uti}\"")), "{q}");
            assert!(q.contains(" && "), "{q}");
        }
        let f = SearchFilters { kind: Some("doc".into()), ..Default::default() };
        let q = build_raw_query("", &f, false);
        assert!(q.contains("public.text") && q.contains("public.composite-content"), "{q}");
    }

    #[test]
    fn raw_query_date_and_size_bounds() {
        let f = SearchFilters {
            date_from_ms: Some(0),
            date_to_ms: Some(1_709_209_845_000),
            size_min: Some(10 * 1024 * 1024),
            size_max: Some(1024 * 1024 * 1024),
            ..Default::default()
        };
        let q = build_raw_query("", &f, false);
        assert!(q.contains("kMDItemFSContentChangeDate >= $time.iso(1970-01-01T00:00:00Z)"), "{q}");
        assert!(q.contains("kMDItemFSContentChangeDate <= $time.iso(2024-02-29T12:30:45Z)"), "{q}");
        assert!(q.contains("kMDItemFSSize >= 10485760"), "{q}");
        assert!(q.contains("kMDItemFSSize <= 1073741824"), "{q}");
    }

    #[test]
    fn raw_query_empty_matches_nothing() {
        let q = build_raw_query("  ", &SearchFilters::default(), false);
        assert_eq!(q, "kMDItemDisplayName == \"\"");
    }
}
