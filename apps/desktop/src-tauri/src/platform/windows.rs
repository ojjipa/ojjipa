// TODO [Farhan, by 10/10/2026]: Explain Win32 call sequence.
// - GetForegroundWindow → which window
// - GetWindowThreadProcessId → which process owns it
// - OpenProcess + QueryFullProcessImageNameW → what program it is
// - Why PROCESS_QUERY_LIMITED_INFORMATION (full access needs admin)
use super::ActiveWindow;
use std::path::Path;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

pub(super) fn active_window() -> Result<Option<ActiveWindow>, String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd == HWND::default() {
        return Ok(None);
    }

    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    if process_id == 0 {
        return Ok(None);
    }

    let mut title_buffer = [0_u16; 2048];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buffer) };
    let title = (title_len > 0)
        .then(|| String::from_utf16_lossy(&title_buffer[..title_len as usize]));

    Ok(Some(ActiveWindow {
        title,
        app_name: process_image_path(process_id)
            .and_then(|path| Path::new(&path).file_stem()?.to_str().map(str::to_owned)),
        app_identifier: None,
        accessibility_permission_required: false,
    }))
}

fn process_image_path(process_id: u32) -> Option<String> {
    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?
    };

    let mut path_buffer = [0_u16; 32_768];
    let mut path_len = path_buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            PWSTR(path_buffer.as_mut_ptr()),
            &mut path_len,
        )
    };
    let _ = unsafe { CloseHandle(process) };

    result.ok()?;
    Some(String::from_utf16_lossy(&path_buffer[..path_len as usize]))
}
