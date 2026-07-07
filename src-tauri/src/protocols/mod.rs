//! Custom URI schemes: icon://, thumb://, preview://.
//!
//! Security posture: handlers resolve opaque per-session tokens minted by the
//! listing/search/preview commands — never URL-supplied paths. Unknown token
//! → 404. preview:// serves only paths explicitly registered by the
//! open-preview command and revoked on close.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;

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

/// Parse `scheme://localhost/<token>?size=NN`.
fn parse_token_and_size(uri: &tauri::http::Uri) -> (String, u32) {
    let token = uri.path().trim_start_matches('/').to_string();
    let size = uri
        .query()
        .and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("size="))
                .and_then(|v| v.parse::<u32>().ok())
        })
        .unwrap_or(32);
    (token, size)
}

pub fn handle_icon<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let (token, size) = parse_token_and_size(request.uri());
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
    let (token, size) = parse_token_and_size(request.uri());
    let Some(path) = state.tokens.resolve(&token) else {
        return not_found();
    };
    if let Some(png) = crate::macos::thumbnails::thumbnail_png(&state.thumb_cache_dir, &path, size) {
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

/// preview:// — raw bytes for registered tokens, with HTTP Range support so
/// <video>/<audio> can seek.
pub fn handle_preview<R: Runtime>(
    app: &AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let token = request.uri().path().trim_start_matches('/').to_string();
    let Some(path) = state.previews.get(&token).map(|p| p.clone()) else {
        return not_found();
    };
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
    use super::parse_range;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99"), Some((0, Some(99))));
        assert_eq!(parse_range("bytes=500-"), Some((500, None)));
        assert_eq!(parse_range("chunks=1-2"), None);
        assert_eq!(parse_range("bytes=x-2"), None);
    }
}
