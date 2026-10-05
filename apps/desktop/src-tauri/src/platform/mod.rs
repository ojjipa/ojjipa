// TODO [Farhan, by 10/10/2026]: Document the type-level privacy boundary.
// This file is the contract: ActiveWindow never serializes, AgentActivity
// carries only a category, ActiveWindowTransparency is UI-only. Explain
// in a top-of-file block why each type exists and who sees what.

use serde::Serialize;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Native window metadata stays inside Rust and is never serialized directly.
#[derive(Debug, Clone)]
pub(crate) struct ActiveWindow {
    pub(crate) title: Option<String>,
    pub(crate) app_name: Option<String>,
    pub(crate) app_identifier: Option<String>,
    pub(crate) accessibility_permission_required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityCategory {
    Coding,
    Meeting,
    Messaging,
    Reading,
    Unknown,
}

/// Sanitized category intended for agent/Python context.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    pub category: ActivityCategory,
}

/// React-only transparency data. App names and identifiers are intentionally omitted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowTransparency {
    pub category: ActivityCategory,
    pub title: Option<String>,
    pub accessibility_permission_required: bool,
}

impl ActiveWindow {
    pub fn category(&self) -> ActivityCategory {
        let searchable = format!(
            "{} {} {}",
            self.app_name.as_deref().unwrap_or_default(),
            self.app_identifier.as_deref().unwrap_or_default(),
            self.title.as_deref().unwrap_or_default()
        )
        .to_lowercase();

        if ["code", "terminal", "vscode", "pycharm", "cursor", "vim", "neovim"]
            .iter()
            .any(|term| searchable.contains(term))
        {
            ActivityCategory::Coding
        } else if ["zoom", "meet", "teams"]
            .iter()
            .any(|term| searchable.contains(term))
        {
            ActivityCategory::Meeting
        } else if ["slack", "discord", "telegram", "whatsapp"]
            .iter()
            .any(|term| searchable.contains(term))
        {
            ActivityCategory::Messaging
        } else if ["arxiv", "scholar", "pubmed"]
            .iter()
            .any(|term| searchable.contains(term))
        {
            ActivityCategory::Reading
        }  
        else {
            ActivityCategory::Unknown
        }
    }

    pub fn agent_activity(&self) -> AgentActivity {
        AgentActivity {
            category: self.category(),
        }
    }

    pub fn transparency(&self) -> ActiveWindowTransparency {
        ActiveWindowTransparency {
            category: self.category(),
            title: self.title.clone(),
            accessibility_permission_required: self.accessibility_permission_required,
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn active_window() -> Result<Option<ActiveWindow>, String> {
    windows::active_window()
}

#[cfg(target_os = "macos")]
pub(crate) fn active_window() -> Result<Option<ActiveWindow>, String> {
    macos::active_window()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) fn active_window() -> Result<Option<ActiveWindow>, String> {
    Err("Active-window detection is supported only on Windows and macOS".into())
}
