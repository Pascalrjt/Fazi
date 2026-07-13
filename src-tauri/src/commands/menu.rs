use std::collections::HashMap;

use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn set_shortcut_recording(state: State<'_, AppState>, recording: bool) {
    state.native_menu.set_recording(recording);
}

#[tauri::command]
pub fn set_native_menu_shortcuts(
    state: State<'_, AppState>,
    shortcuts: HashMap<String, Option<String>>,
) {
    state.native_menu.set_shortcuts(shortcuts);
}
