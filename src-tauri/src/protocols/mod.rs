//! Custom URI schemes: icon://, thumb://, preview://.
//!
//! Security posture: handlers resolve opaque per-session tokens minted by the
//! listing/search/preview commands — never URL-supplied paths. Unknown token
//! → 404. preview:// serves only paths explicitly registered by the
//! open-preview command and revoked on close.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

use crate::concurrency::WorkerPool;
use crate::state::AppState;

/// Bounded worker pools for the protocol handlers (a thread per request
/// spawned hundreds of threads on a fast scroll). Icon misses mostly wait on
/// the main thread; thumbnails have more workers than Quick Look permits so
/// disk-cache hits and icon fallbacks keep flowing while QL renders.
pub fn icon_pool() -> &'static WorkerPool {
    static POOL: OnceLock<WorkerPool> = OnceLock::new();
    POOL.get_or_init(|| WorkerPool::new("fazi-icon", 4))
}

pub fn thumb_pool() -> &'static WorkerPool {
    static POOL: OnceLock<WorkerPool> = OnceLock::new();
    POOL.get_or_init(|| WorkerPool::new("fazi-thumb", 6))
}

pub fn preview_pool() -> &'static WorkerPool {
    static POOL: OnceLock<WorkerPool> = OnceLock::new();
    POOL.get_or_init(|| WorkerPool::new("fazi-preview", 3))
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Vec::new())
        .unwrap()
}

fn png_response(bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(bytes)
        .unwrap()
}

/// Parsed `scheme://localhost/<token>?size=NN&v=REV`. `v` is a content
/// revision for the webview's HTTP cache only; backend caches validate
/// against the file itself, so it is accepted and ignored here.
struct ImageRequest {
    token: String,
    size: u32,
}

fn query_param<'a>(uri: &'a tauri::http::Uri, key: &str) -> Option<&'a str> {
    uri.query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then_some(v)
    })
}

fn parse_image_request(uri: &tauri::http::Uri) -> ImageRequest {
    let token = uri.path().trim_start_matches('/').to_string();
    let size = query_param(uri, "size").and_then(|v| v.parse::<u32>().ok()).unwrap_or(32);
    ImageRequest { token, size }
}

pub fn handle_icon<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let ImageRequest { token, size } = parse_image_request(request.uri());
    let Some(path) = state.tokens.resolve(&token) else {
        return not_found();
    };
    match crate::macos::icons::icon_png(app, &state.icon_cache, &path, size) {
        Some(png) => png_response(png.as_ref().clone()),
        None => not_found(),
    }
}

pub fn handle_thumb<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let ImageRequest { token, size } = parse_image_request(request.uri());
    let Some(path) = state.tokens.resolve(&token) else {
        return not_found();
    };
    // While its volume is being ejected, never start a Quick Look render
    // (the thumbnailer would hold the file open and veto the unmount).
    let thumb = if state.volume_gate.is_blocked(&path) {
        crate::macos::thumbnails::cached_thumbnail_png(&state.thumb_cache_dir, &path, size)
    } else {
        crate::macos::thumbnails::thumbnail_png(&state.thumb_cache_dir, &path, size)
    };
    if let Some(png) = thumb {
        return png_response(png);
    }
    // Fallback: the plain icon at the requested size.
    match crate::macos::icons::icon_png(app, &state.icon_cache, &path, size) {
        Some(png) => png_response(png.as_ref().clone()),
        None => not_found(),
    }
}

fn mime_for(path: &Path) -> Cow<'static, str> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Cow::Borrowed(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" | "heif" => "image/heic",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" | "qt" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    })
}

/// Webview origins allowed to `fetch()` preview:// bytes (the PDF renderer).
/// Prod WKWebView pages live at tauri://localhost; dev at the Vite devUrl.
/// The request Origin is echoed only when it matches — never a wildcard.
const PREVIEW_FETCH_ORIGINS: &[&str] = &["tauri://localhost", "http://localhost:1420"];

pub fn allowed_fetch_origin(origin: Option<&str>) -> Option<&str> {
    origin.filter(|o| PREVIEW_FETCH_ORIGINS.contains(o))
}

fn with_cors(mut resp: Response<Vec<u8>>, origin: Option<&str>) -> Response<Vec<u8>> {
    if let Some(o) = origin {
        if let Ok(v) = o.parse() {
            resp.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            resp.headers_mut().insert(header::VARY, header::HeaderValue::from_static("Origin"));
        }
    }
    resp
}

/// preview:// — raw bytes for registered tokens, with HTTP Range support so
/// <video>/<audio> can seek. CORS: <img>/<video> loads need no CORS headers,
/// but the PDF renderer uses `fetch()`, which does — the allow-listed request
/// Origin is echoed back.
pub fn handle_preview<R: Runtime>(
    app: &AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    with_cors(
        preview_response(app, request),
        allowed_fetch_origin(origin.as_deref()),
    )
}

fn preview_response<R: Runtime>(
    app: &AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let token = request.uri().path().trim_start_matches('/').to_string();
    let Some(path) = state.previews.get(&token).map(|p| p.clone()) else {
        return not_found();
    };
    // Media players re-request ranges continuously; each request opens the
    // file, which would veto an in-flight eject of its volume.
    if state.volume_gate.is_blocked(&path) {
        return not_found();
    }
    let Ok(mut file) = std::fs::File::open(&path) else {
        return not_found();
    };
    let Ok(meta) = file.metadata() else {
        return not_found();
    };
    let total = meta.len();
    let mime = mime_for(&path);

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range);

    match range {
        Some((start, end_opt)) if start < total => {
            // Cap chunk size so huge seeks stay snappy.
            const MAX_CHUNK: u64 = 8 * 1024 * 1024;
            let end = end_opt.unwrap_or(total - 1).min(total - 1).min(start + MAX_CHUNK - 1);
            let len = end - start + 1;
            let mut buf = vec![0u8; len as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
                return not_found();
            }
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .header(header::ACCEPT_RANGES, "bytes")
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", start, end, total),
                )
                .body(buf)
                .unwrap()
        }
        _ => {
            // Full response (bounded: refuse >256 MB without a Range).
            if total > 256 * 1024 * 1024 {
                let mut buf = vec![0u8; 8 * 1024 * 1024];
                if file.read_exact(&mut buf).is_err() {
                    return not_found();
                }
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, mime.as_ref())
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_RANGE, format!("bytes 0-{}/{}", buf.len() - 1, total))
                    .body(buf)
                    .unwrap();
            }
            let mut buf = Vec::with_capacity(total as usize);
            if file.read_to_end(&mut buf).is_err() {
                return not_found();
            }
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, total.to_string())
                .body(buf)
                .unwrap()
        }
    }
}

/// Parse "bytes=start-end" / "bytes=start-".
fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end: Option<u64> = if end.is_empty() { None } else { end.parse().ok() };
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::{allowed_fetch_origin, parse_image_request, parse_range};

    #[test]
    fn image_urls_tolerate_the_revision_param() {
        for (u, size) in [
            ("thumb://localhost/abc123?size=128&v=1700000000123-42", 128),
            ("icon://localhost/abc123?v=7-1&size=64", 64),
            ("icon://localhost/abc123?size=16", 16),
            ("icon://localhost/abc123?v=7-1", 32),
        ] {
            let uri: tauri::http::Uri = u.parse().unwrap();
            let r = parse_image_request(&uri);
            assert_eq!((r.token.as_str(), r.size), ("abc123", size), "{u}");
        }
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99"), Some((0, Some(99))));
        assert_eq!(parse_range("bytes=500-"), Some((500, None)));
        assert_eq!(parse_range("chunks=1-2"), None);
        assert_eq!(parse_range("bytes=x-2"), None);
    }

    #[test]
    fn preview_cors_origin_allow_list() {
        assert_eq!(allowed_fetch_origin(Some("tauri://localhost")), Some("tauri://localhost"));
        assert_eq!(
            allowed_fetch_origin(Some("http://localhost:1420")),
            Some("http://localhost:1420")
        );
        // Never a wildcard, never an unknown origin, never absent.
        assert_eq!(allowed_fetch_origin(Some("https://evil.example")), None);
        assert_eq!(allowed_fetch_origin(Some("*")), None);
        assert_eq!(allowed_fetch_origin(None), None);
    }
}
