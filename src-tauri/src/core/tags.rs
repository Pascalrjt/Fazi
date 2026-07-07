//! Finder tags: `com.apple.metadata:_kMDItemUserTags` — a binary plist array
//! of strings shaped `"Name\n<color>"` (color 0–7) or bare `"Name"`.

use std::io::Cursor;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const TAGS_XATTR: &str = "com.apple.metadata:_kMDItemUserTags";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FinderTag {
    pub name: String,
    /// 0 none, 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange
    pub color: u8,
}

/// Color index for the built-in single-color tags Finder creates.
pub fn builtin_color_for_name(name: &str) -> Option<u8> {
    match name {
        "Gray" | "Grey" => Some(1),
        "Green" => Some(2),
        "Purple" => Some(3),
        "Blue" => Some(4),
        "Yellow" => Some(5),
        "Red" => Some(6),
        "Orange" => Some(7),
        _ => None,
    }
}

pub fn read_tags(path: &Path) -> Vec<FinderTag> {
    let Ok(Some(raw)) = xattr::get(path, TAGS_XATTR) else {
        return Vec::new();
    };
    parse_tags(&raw)
}

pub fn parse_tags(raw: &[u8]) -> Vec<FinderTag> {
    let Ok(items) = plist::from_reader::<_, Vec<String>>(Cursor::new(raw)) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|s| match s.split_once('\n') {
            Some((name, color)) => FinderTag {
                name: name.to_string(),
                color: color.parse().unwrap_or(0),
            },
            None => FinderTag {
                name: s.clone(),
                color: builtin_color_for_name(s).unwrap_or(0),
            },
        })
        .collect()
}

pub fn write_tags(path: &Path, tags: &[FinderTag]) -> std::io::Result<()> {
    if tags.is_empty() {
        // Match Finder: removing all tags removes the xattr.
        match xattr::remove(path, TAGS_XATTR) {
            Ok(()) => return Ok(()),
            Err(e) if e.raw_os_error() == Some(libc::ENOATTR) => return Ok(()),
            Err(e) => return Err(e),
        }
    }
    let items: Vec<String> = tags
        .iter()
        .map(|t| format!("{}\n{}", t.name, t.color))
        .collect();
    let mut buf = Vec::new();
    plist::to_writer_binary(&mut buf, &items)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    xattr::set(path, TAGS_XATTR, &buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("fazi-tags-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("tagged.txt");
        std::fs::write(&f, b"x").unwrap();

        let tags = vec![
            FinderTag { name: "Red".into(), color: 6 },
            FinderTag { name: "ProjectX".into(), color: 0 },
        ];
        write_tags(&f, &tags).unwrap();
        assert_eq!(read_tags(&f), tags);

        // Clearing removes the xattr entirely.
        write_tags(&f, &[]).unwrap();
        assert_eq!(read_tags(&f), Vec::new());
        assert!(xattr::get(&f, TAGS_XATTR).unwrap().is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parses_bare_color_names() {
        let mut buf = Vec::new();
        plist::to_writer_binary(&mut buf, &vec!["Red".to_string(), "Custom".to_string()]).unwrap();
        let tags = parse_tags(&buf);
        assert_eq!(tags[0], FinderTag { name: "Red".into(), color: 6 });
        assert_eq!(tags[1], FinderTag { name: "Custom".into(), color: 0 });
    }
}
