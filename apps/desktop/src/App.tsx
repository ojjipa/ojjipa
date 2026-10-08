import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./App.css";
import ModelSettings from './components/ModelSettings';
import ReportContent from './components/ReportContent';
import Reader from './components/Reader';
import DumpBox from './components/DumpBox';

type ActivityCategory =
  | "coding"
  | "meeting"
  | "messaging"
  | "reading"
  | "unknown";

type AgentActivity = {
  category: ActivityCategory;
};

type DumpResult = {
  dumpId: number;
  decisionStatus: "complete" | "pending";
  analysisError?: string;
  decision?: {
    verdict: "noise" | "task" | "watch";
    reason: string;
    minipa: {
      id: number;
      kind: "task" | "watcher";
      purpose: string;
    } | null;
  };
};

type NotificationPreferences = {
  enabled: boolean;
  taskCompletions: boolean;
  reminders: boolean;
  resurfacedItems: boolean;
  problems: boolean;
  updates: boolean;
};

type NotificationCategory = Exclude<keyof NotificationPreferences, "enabled">;
type SettingsCategory = "appearance" | "notifications" | "ai-models";

const defaultNotificationPreferences: NotificationPreferences = {
  enabled: true,
  taskCompletions: true,
  reminders: true,
  resurfacedItems: true,
  problems: true,
  updates: true,
};

const notificationOptions: {
  key: NotificationCategory;
  label: string;
  description: string;
}[] = [
  {
    key: "taskCompletions",
    label: "Task completions",
    description: "When a MiniPa finishes a task and returns its result.",
  },
  {
    key: "reminders",
    label: "Scheduled reminders",
    description: "Reminders at the date and time you choose.",
  },
  {
    key: "resurfacedItems",
    label: "Resurfaced items",
    description: "When held work is surfaced as your attention becomes available.",
  },
  {
    key: "problems",
    label: "Problems",
    description: "When OJJIPA or a background task needs your attention.",
  },
  {
    key: "updates",
    label: "Inbox updates",
    description: "When a thought is captured and saved to your inbox.",
  },
];

type TextAttachment = {
  name: string;
  content: string;
  bytes: number;
};

type CapturedThought = {
  id: number;
  content: string;
  decision?: DumpResult["decision"];
  analysisError?: string;
};

type WorkspaceTab = "welcome" | "thoughts" | "workers" | "findings" | "attention" | "settings";

const workspaceTabs: { id: WorkspaceTab; label: string; icon: "compass" | "inbox" | "layers" | "book" | "orbit" | "settings" }[] = [
  { id: "welcome", label: "Welcome", icon: "compass" },
  { id: "thoughts", label: "Thoughts", icon: "inbox" },
  { id: "workers", label: "MiniPas", icon: "layers" },
  { id: "findings", label: "Findings", icon: "book" },
  { id: "attention", label: "Attention", icon: "orbit" },
  { id: "settings", label: "Settings", icon: "settings" },
];

type Worker = { id: number; kind: string; purpose: string; status: "active" | "paused" | "retired"; termination_condition: string | null };
type SavedReport = { id: number; minipa_id: number; content: string; created_at: string; hold_id: number | null; delivery: string | null };
type AIJob = {id:number; dump_id:number|null; minipa_id:number|null; phase:string; status:string; error:string|null; due_at:string};
type Memory = {id:number; content:string};
type WorkspaceData = { thoughts: CapturedThought[]; minipas: Worker[]; reports: SavedReport[]; jobs:AIJob[]; memories:Memory[] };
type AttentionData = { preferences: {focus_enabled: boolean; auto_surface_enabled: boolean}; held_count: number; surfaced_reports: {hold_id: number}[] };

const activityLabels: Record<ActivityCategory, string> = {
  coding: "In your making zone",
  meeting: "In conversation",
  messaging: "Catching up",
  reading: "Taking something in",
  unknown: "Finding your own pace",
};

function formatCaptureShortcut(shortcut: string) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  return shortcut
    .split("+")
    .map((part) => {
      if (part === "CommandOrControl") return isMac ? "⌘" : "Ctrl";
      if (part === "Alt") return isMac ? "⌥" : "Alt";
      if (part === "Shift") return isMac ? "⇧" : "Shift";
      if (part === "Space") return "Space";
      return part;
    })
    .join(" + ");
}

function shortcutKeyName(key: string) {
  if (key === " ") return "Space";
  if (key === "Escape") return "Escape";
  if (key === "Enter") return "Enter";
  if (key === "Tab") return "Tab";
  if (key === "Backspace") return "Backspace";
  if (key === "Delete") return "Delete";
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^\d$/.test(key)) return key;
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
  return null;
}

function Icon({
  name,
  size = 18,
}: {
  name:
    | "spark"
    | "inbox"
    | "compass"
    | "check"
    | "lock"
    | "plus"
    | "clock"
    | "attach"
    | "search"
    | "book"
    | "send"
    | "layers"
    | "orbit"
    | "sun"
    | "moon"
    | "settings";
  size?: number;
}) {
  const paths: Record<typeof name, ReactNode> = {
    spark: <path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" />,
    inbox: <><path d="M4 5h16v14H4z" /><path d="M4 13h4l1.5 2h5L16 13h4" /></>,
    compass: <><circle cx="12" cy="12" r="9" /><path d="m15.7 8.3-2.4 5-5 2.4 2.4-5 5-2.4Z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    attach: <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /><path d="M8.3 10.8h5M10.8 8.3v5" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z" /><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h8M8 10h6" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    orbit: <><circle cx="12" cy="12" r="2" /><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-35 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(35 12 12)" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
    moon: <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />,
    settings: <><circle cx="12" cy="12" r="3.25" /><path d="M19.14 12.94a7.5 7.5 0 0 0 0-1.88l2.03-1.58-2-3.46-2.39.96a7.5 7.5 0 0 0-1.63-.94L14.8 3h-5l-.36 3.04a7.5 7.5 0 0 0-1.63.94l-2.39-.96-2 3.46 2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58 2 3.46 2.39-.96c.5.39 1.04.7 1.63.94L9.8 22h5l.36-3.04c.59-.24 1.13-.55 1.63-.94l2.39.96 2-3.46-2.04-1.58Z" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function FloatingCapture() {
  const [content, setContent] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const focusInput = () => inputRef.current?.focus();
    focusInput();
    let unlisten: (() => void) | undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void invoke("hide_capture_window").catch((error: unknown) => {
          console.error("Could not close quick capture:", error);
          setErrorMessage(error instanceof Error ? error.message : String(error));
        });
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (payload) focusInput();
      })
      .then((stopListening) => {
        unlisten = stopListening;
      })
      .catch((error: unknown) => {
        console.error("Could not listen for quick capture focus:", error);
      });
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      unlisten?.();
    };
  }, []);

  async function closeCapture() {
    try {
      await invoke("hide_capture_window");
    } catch (error) {
      console.error("Could not close quick capture:", error);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedContent = content.trim();
    if (!trimmedContent || isSaving) return;
    setIsSaving(true);
    setErrorMessage("");
    setSavedMessage("");
    try {
      const result = await invoke<DumpResult>("submit_dump", {
        content: trimmedContent,
        maxThinkingSeconds: 30,
      });
      setContent("");
      setSavedMessage(
        result.dumpId ? `Thought saved · #${result.dumpId}` : "Thought saved",
      );
      window.setTimeout(() => void closeCapture(), 900);
    } catch (error) {
      console.error("Could not save quick capture:", error);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="floating-capture">
      <header
        className="floating-capture-heading"
        onMouseDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
          void getCurrentWindow().startDragging().catch((error: unknown) => {
            console.error("Could not move quick capture window:", error);
          });
        }}
      >
        <span className="floating-capture-brand">
          <img src="/brand/ojjipa-wordmark.png" alt="OJJIPA" />
          <span>QUICK CAPTURE</span>
        </span>
        <button className="floating-capture-close" type="button" onClick={() => void closeCapture()} aria-label="Close quick capture">
          <kbd>ESC</kbd>
        </button>
      </header>
      <form className="floating-capture-form" onSubmit={(event) => void saveCapture(event)}>
        <label className="sr-only" htmlFor="floating-thought-input">A thought to save</label>
        <DumpBox
          inputRef={inputRef}
          id="floating-thought-input"
          autoFocus
          rows={2}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setErrorMessage("");
            setSavedMessage("");
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="What would you like to remember?"
          disabled={isSaving}
        />
        <button type="submit" disabled={!content.trim() || isSaving}>
          {isSaving ? <span className="button-spinner" /> : <Icon name="send" size={15} />}
          <span>{isSaving ? "Saving" : "Save"}</span>
        </button>
      </form>
      <footer className="floating-capture-footer">
        <span>{errorMessage || savedMessage || "Saved to your private OJJIPA inbox"}</span>
        <kbd>⌘/CTRL + ENTER</kbd>
      </footer>
    </main>
  );
}

function App() {
  if (isTauri() && getCurrentWindow().label === "reader") {
    return <Reader />;
  }
  if (isTauri() && getCurrentWindow().label === "capture") {
    return <FloatingCapture />;
  }
  return <WorkspaceApp />;
}

function WorkspaceApp() {
  const [hasEnteredWorkspace, setHasEnteredWorkspace] = useState(
    () => window.localStorage.getItem("ojjipa-welcome-seen") === "true",
  );
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("welcome");
  const [isDarkMode, setIsDarkMode] = useState(
    () => window.localStorage.getItem("ojjipa-theme") === "dark",
  );
  const maxThinkingSeconds = 30;
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [activity, setActivity] = useState<ActivityCategory | null>(null);
  const [activityError, setActivityError] = useState("");
  const [isAttentionPaused, setIsAttentionPaused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [thinkingElapsedSeconds, setThinkingElapsedSeconds] = useState(0);
  const [isChoosingFiles, setIsChoosingFiles] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [savedDumpId, setSavedDumpId] = useState<number | null>(null);
  const [capturedThoughts, setCapturedThoughts] = useState<CapturedThought[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [jobs, setJobs] = useState<AIJob[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [attentionData, setAttentionData] = useState<AttentionData | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("appearance");
  const [captureShortcut, setCaptureShortcut] = useState("CommandOrControl+Alt+Shift+Space");
  const [isRecordingCaptureShortcut, setIsRecordingCaptureShortcut] = useState(false);
  const [isSavingCaptureShortcut, setIsSavingCaptureShortcut] = useState(false);
  const [captureShortcutMessage, setCaptureShortcutMessage] = useState("");
  const [captureShortcutError, setCaptureShortcutError] = useState("");
  const [notificationPreferences, setNotificationPreferences] = useState(defaultNotificationPreferences);
  const [isSavingNotificationPreferences, setIsSavingNotificationPreferences] = useState(false);
  const [notificationSettingsMessage, setNotificationSettingsMessage] = useState("");
  const [notificationSettingsError, setNotificationSettingsError] = useState("");

  const refreshWorkspace = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const [data, attention] = await Promise.all([
        invoke<WorkspaceData>("workspace_request", {operation:"workspace.get", payload:{}}),
        invoke<AttentionData>("hold_queue_request", {operation:"attention.get", payload:{}}),
      ]);
      setCapturedThoughts(data.thoughts); setWorkers(data.minipas); setReports(data.reports);
      setJobs(data.jobs ?? []); setMemories(data.memories ?? []);
      setAttentionData(attention); setWorkspaceError("");
    } catch (error) { setWorkspaceError(String(error)); }
  }, []);
  useEffect(() => { void refreshWorkspace(); const timer = window.setInterval(() => void refreshWorkspace(), 3000); return () => window.clearInterval(timer); }, [refreshWorkspace]);
  async function workspaceAction(operation: string, payload: Record<string, unknown>) {
    try { await invoke("workspace_request", {operation,payload}); await refreshWorkspace(); }
    catch(error) { setWorkspaceError(String(error)); }
  }
  async function attentionAction(operation: string, payload: Record<string, unknown>) {
    try { await invoke("hold_queue_request", {operation,payload}); await refreshWorkspace(); }
    catch(error) { setWorkspaceError(String(error)); }
  }

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<string>("get_capture_shortcut")
      .then(setCaptureShortcut)
      .catch((error: unknown) => {
        console.error("Could not load the quick capture shortcut:", error);
        setCaptureShortcutError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  async function saveCaptureShortcutFromKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!isRecordingCaptureShortcut || isSavingCaptureShortcut) return;
    if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setIsRecordingCaptureShortcut(false);
      setCaptureShortcutError("");
      return;
    }

    const key = shortcutKeyName(event.key);
    if (!key) {
      setCaptureShortcutError("Use a modifier with a letter, number, function key, or Space.");
      return;
    }
    const modifiers = [
      event.metaKey || event.ctrlKey ? "CommandOrControl" : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
    ].filter(Boolean);
    if (modifiers.length === 0) {
      setCaptureShortcutError("Add at least one modifier key to avoid capturing normal typing.");
      return;
    }

    const nextShortcut = [...modifiers, key].join("+");
    setIsSavingCaptureShortcut(true);
    setCaptureShortcutError("");
    setCaptureShortcutMessage("");
    try {
      const savedShortcut = await invoke<string>("save_capture_shortcut", {
        shortcut: nextShortcut,
      });
      setCaptureShortcut(savedShortcut);
      setCaptureShortcutMessage("Shortcut saved.");
      setIsRecordingCaptureShortcut(false);
    } catch (error) {
      console.error("Could not save the quick capture shortcut:", error);
      setCaptureShortcutError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingCaptureShortcut(false);
    }
  }

  function toggleTheme() {
    const nextTheme = isDarkMode ? "light" : "dark";
    window.localStorage.setItem("ojjipa-theme", nextTheme);
    setIsDarkMode(nextTheme === "dark");
  }

  const refreshActivity = useCallback(async () => {
    if (!isTauri()) {
      setActivity(null);
      setActivityError("Open the desktop app to connect to your local engine.");
      return;
    }

    try {
      const paused = false;
      setIsAttentionPaused(paused);
      const result = paused
        ? null
        : await invoke<AgentActivity | null>("get_agent_activity");
      setActivity(result?.category ?? null);
      setActivityError("");
    } catch (error) {
      console.error("Could not read current activity:", error);
      setActivity(null);
      setActivityError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshActivity();
    const interval = window.setInterval(() => void refreshActivity(), 3000);
    return () => window.clearInterval(interval);
  }, [refreshActivity]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<NotificationPreferences>("get_notification_preferences")
      .then(setNotificationPreferences)
      .catch((error: unknown) => {
        console.error("Could not read notification preferences:", error);
        setNotificationSettingsError(
          error instanceof Error ? error.message : String(error),
        );
      });
  }, []);

  async function handleSaveNotificationPreferences() {
    if (isSavingNotificationPreferences) return;
    if (!isTauri()) {
      setNotificationSettingsError("Save notification settings from the OJJIPA desktop app.");
      return;
    }
    setIsSavingNotificationPreferences(true);
    setNotificationSettingsError("");
    setNotificationSettingsMessage("");
    try {
      const saved = await invoke<NotificationPreferences>(
        "save_notification_preferences",
        { preferences: notificationPreferences },
      );
      setNotificationPreferences(saved);
      setNotificationSettingsMessage("Notification preferences saved on this device.");
    } catch (error) {
      console.error("Could not save notification preferences:", error);
      setNotificationSettingsError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsSavingNotificationPreferences(false);
    }
  }

  async function handleTestNotification() {
    if (!isTauri()) {
      setNotificationSettingsError("Send a test notification from the OJJIPA desktop app.");
      return;
    }
    setNotificationSettingsError("");
    setNotificationSettingsMessage("");
    try {
      await invoke("test_desktop_notification");
      setNotificationSettingsMessage("A test notification was sent to your desktop.");
    } catch (error) {
      console.error("Could not send a test desktop notification:", error);
      setNotificationSettingsError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  useEffect(() => {
    if (!isSubmitting || thinkingStartedAt === null) return;
    const updateElapsed = () => {
      setThinkingElapsedSeconds(Math.min(
        maxThinkingSeconds,
        Math.floor((Date.now() - thinkingStartedAt) / 1000),
      ));
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(interval);
  }, [isSubmitting, maxThinkingSeconds, thinkingStartedAt]);

  async function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;

    const totalBytes = attachments.reduce((total, file) => total + file.bytes, 0)
      + files.reduce((total, file) => total + file.size, 0);
    if (attachments.length + files.length > 5) {
      setSubmitError("You can attach up to 5 files.");
      return;
    }
    if (files.some((file) => file.size > 512 * 1024) || totalBytes > 1024 * 1024) {
      setSubmitError("Attachments are limited to 512 KiB each and 1 MiB total.");
      return;
    }

    setIsChoosingFiles(true);
    setSubmitError("");
    try {
      const selectedFiles = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          content: await file.text(),
          bytes: file.size,
        })),
      );
      setAttachments((current) => [...current, ...selectedFiles]);
      setSavedDumpId(null);
    } catch (error) {
      console.error("Could not attach files:", error);
      setSubmitError("Could not read the selected file. Please try a UTF-8 text file.");
    } finally {
      setIsChoosingFiles(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedContent = content.trim();
    if (isSubmitting) return;
    if (!trimmedContent && attachments.length === 0) return;
    if (!isTauri()) {
      setSubmitError("Open OJJIPA Desktop to save this thought to your local engine.");
      return;
    }

    setSubmitError("");
    setIsSubmitting(true);
    const startedAt = Date.now();
    setThinkingStartedAt(startedAt);
    setThinkingElapsedSeconds(0);
    setSavedDumpId(null);
    try {
      const fileContext = attachments
        .map((file) => `--- Attached file: ${file.name} ---\n${file.content}`)
        .join("\n\n");
      const dumpContent = [
        trimmedContent || "Please review the attached file(s).",
        fileContext,
      ].filter(Boolean).join("\n\n");
      const result = await invoke<DumpResult>("submit_dump", {
        content: dumpContent,
        maxThinkingSeconds,
      });
      if (!Number.isInteger(result?.dumpId)) {
        throw new Error("The engine returned an invalid saved-thought ID.");
      }
      setSavedDumpId(result.dumpId);
      setCapturedThoughts((current) => [
        {
          id: result.dumpId,
          content: dumpContent,
          decision: result.decision,
          analysisError: result.analysisError,
        },
        ...current,
      ]);
      if (result.analysisError) setSubmitError(result.analysisError);
      setContent("");
      setAttachments([]);
    } catch (error) {
      console.error("Could not save thought:", error);
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
      setThinkingStartedAt(null);
    }
  }

  const canSubmit = Boolean(content.trim()) || attachments.length > 0;

  const attentionHeadline = activityError
    ? "Waiting to connect"
    : isAttentionPaused
      ? "Taking a quiet moment"
      : activity
        ? activityLabels[activity]
        : "Finding your rhythm";
  const attentionDescription = activityError
    ? activityError
    : isAttentionPaused
      ? "Attention monitoring is paused from the system tray."
      : activity
        ? "A small signal, not a window into what you’re doing."
        : "Your attention category will appear here.";

  const captureComposer = (
    <section className="thought-composer">
      <form className="capture-bar" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="thought-input">A thought to save</label>
        <input
          ref={attachmentInputRef}
          className="sr-only"
          type="file"
          multiple
          accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.toml,.log,.sql"
          onChange={(event) => void handleFilesSelected(event)}
          tabIndex={-1}
          aria-hidden="true"
        />
        <button
          className="capture-attach"
          type="button"
          onClick={() => attachmentInputRef.current?.click()}
          disabled={isChoosingFiles || isSubmitting}
          aria-label="Attach text files"
          title="Attach text files"
        >
          {isChoosingFiles ? <span className="small-spinner" /> : <Icon name="plus" size={16} />}
        </button>
        <DumpBox
          id="thought-input"
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setSubmitError("");
            setSavedDumpId(null);
          }}
          placeholder="What would you like to remember?"
          rows={1}
          disabled={isSubmitting || isChoosingFiles}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          className="capture-submit"
          type="submit"
          disabled={!canSubmit || isSubmitting || isChoosingFiles}
          aria-label={isSubmitting ? "Saving thought" : "Save thought"}
        >
          {isSubmitting ? <span className="button-spinner" /> : <><Icon name="send" size={15} /><span>Save thought</span></>}
        </button>
      </form>
      {isSubmitting && (
        <div className="thinking-state" role="status" aria-live="polite">
          <div className="thinking-state-heading">
            <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>Saving your thought</span>
            <span className="thinking-timer">{thinkingElapsedSeconds}s / {maxThinkingSeconds}s</span>
          </div>
          <div
            className="thinking-progress"
            role="progressbar"
            aria-label="Maximum thinking time elapsed"
            aria-valuemin={0}
            aria-valuemax={maxThinkingSeconds}
            aria-valuenow={thinkingElapsedSeconds}
          >
            <span style={{ width: `${(thinkingElapsedSeconds / maxThinkingSeconds) * 100}%` }} />
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="dock-attachments" aria-label="Attached text files">
          {attachments.map((file, index) => (
            <div className="attachment-chip" key={`${file.name}-${index}`}>
              <Icon name="attach" size={13} />
              <span title={`${file.name} · ${file.bytes.toLocaleString()} bytes`}>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setAttachments((current) =>
                  current.filter((_, currentIndex) => currentIndex !== index),
                )}
              >×</button>
            </div>
          ))}
        </div>
      )}
      {submitError && <div className="dock-feedback dock-feedback-error" role="alert">{submitError}</div>}
      {savedDumpId !== null && (
        <div className="dock-feedback dock-feedback-success" role="status">
          Thought saved · #{savedDumpId}
        </div>
      )}
      <p className="composer-hint">Saved locally first. Grandpa then considers your thought through your configured model; MiniPas work in the background.</p>
    </section>
  );

  function renderCapturedThoughts() {
    return capturedThoughts.length > 0 ? capturedThoughts.map((thought) => (
      <article className="captured-row" key={thought.id}>
        <div>
          <span className="mini-label">
            {thought.decision
              ? `GRANDPA · ${thought.decision.verdict.toUpperCase()}`
              : "SAVED LOCALLY"}
          </span>
          <p>{thought.content}</p>
          {thought.decision && <p className="captured-decision">{thought.decision.reason}</p>}
          {thought.decision?.minipa && (
            <span className="sample-stamp">{thought.decision.minipa.kind.toUpperCase()} · MINIPA #{thought.decision.minipa.id}</span>
          )}
          {thought.analysisError && <p className="captured-error">{thought.analysisError}</p>}
          {!thought.decision && <p className="captured-decision">{jobs.find(job=>job.dump_id===thought.id)?.status === 'running' ? 'Grandpa is considering this…' : jobs.some(job=>job.dump_id===thought.id) ? 'Queued for Grandpa' : 'Saved without a decision'}{!jobs.some(job=>job.dump_id===thought.id) && <button className="text-link" onClick={()=>void workspaceAction('ai.analyze',{id:thought.id})}>Ask Grandpa</button>}</p>}
          {jobs.filter(job=>job.dump_id===thought.id && job.status==='failed').map(job=><p className="captured-error" key={job.id}>{job.error}<button className="text-link" onClick={()=>void workspaceAction('ai.retry',{id:job.id})}>Retry</button></p>)}
        </div>
        <span className="dump-reference">#{thought.id}</span>
      </article>
    )) : (
      <div className="empty-state">
        <span className="empty-state-icon"><Icon name="inbox" size={22} /></span>
        <h3>No thoughts captured yet</h3>
        <p>Save a thought here and it will stay in your local inbox.</p>
      </div>
    );
  }

  return (
    <main className={`workspace app-shell${isDarkMode ? " theme-dark" : " theme-light"}`} data-theme={isDarkMode ? "dark" : "light"}>
      <div className="paper-grain" aria-hidden="true" />
      {!hasEnteredWorkspace ? (
        <div className="welcome-screen">
          <header className="topbar welcome-topbar">
            <a className="brand" href="#welcome" aria-label="OJJIPA home">
              <img className="brand-wordmark" src="/brand/ojjipa-wordmark.png" alt="OJJIPA" />
            </a>
          </header>
          <section className="welcome-content" aria-labelledby="welcome-heading">
            <div className="welcome-copy">
              <p className="eyebrow"><span className="eyebrow-mark" /> YOUR QUIETLY CAPABLE DESKTOP ASSISTANT</p>
              <h1 id="welcome-heading">Make room<br />for what matters.</h1>
              <p className="welcome-description">Hello, I’m Grandpa. Tell me what’s on your mind. I’ll keep the small things moving while you stay in your flow.</p>
              <button
                className="welcome-enter"
                type="button"
                onClick={() => {
                  window.localStorage.setItem("ojjipa-welcome-seen", "true");
                  setHasEnteredWorkspace(true);
                }}
              >
                Enter your workspace <span aria-hidden="true">→</span>
              </button>
              <p className="welcome-privacy"><Icon name="lock" size={13} /> Your activity stays on this device.</p>
            </div>
            <div className="welcome-portrait">
              <div className="welcome-orbit welcome-orbit-one" />
              <div className="welcome-orbit welcome-orbit-two" />
              <img src="/brand/grandpa-illustration.png" alt="Grandpa, your OJJIPA assistant" />
              <span className="welcome-note">HERE WHEN YOU NEED ME</span>
            </div>
          </section>
          <footer className="welcome-footer">
            <span>OJJIPA / DESKTOP</span>
            <span>GRANDPA DECIDES · MINIPAS ACT</span>
          </footer>
        </div>
      ) : (
        <div className="desktop-shell">
          <aside className="app-sidebar" aria-label="Main navigation">
            <a className="brand sidebar-brand" href="#welcome" aria-label="OJJIPA Welcome" onClick={() => setActiveTab("welcome")}>
              <img className="brand-wordmark" src="/brand/ojjipa-wordmark.png" alt="OJJIPA" />
            </a>
            <p className="sidebar-label">WORKSPACE</p>
            <nav className="workspace-nav">
              {workspaceTabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`nav-item${activeTab === tab.id ? " nav-item-active" : ""}`}
                  data-tab={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                >
                  <Icon name={tab.icon} size={17} />
                  <span>{tab.label}</span>
                  {tab.id === "thoughts" && capturedThoughts.length > 0 && <small>{capturedThoughts.length}</small>}
                </button>
              ))}
            </nav>
          </aside>

          <div className="workspace-pane">
            <header className="topbar workspace-topbar">
              <div className="topbar-title">
                <span className="header-index">OJJIPA / 01</span>
                <span>{workspaceTabs.find((tab) => tab.id === activeTab)?.label}</span>
              </div>
            </header>

            <div className="workspace-scroll">
              {activeTab === "welcome" && (
                <section className="workspace-welcome" aria-labelledby="welcome-heading">
                  <div className="workspace-welcome-copy">
                    <p className="eyebrow"><span className="eyebrow-mark" /> YOUR OJJIPA WORKSPACE</p>
                    <h1 id="welcome-heading">Hello, I’m Grandpa.</h1>
                    <p className="workspace-welcome-description">
                      Tell me what’s on your mind. I’ll help keep the small things moving while you stay in your flow.
                    </p>
                    <button className="welcome-enter" type="button" onClick={() => setActiveTab("thoughts")}>
                      Share a thought <span aria-hidden="true">→</span>
                    </button>
                    <p className="welcome-privacy"><Icon name="lock" size={13} /> Your activity stays on this device.</p>
                  </div>
                  <div className="workspace-welcome-portrait">
                    <div className="welcome-orbit welcome-orbit-one" />
                    <div className="welcome-orbit welcome-orbit-two" />
                    <img src="/brand/grandpa-illustration.png" alt="Grandpa, your OJJIPA assistant" />
                    <span className="welcome-note">HERE WHEN YOU NEED ME</span>
                  </div>
                </section>
              )}

              {activeTab === "thoughts" && (
                <section className="tab-page" aria-labelledby="page-heading">
                  <div className="page-heading-row">
                    <div><p className="eyebrow"><span className="eyebrow-mark" /> YOUR PRIVATE INBOX</p><h1 id="page-heading">Thoughts</h1><p className="page-description">Drop a thought here. OJJIPA keeps it close and out of your way.</p></div>
                  </div>
                  <section className="content-panel thoughts-list">
                    <div className="panel-heading"><div><p className="workroom-overline">LOCAL DUMPS</p><h2>Recently captured</h2></div><span className="sample-stamp">{capturedThoughts.length} SAVED</span></div>
                    {renderCapturedThoughts()}
                  </section>
                </section>
              )}

              {activeTab === "workers" && (
                <section className="tab-page"><div className="page-heading-row"><div><h1>MiniPas</h1><p className="page-description">Bounded tasks and periodic arXiv watchers, executed through Hermes.</p></div></div>
                  <div className="content-panel worker-panel">{workers.map(worker => <article className="worker-row" key={worker.id}><div className="worker-main"><h3>{worker.purpose}</h3><p>{worker.kind} · {worker.status} · #{worker.id}</p>{worker.termination_condition && <p>{worker.termination_condition}</p>}{jobs.filter(job=>job.minipa_id===worker.id).map(job=><div key={job.id}><p>{job.phase} · {job.status}{job.phase==='watch' && job.status==='queued' ? ` · next check ${new Date(job.due_at).toLocaleString()}` : ''}</p>{job.error && <p className="captured-error">{job.error}</p>}{job.status==='failed' && worker.status!=='retired' && <button className="text-link" onClick={()=>void workspaceAction('ai.retry',{id:job.id})}>Retry failed execution</button>}</div>)}{worker.status==='active' && !jobs.some(job=>job.minipa_id===worker.id && ['queued','running','failed'].includes(job.status)) && <button className="text-link" onClick={()=>void workspaceAction('ai.run',{id:worker.id})}>Start execution</button>}{worker.status !== "retired" && <div className="finding-actions"><button onClick={() => void workspaceAction("minipa.status", {id:worker.id,status:worker.status === "active" ? "paused":"active"})}>{worker.status === "active" ? "Pause":"Resume"}</button><button onClick={() => void workspaceAction("minipa.status", {id:worker.id,status:"retired"})}>Retire</button></div>}</div></article>)}{!workers.length && <p className="panel-empty">No MiniPas have been created yet.</p>}</div>
                </section>
              )}
              {activeTab === "findings" && (
                <section className="tab-page"><div className="page-heading-row"><div><h1>Findings</h1><p className="page-description">{attentionData?.held_count ?? 0} reports waiting for your attention.</p></div><button className="text-link" disabled={!attentionData?.held_count} onClick={() => void attentionAction("attention.surface", {})}>Show next held result</button></div>
                  <div className="finding-list findings-page-list">{reports.filter(report => report.delivery === "held").map(report => <article className="finding-card" key={`held-${report.id}`}><div className="finding-meta"><span>HELD · MINIPA #{report.minipa_id}</span></div><p>This result is waiting for a suitable moment.</p><button className="finding-open" onClick={() => void attentionAction("attention.dismiss", {id:report.hold_id})}>Dismiss held result</button></article>)}{reports.filter(report => report.delivery !== "held" && report.delivery !== "dismissed" && report.delivery !== "expired").map(report => <article className="finding-card" key={report.id}><div className="finding-meta"><span>MINIPA #{report.minipa_id}</span><span>{new Date(report.created_at).toLocaleString()}</span></div><ReportContent content={report.content} /></article>)}{!reports.some(report => report.delivery === "surfaced" || !report.delivery) && <p className="panel-empty">No surfaced reports yet. Held results stay private until surfaced.</p>}</div>
                </section>
              )}

              {activeTab === "attention" && (
                <section className="tab-page" aria-labelledby="page-heading">
                  <div className="page-heading-row">
                    <div><p className="eyebrow"><span className="eyebrow-mark" /> A LIGHT TOUCH, NOT A WINDOW INTO YOUR WORK</p><h1 id="page-heading">Attention</h1><p className="page-description">OJJIPA uses a broad activity category to know when to stay quiet.</p></div>
                  </div>
                  <div className="attention-page-grid">
                    <section className="content-panel attention-live-panel">
                      <div className="panel-heading"><div><p className="workroom-overline">CURRENT STATUS</p><h2>{attentionHeadline}</h2></div><span className={`live-pill${activityError ? " live-pill-offline" : isAttentionPaused ? " live-pill-paused" : ""}`}><span />{activityError ? "OFFLINE" : isAttentionPaused ? "PAUSED" : "MONITORING"}</span></div>
                      <p className="attention-description">{attentionDescription}</p>
                      <div className="category-chip-row">
                        {(["coding", "meeting", "messaging", "reading", "unknown"] as ActivityCategory[]).map((category) => (
                          <span className={`category-chip${activity === category ? " category-chip-active" : ""}`} key={category}>{category}</span>
                        ))}
                      </div>
                    </section>
                    <section className="content-panel"><h2>Attention controls</h2><p>{attentionData?.held_count ?? 0} reports held</p><label><input type="checkbox" checked={attentionData?.preferences.focus_enabled ?? true} onChange={e => void attentionAction("attention.settings", {focus_enabled:e.target.checked})}/> Protect my focus</label><br/><label><input type="checkbox" checked={attentionData?.preferences.auto_surface_enabled ?? true} onChange={e => void attentionAction("attention.settings", {auto_surface_enabled:e.target.checked})}/> Automatically surface at suitable moments</label></section>
                    <section className="grandpa-summary attention-grandpa">
                      <img src="/brand/grandpa-illustration.png" alt="" />
                      <div><p className="workroom-overline">GRANDPA’S PROMISE</p><h2>Your window titles stay on your computer.</h2><p>Only the broad activity category is shared with the local engine. Nothing sensitive is stored here.</p></div>
                    </section>
                  </div>
                </section>
              )}
              {activeTab === "settings" && (
                <section className="tab-page" aria-labelledby="page-heading">
                  <div className="page-heading-row">
                    <div><p className="eyebrow"><span className="eyebrow-mark" /> MAKE OJJIPA YOURS</p><h1 id="page-heading">Settings</h1><p className="page-description">Each part of OJJIPA has a place of its own.</p></div>
                  </div>
                  <div className="settings-layout">
                    <nav className="settings-categories" aria-label="Settings categories">
                      {([
                        ["appearance", "Appearance", "sun"],
                        ["notifications", "Notifications", "orbit"],
                        ["ai-models", "AI models & API", "spark"],
                      ] as const).map(([id, label, icon]) => (
                        <button
                          key={id}
                          className={`settings-category${settingsCategory === id ? " settings-category-active" : ""}`}
                          type="button"
                          onClick={() => setSettingsCategory(id)}
                          aria-current={settingsCategory === id ? "page" : undefined}
                        >
                          <Icon name={icon} size={16} />
                          <span>{label}</span>
                          <span aria-hidden="true">›</span>
                        </button>
                      ))}
                    </nav>

                    <div className="settings-category-content">
                      {settingsCategory === "appearance" && (
                        <section className="content-panel settings-panel">
                          <div className="settings-section-heading">
                            <p className="workroom-overline">APPEARANCE</p>
                            <h2>Make OJJIPA feel right</h2>
                          </div>
                          <div className="settings-row">
                            <span className="settings-icon"><Icon name={isDarkMode ? "sun" : "moon"} size={18} /></span>
                            <span className="settings-copy"><strong>Dark theme</strong><small>Choose a darker palette for your workspace.</small></span>
                            <button
                              className="theme-toggle settings-theme-toggle"
                              type="button"
                              onClick={toggleTheme}
                              aria-pressed={isDarkMode}
                              aria-label={`Dark theme ${isDarkMode ? "on" : "off"}`}
                            >
                              <span>{isDarkMode ? "On" : "Off"}</span>
                              <span className={`theme-switch${isDarkMode ? " theme-switch-on" : ""}`} aria-hidden="true"><span /></span>
                            </button>
                          </div>
                          <div className="settings-row shortcut-setting-row">
                            <span className="settings-icon"><Icon name="inbox" size={18} /></span>
                            <span className="settings-copy"><strong>Quick capture</strong><small>Open a floating thought bar above any app.</small></span>
                            <span className="capture-shortcut-editor">
                              <kbd>{isRecordingCaptureShortcut ? "Press a shortcut…" : formatCaptureShortcut(captureShortcut)}</kbd>
                              <button
                                type="button"
                                className="capture-shortcut-button"
                                disabled={!isTauri() || isSavingCaptureShortcut}
                                onClick={(event) => {
                                  if (isRecordingCaptureShortcut) {
                                    setIsRecordingCaptureShortcut(false);
                                    return;
                                  }
                                  event.currentTarget.focus();
                                  setCaptureShortcutMessage("");
                                  setCaptureShortcutError("");
                                  setIsRecordingCaptureShortcut(true);
                                }}
                                onKeyDown={saveCaptureShortcutFromKey}
                                onBlur={() => setIsRecordingCaptureShortcut(false)}
                              >
                                {isSavingCaptureShortcut ? "Saving…" : isRecordingCaptureShortcut ? "Cancel" : "Change"}
                              </button>
                              <small>Press Escape to cancel</small>
                            </span>
                          </div>
                          {(captureShortcutMessage || captureShortcutError) && (
                            <p className={`capture-shortcut-status${captureShortcutError ? " capture-shortcut-status-error" : ""}`} role="status">
                              {captureShortcutError || captureShortcutMessage}
                            </p>
                          )}
                        </section>
                      )}

                      {settingsCategory === "notifications" && (
                        <section className="content-panel notification-settings-panel">
                          <div className="settings-section-heading">
                            <p className="workroom-overline">DESKTOP NOTIFICATIONS</p>
                            <h2>Choose what reaches you</h2>
                            <p>OJJIPA can send native notifications on macOS, Windows, and Linux, even when its main window is hidden.</p>
                          </div>
                          <div className="settings-row notification-master-row">
                            <span className="settings-icon"><Icon name="orbit" size={18} /></span>
                            <span className="settings-copy"><strong>Desktop notifications</strong><small>Turn all OJJIPA notifications on or off.</small></span>
                            <button
                              className="theme-toggle settings-theme-toggle"
                              type="button"
                              role="switch"
                              aria-checked={notificationPreferences.enabled}
                              onClick={() => setNotificationPreferences((current) => ({ ...current, enabled: !current.enabled }))}
                            >
                              <span>{notificationPreferences.enabled ? "On" : "Off"}</span>
                              <span className={`theme-switch${notificationPreferences.enabled ? " theme-switch-on" : ""}`} aria-hidden="true"><span /></span>
                            </button>
                          </div>
                          <div className={`notification-options${notificationPreferences.enabled ? "" : " notification-options-disabled"}`}>
                            {notificationOptions.map((option) => (
                              <div className="settings-row notification-option-row" key={option.key}>
                                <span className="settings-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
                                <button
                                  className="theme-toggle settings-theme-toggle"
                                  type="button"
                                  role="switch"
                                  aria-checked={notificationPreferences[option.key]}
                                  aria-label={`${option.label} notifications`}
                                  disabled={!notificationPreferences.enabled}
                                  onClick={() => setNotificationPreferences((current) => ({
                                    ...current,
                                    [option.key]: !current[option.key],
                                  }))}
                                >
                                  <span>{notificationPreferences[option.key] ? "On" : "Off"}</span>
                                  <span className={`theme-switch${notificationPreferences[option.key] ? " theme-switch-on" : ""}`} aria-hidden="true"><span /></span>
                                </button>
                              </div>
                            ))}
                          </div>
                          <p className="notification-capability-note">Thought-capture updates and capture errors are active. Task completion, scheduled reminder, and resurfacing alerts will arrive when those background workflows are connected.</p>
                          {notificationSettingsError && <p className="model-config-feedback model-config-error" role="alert">{notificationSettingsError}</p>}
                          {notificationSettingsMessage && <p className="model-config-feedback model-config-success" role="status">{notificationSettingsMessage}</p>}
                          <div className="model-settings-actions">
                            <button className="text-link" type="button" onClick={() => void handleTestNotification()}>Send a test notification</button>
                            <button className="primary-button" type="button" disabled={isSavingNotificationPreferences} onClick={() => void handleSaveNotificationPreferences()}>
                              {isSavingNotificationPreferences ? "Saving…" : "Save notification settings"}
                            </button>
                          </div>
                        </section>
                      )}

                      {settingsCategory === "ai-models" && <><ModelSettings /><section className="content-panel model-settings-panel"><h2>Grandpa remembers</h2><p>Explicit preferences and corrections retained across MiniPa lifetimes.</p>{memories.map(memory=><div className="settings-row" key={memory.id}><p>{memory.content}</p><button className="text-link" onClick={()=>void workspaceAction('ai.memory.forget',{id:memory.id})}>Forget</button></div>)}{!memories.length && <p>No durable memories yet.</p>}</section></>}
                    </div>
                  </div>
                </section>
              )}
            </div>
            {workspaceError && <p className="dock-feedback dock-feedback-error" role="alert">{workspaceError}<button onClick={() => void refreshWorkspace()}>Retry connection</button></p>}
            {captureComposer}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
