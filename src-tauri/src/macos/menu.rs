//! Native macOS application menu. Normal Edit items route into the same
//! command registry as webview shortcuts, while Undo/Redo labels mirror the
//! backend-owned undo stack.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{App, Emitter, Wry};

use crate::core::undo::UndoStack;

pub const MENU_COMMAND_EVENT: &str = "fazi://menu";

const UNDO_ID: &str = "fazi.edit.undo";
const REDO_ID: &str = "fazi.edit.redo";
const CUT_ID: &str = "fazi.edit.cut";
const COPY_ID: &str = "fazi.edit.copy";
const PASTE_ID: &str = "fazi.edit.paste";
const SELECT_ALL_ID: &str = "fazi.edit.select-all";

pub struct NativeMenu {
    undo: MenuItem<Wry>,
    redo: MenuItem<Wry>,
    commands: Vec<(&'static str, MenuItem<Wry>)>,
    shortcuts: Mutex<HashMap<String, Option<String>>>,
    recording: AtomicBool,
}

impl NativeMenu {
    pub fn sync_undo(&self, stack: &UndoStack) {
        let undo_label = stack.undo_top().map(|op| op.label());
        let redo_label = stack.redo_top().map(|op| op.label());
        let _ = self.undo.set_text(menu_history_label("Undo", undo_label.as_deref()));
        let _ = self.redo.set_text(menu_history_label("Redo", redo_label.as_deref()));
        let _ = self.undo.set_enabled(undo_label.is_some());
        let _ = self.redo.set_enabled(redo_label.is_some());
    }

    pub fn set_shortcuts(&self, shortcuts: HashMap<String, Option<String>>) {
        *self.shortcuts.lock().unwrap() = shortcuts;
        if !self.recording.load(Ordering::SeqCst) {
            self.apply_shortcuts();
        }
    }

    pub fn set_recording(&self, recording: bool) {
        self.recording.store(recording, Ordering::SeqCst);
        if recording {
            for (_, item) in &self.commands {
                let _ = item.set_accelerator(None::<&str>);
            }
        } else {
            self.apply_shortcuts();
        }
    }

    fn apply_shortcuts(&self) {
        let shortcuts = self.shortcuts.lock().unwrap();
        for (command, item) in &self.commands {
            let accelerator = shortcuts
                .get(*command)
                .and_then(|value| value.as_deref())
                .and_then(to_native_accelerator);
            let _ = item.set_accelerator(accelerator.as_deref());
        }
    }
}

pub fn menu_history_label(action: &str, description: Option<&str>) -> String {
    description.map(|label| format!("{action} {label}")).unwrap_or_else(|| action.into())
}

/// Convert the registry's compact shortcut syntax into muda's accelerator
/// syntax. Unsupported keys simply stay webview-only.
pub fn to_native_accelerator(shortcut: &str) -> Option<String> {
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let key = parts.pop()?;
    if key.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for modifier in parts {
        out.push(match modifier {
            "cmd" => "CmdOrCtrl".to_string(),
            "ctrl" => "Ctrl".to_string(),
            "opt" | "alt" => "Alt".to_string(),
            "shift" => "Shift".to_string(),
            _ => return None,
        });
    }
    let native_key = match key {
        "enter" => "Enter".into(),
        "backspace" => "Backspace".into(),
        "delete" => "Delete".into(),
        "space" => "Space".into(),
        "tab" => "Tab".into(),
        "escape" => "Escape".into(),
        "up" => "ArrowUp".into(),
        "down" => "ArrowDown".into(),
        "left" => "ArrowLeft".into(),
        "right" => "ArrowRight".into(),
        value if value.chars().count() == 1 => value.to_uppercase(),
        _ => return None,
    };
    out.push(native_key);
    Some(out.join("+"))
}

pub fn install(app: &mut App<Wry>) -> tauri::Result<std::sync::Arc<NativeMenu>> {
    let undo = MenuItem::with_id(app, UNDO_ID, "Undo", false, None::<&str>)?;
    let redo = MenuItem::with_id(app, REDO_ID, "Redo", false, None::<&str>)?;
    let cut = MenuItem::with_id(app, CUT_ID, "Cut", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, COPY_ID, "Copy", true, None::<&str>)?;
    let paste = MenuItem::with_id(app, PASTE_ID, "Paste", true, None::<&str>)?;
    let select_all = MenuItem::with_id(app, SELECT_ALL_ID, "Select All", true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        "Fazi",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help_menu = Submenu::new(app, "Help", true)?;
    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    app.set_menu(menu)?;

    let native = std::sync::Arc::new(NativeMenu {
        undo: undo.clone(),
        redo: redo.clone(),
        commands: vec![
            ("undo", undo),
            ("redo", redo),
            ("cut", cut),
            ("copy", copy),
            ("paste", paste),
            ("selectAll", select_all),
        ],
        shortcuts: Mutex::new(HashMap::new()),
        recording: AtomicBool::new(false),
    });

    app.on_menu_event(move |handle, event| {
        let command = match event.id().as_ref() {
            UNDO_ID => Some("undo"),
            REDO_ID => Some("redo"),
            CUT_ID => Some("cut"),
            COPY_ID => Some("copy"),
            PASTE_ID => Some("paste"),
            SELECT_ALL_ID => Some("selectAll"),
            _ => None,
        };
        if let Some(command) = command {
            let _ = handle.emit(MENU_COMMAND_EVENT, command);
        }
    });
    Ok(native)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_history_labels() {
        assert_eq!(menu_history_label("Undo", None), "Undo");
        assert_eq!(
            menu_history_label("Undo", Some("Compress of 1 Item")),
            "Undo Compress of 1 Item"
        );
    }

    #[test]
    fn translates_registry_accelerators() {
        assert_eq!(to_native_accelerator("cmd+z").as_deref(), Some("CmdOrCtrl+Z"));
        assert_eq!(
            to_native_accelerator("cmd+shift+z").as_deref(),
            Some("CmdOrCtrl+Shift+Z")
        );
        assert_eq!(to_native_accelerator("cmd+opt+v").as_deref(), Some("CmdOrCtrl+Alt+V"));
    }
}
