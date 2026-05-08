use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use std::io::Cursor;
use tauri::{AppHandle, Emitter, Manager};
use xcap::Monitor;

use crate::AppState;

#[derive(Serialize, Clone)]
pub struct CapturedImages {
    pub focus:      String,
    pub context:    String,
    pub focus_mime: String,
}

// -------------------------------------------------------
// Public commands

#[tauri::command]
pub async fn capture_and_show(
    app:          AppHandle,
    state:        tauri::State<'_, AppState>,
    x:            f64,
    y:            f64,
    width:        f64,
    height:       f64,
    scale_factor: f64,
    full_screen:  bool,
) -> Result<(), String> {
    // Hold the screenshot lock just long enough to clone what we need, then drop it.
    let (focus_img, full_img) = {
        let lock = state.screenshot.lock().unwrap();
        let full = lock.as_ref().ok_or("No screenshot buffered")?;

        let px = (x * scale_factor) as u32;
        let py = (y * scale_factor) as u32;
        let pw = (width  * scale_factor) as u32;
        let ph = (height * scale_factor) as u32;

        let img_w = full.width();
        let img_h = full.height();
        let px = px.min(img_w.saturating_sub(1));
        let py = py.min(img_h.saturating_sub(1));
        let pw = pw.min(img_w - px);
        let ph = ph.min(img_h - py);

        (full.crop_imm(px, py, pw, ph), full.clone())
    };

    let (focus_b64, context_b64, focus_mime) = if full_screen {
        // Click with no crop: send the full screenshot as a single 1080p JPEG.
        // No separate context — the whole screen IS the content.
        let handle = tokio::task::spawn_blocking(move || {
            encode_jpeg_b64(resize_to_height(full_img, 1080))
        });
        let f = handle.await.map_err(|e| e.to_string())??;
        (f, String::new(), "image/jpeg".to_string())
    } else {
        // Normal crop: focus as lossless PNG, context downscaled to 720p JPEG.
        let focus_handle   = tokio::task::spawn_blocking(move || encode_png_b64(resize_to_fit(focus_img, 800)));
        let context_handle = tokio::task::spawn_blocking(move || {
            encode_jpeg_b64(resize_to_height(full_img, 480))
        });
        let (focus_res, context_res) = tokio::join!(focus_handle, context_handle);
        let f = focus_res  .map_err(|e| e.to_string())??;
        let c = context_res.map_err(|e| e.to_string())??;
        (f, c, "image/png".to_string())
    };

    *state.focus_b64.lock().unwrap()   = Some(focus_b64.clone());
    *state.context_b64.lock().unwrap() = Some(context_b64.clone());
    *state.focus_mime.lock().unwrap()  = Some(focus_mime.clone());

    if let Some(chat) = app.get_webview_window("chat") {
        let _ = chat.emit("chat:images", CapturedImages {
            focus:      focus_b64,
            context:    context_b64,
            focus_mime,
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn get_cached_images(
    state: tauri::State<'_, AppState>,
) -> Result<CapturedImages, String> {
    let focus      = state.focus_b64.lock().unwrap().clone().ok_or("No cached images")?;
    let context    = state.context_b64.lock().unwrap().clone().unwrap_or_default();
    let focus_mime = state.focus_mime.lock().unwrap().clone().unwrap_or_else(|| "image/png".to_string());
    Ok(CapturedImages { focus, context, focus_mime })
}

// -------------------------------------------------------
// Internals

pub struct MonitorCapture {
    pub image:     DynamicImage,
    pub x:         i32,
    pub y:         i32,
    pub logical_w: u32,
    pub logical_h: u32,
}

pub fn capture_screen_at_cursor() -> Result<MonitorCapture, String> {
    let (cx, cy) = platform_cursor_pos();
    let monitors = Monitor::all().map_err(|e| e.to_string())?;

    let monitor = monitors
        .iter()
        .find(|m| {
            cx >= m.x()
                && cx < m.x() + m.width() as i32
                && cy >= m.y()
                && cy < m.y() + m.height() as i32
        })
        .or_else(|| monitors.iter().find(|m| m.is_primary()))
        .ok_or_else(|| "No monitor found".to_string())?;

    let rgba = monitor.capture_image().map_err(|e| e.to_string())?;
    Ok(MonitorCapture {
        image:     DynamicImage::ImageRgba8(rgba),
        x:         monitor.x(),
        y:         monitor.y(),
        logical_w: monitor.width(),
        logical_h: monitor.height(),
    })
}

#[cfg(target_os = "windows")]
fn platform_cursor_pos() -> (i32, i32) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut pt) };
    (pt.x, pt.y)
}

#[cfg(not(target_os = "windows"))]
fn platform_cursor_pos() -> (i32, i32) {
    if let Ok(monitors) = Monitor::all() {
        if let Some(m) = monitors.into_iter().find(|m| m.is_primary()) {
            return (m.x() + m.width() as i32 / 2, m.y() + m.height() as i32 / 2);
        }
    }
    (0, 0)
}

fn resize_to_height(img: DynamicImage, max_h: u32) -> DynamicImage {
    if img.height() <= max_h { return img; }
    let w = (img.width() as f64 * max_h as f64 / img.height() as f64).round() as u32;
    img.resize(w.max(1), max_h, image::imageops::FilterType::Triangle)
}

fn resize_to_fit(img: DynamicImage, max_side: u32) -> DynamicImage {
    let longest = img.width().max(img.height());
    if longest <= max_side { return img; }
    let scale = max_side as f64 / longest as f64;
    let w = (img.width()  as f64 * scale).round() as u32;
    let h = (img.height() as f64 * scale).round() as u32;
    img.resize(w.max(1), h.max(1), image::imageops::FilterType::Triangle)
}

fn encode_png_b64(img: DynamicImage) -> Result<String, String> {
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(BASE64.encode(&buf))
}

fn encode_jpeg_b64(img: DynamicImage) -> Result<String, String> {
    let mut buf = Vec::new();
    DynamicImage::ImageRgb8(img.to_rgb8())
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(BASE64.encode(&buf))
}
