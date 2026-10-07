// TODO [Farhan, by 10/10/2026]: Explain FFI ownership.
// - Why AXIsProcessTrusted is checked before title lookup
// - Why each CFRef is manually released (no ARC in Rust FFI)
// - What CFStringGetMaximumSizeForEncoding is sizing
use super::ActiveWindow;
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::{c_char, c_void, CStr};
use std::ptr;

type ObjcId = *mut objc::runtime::Object;
type CfRef = *const c_void;
const UTF8_ENCODING: u32 = 0x0800_0100;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> CfRef;
    fn AXUIElementCopyAttributeValue(element: CfRef, attribute: CfRef, value: *mut CfRef) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(allocator: CfRef, value: *const c_char, encoding: u32) -> CfRef;
    fn CFStringGetLength(value: CfRef) -> i64;
    fn CFStringGetMaximumSizeForEncoding(length: i64, encoding: u32) -> i64;
    fn CFStringGetCString(value: CfRef, buffer: *mut c_char, size: i64, encoding: u32) -> u8;
    fn CFRelease(value: CfRef);
}

pub(super) fn active_window() -> Result<Option<ActiveWindow>, String> {
    let workspace: ObjcId = unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
    if workspace.is_null() {
        return Ok(None);
    }

    let app: ObjcId = unsafe { msg_send![workspace, frontmostApplication] };
    if app.is_null() {
        return Ok(None);
    }

    let process_id: i32 = unsafe { msg_send![app, processIdentifier] };
    if process_id <= 0 {
        return Ok(None);
    }

    let name: ObjcId = unsafe { msg_send![app, localizedName] };
    let app_name = ns_string(name);
    let bundle_identifier: ObjcId = unsafe { msg_send![app, bundleIdentifier] };
    let app_identifier = ns_string(bundle_identifier);

    let permission_required = unsafe { AXIsProcessTrusted() == 0 };
    let title = if permission_required {
        None
    } else {
        focused_window_title(process_id)
    };

    Ok(Some(ActiveWindow {
        title,
        app_name,
        app_identifier,
        accessibility_permission_required: permission_required,
    }))
}

fn ns_string(value: ObjcId) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let utf8: *const c_char = unsafe { msg_send![value, UTF8String] };
    if utf8.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(utf8) }
            .to_string_lossy()
            .into_owned(),
    )
}

fn focused_window_title(process_id: i32) -> Option<String> {
    let application = unsafe { AXUIElementCreateApplication(process_id) };
    if application.is_null() {
        return None;
    }

    let focused_attribute = cf_string("AXFocusedWindow")?;
    let mut focused_window = ptr::null();
    let focused_result = unsafe {
        AXUIElementCopyAttributeValue(application, focused_attribute, &mut focused_window)
    };
    unsafe { CFRelease(focused_attribute) };
    unsafe { CFRelease(application) };
    if focused_result != 0 || focused_window.is_null() {
        return None;
    }

    let title_attribute = match cf_string("AXTitle") {
        Some(attribute) => attribute,
        None => {
            unsafe { CFRelease(focused_window) };
            return None;
        }
    };
    let mut title_value = ptr::null();
    let title_result =
        unsafe { AXUIElementCopyAttributeValue(focused_window, title_attribute, &mut title_value) };
    unsafe { CFRelease(title_attribute) };
    unsafe { CFRelease(focused_window) };
    if title_result != 0 || title_value.is_null() {
        return None;
    }

    let title = cf_string_to_string(title_value);
    unsafe { CFRelease(title_value) };
    title.filter(|title| !title.is_empty())
}

fn cf_string(value: &str) -> Option<CfRef> {
    let value = std::ffi::CString::new(value).ok()?;
    let string = unsafe { CFStringCreateWithCString(ptr::null(), value.as_ptr(), UTF8_ENCODING) };
    (!string.is_null()).then_some(string)
}

fn cf_string_to_string(value: CfRef) -> Option<String> {
    let length = unsafe { CFStringGetLength(value) };
    let capacity = unsafe { CFStringGetMaximumSizeForEncoding(length, UTF8_ENCODING) };
    if capacity < 0 {
        return None;
    }
    let mut buffer = vec![0_u8; capacity as usize + 1];
    let success = unsafe {
        CFStringGetCString(
            value,
            buffer.as_mut_ptr().cast(),
            buffer.len() as i64,
            UTF8_ENCODING,
        )
    };
    if success == 0 {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(buffer.as_ptr().cast()) }
            .to_string_lossy()
            .into_owned(),
    )
}
