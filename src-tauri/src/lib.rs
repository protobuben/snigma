mod ai;
mod capture;

use std::str::FromStr;
use std::sync::Mutex;

use image::DynamicImage;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub struct AppState {
    pub screenshot:       Mutex<Option<DynamicImage>>,
    pub focus_b64:        Mutex<Option<String>>,
    pub context_b64:      Mutex<Option<String>>,
    pub focus_mime:       Mutex<Option<String>>,
    pub is_licensed:      Mutex<bool>,
    pub current_shortcut: Mutex<Option<Shortcut>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            screenshot:       Mutex::new(None),
            focus_b64:        Mutex::new(None),
            context_b64:      Mutex::new(None),
            focus_mime:       Mutex::new(None),
            is_licensed:      Mutex::new(false),
            current_shortcut: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn set_license_state(state: tauri::State<'_, AppState>, licensed: bool) {
    *state.is_licensed.lock().unwrap() = licensed;
}

#[tauri::command]
fn set_hotkey(
    app:   AppHandle,
    state: tauri::State<'_, AppState>,
    ctrl:  bool,
    shift: bool,
    alt:   bool,
    meta:  bool,
    code:  String,
) -> Result<(), String> {
    let mut mods = Modifiers::empty();
    if ctrl  { mods |= Modifiers::CONTROL; }
    if shift { mods |= Modifiers::SHIFT;   }
    if alt   { mods |= Modifiers::ALT;     }
    if meta  { mods |= Modifiers::SUPER;   }

    let key      = Code::from_str(&code).map_err(|_| format!("unknown key code: {code}"))?;
    let new_shortcut = Shortcut::new(Some(mods), key);

    let gs = app.global_shortcut();

    // Unregister the previous shortcut if any.
    if let Some(prev) = state.current_shortcut.lock().unwrap().take() {
        let _ = gs.unregister(prev);
    }

    let handle = app.clone();
    gs.on_shortcut(new_shortcut, move |app, _sc, event| {
        if event.state != ShortcutState::Pressed { return; }
        on_hotkey_pressed(app, &handle);
    }).map_err(|e| e.to_string())?;

    *state.current_shortcut.lock().unwrap() = Some(new_shortcut);
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(AppState::default())
        .setup(|app| {
            setup_tray(app)?;
            register_default_hotkey(app);

            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            capture::capture_and_show,
            capture::get_cached_images,
            ai::send_to_ai,
            set_license_state,
            set_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error running Snigma");
}

// -------------------------------------------------------
// Tray

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let settings_item = MenuItemBuilder::with_id("settings", "Settings…").build(app)?;
    let quit_item     = MenuItemBuilder::with_id("quit", "Quit Snigma").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&settings_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let icon = app.default_window_icon()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no app icon found"))?
        .clone();

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => open_main_window(app),
            "quit"     => app.exit(0),
            _          => {}
        })
        .build(app)?;

    Ok(())
}

fn open_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// -------------------------------------------------------
// Hotkey

fn register_default_hotkey(app: &mut tauri::App) {
    #[cfg(target_os = "macos")]
    let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
    #[cfg(not(target_os = "macos"))]
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

    let handle = app.handle().clone();

    match app.global_shortcut().on_shortcut(shortcut, move |app, _sc, event| {
        if event.state != ShortcutState::Pressed { return; }
        on_hotkey_pressed(app, &handle);
    }) {
        Ok(_) => {
            *app.state::<AppState>().current_shortcut.lock().unwrap() = Some(shortcut);
        }
        Err(e) => {
            // Another process (e.g. a previously-installed Snigma build) already
            // holds the hotkey. Don't crash — the user can reassign it in Settings.
            eprintln!("Could not register default hotkey (already taken?): {e}");
        }
    }
}

fn on_hotkey_pressed(app: &AppHandle, handle: &AppHandle) {
    let state = app.state::<AppState>();
    if !*state.is_licensed.lock().unwrap() {
        open_main_window(handle);
        return;
    }

    match capture::capture_screen_at_cursor() {
        Ok(cap) => {
            *state.screenshot.lock().unwrap() = Some(cap.image);
            if let Some(w) = app.get_webview_window("capture") {
                let _ = w.set_fullscreen(false);
                let _ = w.set_position(tauri::LogicalPosition::new(cap.x as f64, cap.y as f64));
                let _ = w.set_size(tauri::LogicalSize::new(cap.logical_w as f64, cap.logical_h as f64));
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.emit("overlay:start", ());
            }
        }
        Err(e) => eprintln!("Screen capture failed: {e}"),
    }
}
