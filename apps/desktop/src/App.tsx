import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./App.css";
import ModelSettings from './components/ModelSettings';
import ChromeSettings from './components/ChromeSettings';
import UserProfile from './components/UserProfile';
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
};

type NotificationCategory = Exclude<keyof NotificationPreferences, "enabled">;
type SettingsCategory = "appearance" | "notifications" | "ai-models" | "developer";
type DeveloperLog = { category: "devLog"; timestamp: string; level: string; message: string; url?: string };
type MiniPaProgress = { timestamp: string; minipaId: number; jobId: number; phase: string; step: string; state: "started" | "running" | "completed" | "failed"; tool?: string; url?: string };

const defaultNotificationPreferences: NotificationPreferences = {
  enabled: true,
  taskCompletions: true,
  reminders: true,
  resurfacedItems: true,
  problems: true,
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

type ConversationTurn = { id: string; role: "user" | "assistant"; text: string; taskDumpId?: number };

type WorkspaceTab = "welcome" | "thoughts" | "workers" | "attention" | "settings";

const workspaceTabs: { id: WorkspaceTab; label: string; icon: "compass" | "inbox" | "layers" | "orbit" | "settings" }[] = [
  { id: "welcome", label: "Welcome", icon: "compass" },
  { id: "thoughts", label: "Thoughts", icon: "inbox" },
  { id: "workers", label: "MiniPas", icon: "layers" },
  { id: "attention", label: "Attention", icon: "orbit" },
  { id: "settings", label: "Settings", icon: "settings" },
];

type Worker = { id: number; kind: string; purpose: string; status: "active" | "paused" | "retired"; termination_condition: string | null };
type AIJob = {id:number; dump_id:number|null; minipa_id:number|null; phase:string; status:string; error:string|null; due_at:string};
type WorkspaceReport = { id: number; minipa_id: number; content: string; created_at: string; hold_id?: number | null; delivery?: string | null };
type Memory = {id:number; content:string};
type WorkspaceData = { thoughts: CapturedThought[]; minipas: Worker[]; jobs:AIJob[]; reports?: WorkspaceReport[]; memories:Memory[] };
type AttentionData = { preferences: {focus_enabled: boolean; auto_surface_enabled: boolean}; held_count: number; surfaced_reports: {hold_id: number}[] };
type WorkspaceToast = { id: number; kind: "success" | "error"; message: string };
type PendingThought = { id: number; startedAt: number };

function readMiniPaProgress(): Record<number, MiniPaProgress[]> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem("ojjipa-minipa-steps") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([id, events]) => [Number(id),
      Array.isArray(events) ? events.filter((event): event is MiniPaProgress =>
        Boolean(event && typeof event === "object" && typeof (event as MiniPaProgress).step === "string" && Number.isFinite((event as MiniPaProgress).jobId)),
      ).slice(-80) : [],
    ]).filter(([id]) => Number.isFinite(id)));
  } catch { return {}; }
}

function miniPaToolLabel(tool?: string) {
  const labels: Record<string, string> = {
    browser_navigate: "Opening a webpage", browser_snapshot: "Reading the open page",
    browser_click: "Interacting with the page", browser_type: "Entering text on the page",
    browser_scroll: "Reading further", web_search: "Searching the web", web_extract: "Reading a webpage",
    read_file: "Reading a file", write_file: "Updating a file", edit_file: "Editing a file",
    shell: "Running a local command", terminal: "Running a local command",
  };
  return tool ? labels[tool] || `Using ${tool.split("_").join(" ")}` : "Working";
}

function reportSummary(content: string) {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && typeof (parsed as { summary?: unknown }).summary === "string") {
      return (parsed as { summary: string }).summary;
    }
  } catch { /* Older reports may be plain text. */ }
  return content;
}

function readConversationTurns(thoughtId: number): ConversationTurn[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`ojjipa-chat-${thoughtId}`) || "[]");
    return Array.isArray(value) ? value.filter((turn): turn is ConversationTurn =>
      Boolean(turn && typeof turn === "object" && (turn as ConversationTurn).id &&
        ["user", "assistant"].includes((turn as ConversationTurn).role) && typeof (turn as ConversationTurn).text === "string"),
    ) : [];
  } catch { return []; }
}

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
    | "play"
    | "layers"
    | "orbit"
    | "sun"
    | "moon"
    | "settings"
    | "terminal";
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
    play: <path d="m8 5 11 7-11 7V5Z" />,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    orbit: <><circle cx="12" cy="12" r="2" /><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-35 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(35 12 12)" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
    moon: <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />,
    settings: <><circle cx="12" cy="12" r="3.25" /><path d="M19.14 12.94a7.5 7.5 0 0 0 0-1.88l2.03-1.58-2-3.46-2.39.96a7.5 7.5 0 0 0-1.63-.94L14.8 3h-5l-.36 3.04a7.5 7.5 0 0 0-1.63.94l-2.39-.96-2 3.46 2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58 2 3.46 2.39-.96c.5.39 1.04.7 1.63.94L9.8 22h5l.36-3.04c.59-.24 1.13-.55 1.63-.94l2.39.96 2-3.46-2.04-1.58Z" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
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
        <span>{errorMessage || savedMessage}</span>
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
  const [isModelConfigured, setIsModelConfigured] = useState(false);
  const markModelConfigured = useCallback(() => setIsModelConfigured(true), []);
  const [isDarkMode, setIsDarkMode] = useState(
    () => window.localStorage.getItem("ojjipa-theme") === "dark",
  );
  const maxThinkingSeconds = 30;
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [activityError, setActivityError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [thinkingElapsedSeconds, setThinkingElapsedSeconds] = useState(0);
  const [isChoosingFiles, setIsChoosingFiles] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [pendingThoughts, setPendingThoughts] = useState<PendingThought[]>([]);
  const [toast, setToast] = useState<WorkspaceToast | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [capturedThoughts, setCapturedThoughts] = useState<CapturedThought[]>([]);
  const [selectedThoughtId, setSelectedThoughtId] = useState<number | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatTurns, setChatTurns] = useState<ConversationTurn[]>([]);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [isConfirmingClearThoughts, setIsConfirmingClearThoughts] = useState(false);
  const [isClearingThoughts, setIsClearingThoughts] = useState(false);
  const [isConfirmingClearMiniPas, setIsConfirmingClearMiniPas] = useState(false);
  const [isClearingMiniPas, setIsClearingMiniPas] = useState(false);
  const [isConfirmingAppReset, setIsConfirmingAppReset] = useState(false);
  const [isResettingApp, setIsResettingApp] = useState(false);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [jobs, setJobs] = useState<AIJob[]>([]);
  const [reports, setReports] = useState<WorkspaceReport[]>([]);
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
  const [developerMode, setDeveloperMode] = useState(() => window.localStorage.getItem("ojjipa-developer-mode") === "true");
  const [developerLogs, setDeveloperLogs] = useState<DeveloperLog[]>([]);
  const [minipaProgress, setMinipaProgress] = useState<Record<number, MiniPaProgress[]>>(readMiniPaProgress);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<MiniPaProgress>("ojjipa-minipa-progress", (event) => {
      const progress = event.payload;
      if (!progress || !Number.isFinite(progress.minipaId) || !Number.isFinite(progress.jobId) || typeof progress.step !== "string") return;
      setMinipaProgress((current) => {
        const next = { ...current, [progress.minipaId]: [...(current[progress.minipaId] || []), progress].slice(-80) };
        // Keep recent execution history compact while retaining enough steps to explain each task.
        const minipaIds = Object.keys(next).map(Number).sort((a, b) => b - a);
        for (const staleId of minipaIds.slice(50)) delete next[staleId];
        window.localStorage.setItem("ojjipa-minipa-steps", JSON.stringify(next));
        return next;
      });
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch((error) => console.error("Could not subscribe to MiniPa execution steps:", error));
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!developerMode || !isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<DeveloperLog>("ojjipa-dev-log", (event) => {
      const entry = event.payload;
      if (!entry || typeof entry.message !== "string") return;
      setDeveloperLogs((current) => [...current, entry].slice(-300));
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch((error) => console.error("Could not subscribe to OJJIPA developer logs:", error));
    return () => { cancelled = true; unlisten?.(); };
  }, [developerMode]);

  function updateDeveloperMode(enabled: boolean) {
    setDeveloperMode(enabled);
    window.localStorage.setItem("ojjipa-developer-mode", String(enabled));
  }

  const showToast = useCallback((message: string, kind: WorkspaceToast["kind"] = "success") => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), kind, message });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 3600);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const refreshWorkspace = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const [data, attention] = await Promise.all([
        invoke<WorkspaceData>("workspace_request", {operation:"workspace.get", payload:{}}),
        invoke<AttentionData>("hold_queue_request", {operation:"attention.get", payload:{}}),
      ]);
      setCapturedThoughts(data.thoughts); setWorkers(data.minipas);
      setJobs(data.jobs ?? []); setMemories(data.memories ?? []);
      setReports(data.reports ?? []);
      setAttentionData(attention); setWorkspaceError("");
    } catch (error) { setWorkspaceError(String(error)); }
  }, []);
  useEffect(() => { void refreshWorkspace(); const timer = window.setInterval(() => void refreshWorkspace(), 3000); return () => window.clearInterval(timer); }, [refreshWorkspace]);
  async function workspaceAction(operation: string, payload: Record<string, unknown>) {
    try { await invoke("workspace_request", {operation,payload}); await refreshWorkspace(); }
    catch(error) { setWorkspaceError(String(error)); }
  }
  async function clearAllThoughts() {
    if (isClearingThoughts) return;
    setIsClearingThoughts(true);
    setWorkspaceError("");
    try {
      const result = await invoke<{ deleted: number }>("workspace_request", {operation:"thoughts.clear", payload:{}});
      setCapturedThoughts([]);
      setPendingThoughts([]);
      setSelectedThoughtId(null);
      setChatTurns([]);
      for (const thought of capturedThoughts) window.localStorage.removeItem(`ojjipa-chat-${thought.id}`);
      setIsConfirmingClearThoughts(false);
      showToast(`${result.deleted} thought${result.deleted === 1 ? "" : "s"} cleared.`);
      await refreshWorkspace();
    } catch (error) {
      setWorkspaceError(String(error));
      showToast("Could not clear thoughts. Please try again.", "error");
    } finally {
      setIsClearingThoughts(false);
    }
  }
  async function clearAllMiniPas() {
    if (isClearingMiniPas) return;
    setIsClearingMiniPas(true);
    setWorkspaceError("");
    try {
      const result = await invoke<{ deleted: number; reportsDeleted: number }>("workspace_request", { operation: "minipas.clear", payload: {} });
      setMinipaProgress({});
      window.localStorage.removeItem("ojjipa-minipa-steps");
      setIsConfirmingClearMiniPas(false);
      showToast(`${result.deleted} MiniPa${result.deleted === 1 ? "" : "s"} and ${result.reportsDeleted} related finding${result.reportsDeleted === 1 ? "" : "s"} cleared.`);
      await refreshWorkspace();
    } catch (error) {
      setWorkspaceError(String(error));
      showToast("Could not clear MiniPa history. Please try again.", "error");
    } finally {
      setIsClearingMiniPas(false);
    }
  }
  async function resetApp() {
    if (isResettingApp) return;
    setIsResettingApp(true);
    setWorkspaceError("");
    window.localStorage.removeItem("ojjipa-welcome-seen");
    window.localStorage.removeItem("ojjipa-theme");
    try {
      await invoke("reset_app");
    } catch (error) {
      if (hasEnteredWorkspace) window.localStorage.setItem("ojjipa-welcome-seen", "true");
      if (isDarkMode) window.localStorage.setItem("ojjipa-theme", "dark");
      setWorkspaceError(String(error));
      setIsResettingApp(false);
    }
  }
  async function attentionAction(operation: string, payload: Record<string, unknown>) {
    try { await invoke("hold_queue_request", {operation,payload}); await refreshWorkspace(); }
    catch(error) { setWorkspaceError(String(error)); }
  }

  async function surfaceHeldReport() {
    try {
      const result = await invoke<{ item: unknown }>("hold_queue_request", { operation: "attention.surface", payload: {} });
      await refreshWorkspace();
      showToast(result.item ? "Held report surfaced." : "No held reports waiting.", result.item ? "success" : "error");
    } catch (error) {
      setWorkspaceError(String(error));
      showToast("Could not surface a report. Please try again.", "error");
    }
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
      setActivityError("Open the desktop app to connect to your local engine.");
      return;
    }

    try {
      await invoke<AgentActivity | null>("get_agent_activity");
      setActivityError("");
    } catch (error) {
      console.error("Could not read current activity:", error);
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
    const activeStartedAt = isSubmitting ? thinkingStartedAt : pendingThoughts[0]?.startedAt ?? null;
    if (activeStartedAt === null) return;
    const updateElapsed = () => {
      setThinkingElapsedSeconds(Math.min(
        60 * 60,
        Math.floor((Date.now() - activeStartedAt) / 100) / 10,
      ));
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(interval);
  }, [isSubmitting, pendingThoughts, thinkingStartedAt]);

  useEffect(() => {
    if (pendingThoughts.length === 0) return;
    const settled = pendingThoughts.filter(({ id }) => {
      const thought = capturedThoughts.find((item) => item.id === id);
      const job = jobs.find((item) => item.dump_id === id && item.phase === "judge");
      return Boolean(thought?.decision || thought?.analysisError || job && ["completed", "failed", "cancelled"].includes(job.status));
    });
    if (settled.length === 0) return;
    const settledIds = new Set(settled.map(({ id }) => id));
    setPendingThoughts((current) => current.filter(({ id }) => !settledIds.has(id)));
    const failures = settled.filter(({ id }) => {
      const thought = capturedThoughts.find((item) => item.id === id);
      const job = jobs.find((item) => item.dump_id === id && item.phase === "judge");
      return Boolean(thought?.analysisError || job && ["failed", "cancelled"].includes(job.status));
    });
    if (failures.length > 0) {
      const job = jobs.find((item) => item.dump_id === failures[0].id && item.phase === "judge");
      showToast(job?.error || "Grandpa couldn’t finish reviewing that thought. You can retry from Thoughts.", "error");
    } else {
      const first = capturedThoughts.find((item) => item.id === settled[0].id);
      showToast(first?.decision?.minipa
        ? `Grandpa finished · MiniPa #${first.decision.minipa.id} created.`
        : "Grandpa finished reviewing your thought.");
    }
  }, [capturedThoughts, jobs, pendingThoughts, showToast]);

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
      setCapturedThoughts((current) => [
        {
          id: result.dumpId,
          content: dumpContent,
          decision: result.decision,
          analysisError: result.analysisError,
        },
        ...current,
      ]);
      if (result.decisionStatus === "pending" && !result.analysisError && !result.decision) {
        setPendingThoughts((current) => [...current.filter((item) => item.id !== result.dumpId), { id: result.dumpId, startedAt }]);
        showToast(`Thought saved · #${result.dumpId}`);
      } else if (result.analysisError) {
        setSubmitError(result.analysisError);
        showToast(`Thought saved · #${result.dumpId}. Grandpa couldn’t review it yet.`, "error");
      } else {
        showToast(`Thought saved · #${result.dumpId}`);
      }
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

  async function handleChatSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const thought = capturedThoughts.find((item) => item.id === selectedThoughtId);
    const message = chatDraft.trim();
    if (!thought || !message || isSubmitting) return;
    if (!isTauri()) {
      showToast("Open OJJIPA Desktop to continue this conversation.", "error");
      return;
    }
    const userTurn: ConversationTurn = { id: `user-${Date.now()}`, role: "user", text: message };
    const transcript = [...chatTurns, userTurn];
    setChatTurns(transcript);
    window.localStorage.setItem(`ojjipa-chat-${thought.id}`, JSON.stringify(transcript));
    setChatDraft("");
    setIsSubmitting(true);
    const startedAt = Date.now();
    setThinkingStartedAt(startedAt);
    setThinkingElapsedSeconds(0);
    try {
      const result = await invoke<{ kind: "reply" | "task"; content: string; dumpId?: number }>("workspace_request", {
        operation: "chat.submit",
        payload: { messages: [
          { role: "user", content: `The saved thought we are discussing is: ${thought.content}` },
          ...(thought.decision?.verdict === "task" || thought.decision?.verdict === "watch"
            ? [{ role: "assistant", content: `OJJIPA previously recognized this as an action request and sent it to MiniPas. Its review was: ${thought.decision.reason}` }]
            : []),
          ...transcript.map(({ role, text }) => ({ role, content: text })),
        ] },
      });
      if (typeof result?.content !== "string" || !result.content.trim()) throw new Error("The model returned an empty reply.");
      const assistantTurn: ConversationTurn = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        text: result.kind === "task" ? `${result.content}${result.dumpId ? ` · Request #${result.dumpId}` : ""}` : result.content,
        ...(result.kind === "task" && result.dumpId ? { taskDumpId: result.dumpId } : {}),
      };
      const nextTurns = [...transcript, assistantTurn];
      setChatTurns(nextTurns);
      window.localStorage.setItem(`ojjipa-chat-${thought.id}`, JSON.stringify(nextTurns));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      setChatTurns(transcript.filter((turn) => turn.id !== userTurn.id));
      window.localStorage.setItem(`ojjipa-chat-${thought.id}`, JSON.stringify(transcript.filter((turn) => turn.id !== userTurn.id)));
      setChatDraft(message);
    } finally {
      setIsSubmitting(false);
      setThinkingStartedAt(null);
    }
  }

  const canSubmit = Boolean(content.trim()) || attachments.length > 0;
  const activeThinkingJob = pendingThoughts.length > 0
    ? jobs.find((job) => job.dump_id === pendingThoughts[0].id && job.phase === "judge")
    : undefined;
  const thinkingMessage = isSubmitting
    ? "Saving your thought"
    : activeThinkingJob?.status === "queued"
      ? "Queued for Grandpa"
      : "Grandpa is thinking";

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
          }}
          placeholder="What would you like to remember?"
          rows={1}
          disabled={isSubmitting || isChoosingFiles}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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
      <p className="composer-hint">Saved locally first. Grandpa then considers your thought through your configured model; MiniPas work in the background.</p>
    </section>
  );

  function renderCapturedThoughts() {
    return capturedThoughts.length > 0 ? capturedThoughts.map((thought) => (
      <article className="captured-row captured-row-clickable" key={thought.id} onClick={() => { setSelectedThoughtId(thought.id); setChatDraft(""); setChatTurns(readConversationTurns(thought.id)); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedThoughtId(thought.id); setChatDraft(""); setChatTurns(readConversationTurns(thought.id)); } }} role="button" tabIndex={0} aria-label={`Open conversation about thought ${thought.id}`}>
        <div className="captured-row-main">
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
          {!thought.decision && <p className="captured-decision">{jobs.find(job=>job.dump_id===thought.id)?.status === 'running' ? 'Grandpa is considering this…' : jobs.some(job=>job.dump_id===thought.id) ? 'Queued for Grandpa' : 'Saved without a decision'}{!jobs.some(job=>job.dump_id===thought.id) && <button className="text-link" onClick={(event)=>{event.stopPropagation(); void workspaceAction('ai.analyze',{id:thought.id});}}>Ask Grandpa</button>}</p>}
          {jobs.filter(job=>job.dump_id===thought.id && job.status==='failed').map(job=><p className="captured-error" key={job.id}>{job.error}<button className="text-link" onClick={(event)=>{event.stopPropagation(); void workspaceAction('ai.retry',{id:job.id});}}>Retry</button></p>)}
        </div>
        <span className="captured-row-open">Open conversation <span aria-hidden="true">→</span></span>
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
      {(toast || isSubmitting || pendingThoughts.length > 0) && <div className="workspace-toast-region" aria-live="polite" aria-relevant="additions text">
        {toast && <div className={`workspace-toast workspace-toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} key={toast.id}>
          <span className="workspace-toast-mark" aria-hidden="true">{toast.kind === "error" ? "!" : "✓"}</span>
          <span>{toast.message}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => {
            if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
            toastTimer.current = null;
            setToast(null);
          }}>×</button>
        </div>}
        {(isSubmitting || pendingThoughts.length > 0) && <div className="workspace-thinking-toast" role="status">
          <span className="thinking-pixel-grid" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</span>
          <span className="workspace-thinking-copy"><strong>{thinkingMessage}</strong><small>{pendingThoughts.length > 1 ? `${pendingThoughts.length} thoughts in progress` : "Reviewing your thought and preparing next steps"}</small></span>
          <span className="thinking-timer">{thinkingElapsedSeconds.toFixed(1)}s</span>
        </div>}
      </div>}
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
              <p className="welcome-description">Hello, I’m OJJIPA. Connect your AI model, then capture thoughts and let OJJIPA help keep small tasks moving.</p>
              <button
                className="welcome-enter"
                type="button"
                onClick={() => document.getElementById("onboarding-model")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                Set up your model <span aria-hidden="true">↓</span>
              </button>
              <button className="onboarding-skip" type="button" onClick={() => {
                window.localStorage.setItem("ojjipa-welcome-seen", "true");
                setHasEnteredWorkspace(true);
              }}>I’ll do this later</button>
            </div>
            <div className="welcome-portrait">
              <div className="welcome-orbit welcome-orbit-one" />
              <div className="welcome-orbit welcome-orbit-two" />
              <img src="/brand/grandpa-illustration.png" alt="Grandpa, your OJJIPA assistant" />
              <span className="welcome-note">HERE WHEN YOU NEED ME</span>
            </div>
          </section>
          <section className="onboarding-setup" aria-labelledby="onboarding-heading">
            <div className="onboarding-steps">
              <p className="workroom-overline">A SHORT FIRST-RUN GUIDE</p>
              <h2 id="onboarding-heading">Three steps to get going</h2>
              <ol>
                <li><span>01</span><div><strong>Connect your AI model</strong><p>Choose your provider’s model ID and API URL, add its API key, then save and check the connection.</p></div></li>
                <li><span>02</span><div><strong>Save a thought</strong><p>Use the thought bar at the bottom of your workspace. OJJIPA keeps it in your local inbox.</p></div></li>
                <li><span>03</span><div><strong>Add optional connections later</strong><p>Chrome access, web research, and notifications can be configured in Settings whenever you need them.</p></div></li>
              </ol>
              {isModelConfigured && <p className="onboarding-ready" role="status"><Icon name="check" size={14} /> Model API key saved. You can enter your workspace.</p>}
              <button className="welcome-enter onboarding-finish" type="button" onClick={() => {
                window.localStorage.setItem("ojjipa-welcome-seen", "true");
                setHasEnteredWorkspace(true);
              }}>Enter your workspace <span aria-hidden="true">→</span></button>
            </div>
            <div id="onboarding-model" className="onboarding-model-step">
              <div className="onboarding-step-label"><span>01</span><p>YOUR FIRST CONNECTION</p></div>
              <ModelSettings onConfigured={markModelConfigured} />
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
            <div className="sidebar-inner">
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
                  title={tab.label}
                  aria-label={tab.label}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                >
                  <Icon name={tab.icon} size={17} />
                  <span>{tab.label}</span>
                  {tab.id === "thoughts" && capturedThoughts.length > 0 && <small>{capturedThoughts.length}</small>}
                </button>
              ))}
            </nav>
            </div>
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
                    <h1 id="welcome-heading">Hello, I’m <img className="welcome-inline-logo" src="/brand/ojjipa-wordmark-transparent.png" alt="OJJIPA" />.</h1>
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
                <section className="tab-page" aria-labelledby={selectedThoughtId === null ? "page-heading" : "conversation-heading"}>
                  {selectedThoughtId === null ? <><div className="page-heading-row">
                    <div><p className="eyebrow"><span className="eyebrow-mark" /> YOUR PRIVATE INBOX</p><h1 id="page-heading">Thoughts</h1><p className="page-description">Drop a thought here. Select any thought to open its conversation with OJJIPA.</p></div>
                  </div>
                  <section className="content-panel thoughts-list">
                    <div className="panel-heading"><div><p className="workroom-overline">LOCAL DUMPS</p><h2>Recently captured</h2></div><div className="thoughts-list-actions"><span className="sample-stamp">{capturedThoughts.length} SAVED</span>{capturedThoughts.length > 0 && <button className="text-link danger-link" type="button" onClick={() => setIsConfirmingClearThoughts(true)}>Clear all thoughts</button>}</div></div>
                    {isConfirmingClearThoughts && <div className="clear-thoughts-confirmation" role="group" aria-label="Confirm clearing all thoughts">
                      <p><strong>Clear all saved thoughts?</strong><span>This permanently deletes every thought and its decision. Existing MiniPas, reports, and saved memories remain.</span></p>
                      <div><button className="text-link" type="button" disabled={isClearingThoughts} onClick={() => setIsConfirmingClearThoughts(false)}>Cancel</button><button className="danger-button" type="button" disabled={isClearingThoughts} onClick={() => void clearAllThoughts()}>{isClearingThoughts ? "Clearing…" : "Delete all thoughts"}</button></div>
                    </div>}
                    {renderCapturedThoughts()}
                  </section></> : (() => {
                    const thought = capturedThoughts.find((item) => item.id === selectedThoughtId);
                    if (!thought) return <section className="content-panel conversation-panel"><button className="text-link" type="button" onClick={() => setSelectedThoughtId(null)}>← Back to thoughts</button><p>This thought is no longer available.</p></section>;
                    return <section className="conversation-view" aria-labelledby="conversation-heading">
                      <div className="conversation-heading"><button className="text-link" type="button" onClick={() => setSelectedThoughtId(null)}>← All thoughts</button><div><p className="eyebrow"><span className="eyebrow-mark" /> THOUGHT · #{thought.id}</p><h1 id="conversation-heading">Conversation</h1></div></div>
                      <div className="conversation-transcript" aria-live="polite">
                        <article className="conversation-message conversation-message-user"><p>{thought.content}</p><span>You</span></article>
                        {thought.decision ? <article className="conversation-message conversation-message-assistant"><p>{thought.decision.reason}</p><span>OJJIPA · {thought.decision.verdict}</span></article> : <article className="conversation-message conversation-message-assistant"><p>{thought.analysisError || (jobs.some((job) => job.dump_id === thought.id && job.status === "running") ? "Grandpa is considering your thought…" : "Your thought is saved. Ask OJJIPA to take a closer look or send a follow-up below." )}</p><span>OJJIPA</span></article>}
                        {chatTurns.map((turn) => {
                          const taskThought = turn.taskDumpId ? capturedThoughts.find((item) => item.id === turn.taskDumpId) : undefined;
                          const taskWorkerId = taskThought?.decision?.minipa?.id;
                          const taskWorker = taskWorkerId ? workers.find((item) => item.id === taskWorkerId) : undefined;
                          const taskJob = jobs.find((item) => item.dump_id === turn.taskDumpId && item.phase === "judge");
                          const execution = taskWorkerId ? jobs.find((item) => item.minipa_id === taskWorkerId && item.phase !== "watch") : undefined;
                          const executionSteps = taskWorkerId && execution
                            ? (minipaProgress[taskWorkerId] || []).filter((step) => step.jobId === execution.id)
                            : [];
                          const taskReport = taskWorkerId
                            ? reports.find((report) => report.minipa_id === taskWorkerId && report.content.trim() && !report.delivery)
                            : undefined;
                          const taskStatus = taskReport ? "Completed"
                            : execution?.status === "failed" || taskJob?.status === "failed" ? "Needs attention"
                              : execution?.status === "running" ? "Working on your request"
                                : execution?.status === "queued" ? "MiniPa queued"
                                  : execution?.status === "completed" ? "Task finished · preparing result"
                                    : taskWorker ? `MiniPa ${taskWorker.status}`
                                      : taskJob?.status === "running" || taskJob?.status === "queued" ? "Grandpa is preparing your MiniPa"
                                        : "Waiting for MiniPa assignment";
                          return <article className={`conversation-message conversation-message-${turn.role}${turn.taskDumpId ? " conversation-task-message" : ""}`} key={turn.id}>
                            <p>{turn.text}</p>
                            {turn.taskDumpId && <section className="conversation-task-feed" aria-label="MiniPa task progress" aria-live="polite">
                              <div className="conversation-task-feed-heading">
                                <span className="conversation-task-mark"><Icon name="layers" size={14} /></span>
                                <span><strong>{taskWorkerId ? `MINIPA · #${taskWorkerId}` : `TASK · #${turn.taskDumpId}`}</strong><small>{taskStatus}</small></span>
                                <span className={`conversation-task-indicator${taskStatus === "Needs attention" ? " conversation-task-indicator-error" : ""}`} aria-hidden="true" />
                              </div>
                              {executionSteps.length > 0 ? <ol className="conversation-task-steps">
                                {executionSteps.map((step, index) => <li className={`conversation-task-step conversation-task-step-${step.state}`} key={`${step.timestamp}-${index}`}>
                                  <span className="conversation-task-step-mark" aria-hidden="true">{step.state === "completed" ? "✓" : step.state === "failed" ? "!" : <i />}</span>
                                  <span><strong>{step.tool ? miniPaToolLabel(step.tool) : step.step}</strong>{step.url && <a href={step.url} target="_blank" rel="noreferrer">{step.url}</a>}</span>
                                  <small>{step.state === "completed" ? "Done" : step.state === "failed" ? "Issue" : "In progress"}</small>
                                </li>)}
                              </ol> : <p className="conversation-task-waiting">{taskStatus === "Working on your request" ? "Your MiniPa is running. Step updates will appear here." : "This conversation will show the MiniPa’s steps and final result as they arrive."}</p>}
                              {execution?.error && <p className="conversation-task-error">{execution.error}</p>}
                              {taskReport && <div className="conversation-task-result"><p className="workroom-overline">TASK RESULT</p><p>{reportSummary(taskReport.content)}</p></div>}
                            </section>}
                            <span>{turn.role === "user" ? "You" : "OJJIPA"}</span>
                          </article>;
                        })}
                      </div>
                      <form className="conversation-composer" onSubmit={(event) => void handleChatSubmit(event)}>
                        <label className="sr-only" htmlFor="conversation-input">Continue the conversation</label>
                        <DumpBox id="conversation-input" inputRef={chatInputRef} value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask OJJIPA or give it a task…" rows={2} disabled={isSubmitting} />
                        <button type="submit" disabled={!chatDraft.trim() || isSubmitting}>{isSubmitting ? <span className="button-spinner" /> : <Icon name="send" size={15} />}<span>{isSubmitting ? "Thinking" : "Send"}</span></button>
                      </form>
                      <p className="conversation-hint">Enter to send · Shift + Enter for a new line · Actions run through MiniPas</p>
                    </section>;
                  })()}
                </section>
              )}

              {activeTab === "workers" && (
                <section className="tab-page" aria-labelledby="page-heading">
                  <div className="page-heading-row">
                    <div><h1 id="page-heading">MiniPas</h1><p className="page-description">Bounded tasks and periodic arXiv watchers, executed through Hermes.</p></div>
                  </div>
                  <section className="content-panel worker-panel" aria-label="MiniPa workers">
                    <div className="minipa-list-heading">
                      <div><p className="workroom-overline">WORKING IN THE BACKGROUND</p><h2>Your MiniPas</h2></div>
                      <div className="minipa-list-actions"><span className="sample-stamp">{workers.length} {workers.length === 1 ? "WORKER" : "WORKERS"}</span>{workers.length > 0 && <button className="text-link danger-link" type="button" onClick={() => setIsConfirmingClearMiniPas(true)}>Clear MiniPas</button>}</div>
                    </div>
                    {isConfirmingClearMiniPas && <div className="clear-thoughts-confirmation" role="group" aria-label="Confirm clearing MiniPas history">
                      <p><strong>Remove all MiniPas and their history?</strong><span>This deletes every MiniPa, its execution history, related findings, and watcher history. Captured thoughts remain; decisions linked to these MiniPas are removed.</span></p>
                      <div><button className="text-link" type="button" disabled={isClearingMiniPas} onClick={() => setIsConfirmingClearMiniPas(false)}>Cancel</button><button className="danger-button" type="button" disabled={isClearingMiniPas} onClick={() => void clearAllMiniPas()}>{isClearingMiniPas ? "Clearing…" : "Delete MiniPas"}</button></div>
                    </div>}
                    <div className="minipa-list">
                      {workers.map((worker) => {
                        const workerJobs = jobs.filter((job) => job.minipa_id === worker.id);
                        const hasPendingWork = workerJobs.some((job) => ["queued", "running", "failed"].includes(job.status));
                        return <article className={`worker-row minipa-card minipa-${worker.status}`} key={worker.id}>
                          <div className="minipa-card-mark" aria-hidden="true"><Icon name="layers" size={18} /></div>
                          <div className="minipa-card-content">
                            <div className="minipa-card-heading">
                              <div className="minipa-title-block">
                                <p className="minipa-kicker">{worker.kind === "watcher" ? "PERIODIC WATCHER" : "BOUNDED TASK"}<span>MINIPA · #{worker.id}</span></p>
                                <h3>{worker.purpose}</h3>
                              </div>
                              <span className={`minipa-status minipa-status-${worker.status}`}><i />{worker.status}</span>
                            </div>
                            {worker.termination_condition && <div className="minipa-condition"><span>COMPLETION CONDITION</span><p>{worker.termination_condition}</p></div>}
                            {workerJobs.length > 0 && <div className="minipa-executions">
                              <p className="minipa-section-label">EXECUTION STEPS</p>
                              {workerJobs.map((job) => <div className="minipa-execution" key={job.id}>
                                <div className="minipa-execution-heading"><span className={`minipa-execution-indicator minipa-execution-${job.status}`} aria-hidden="true" /><span className="minipa-execution-name">{job.phase === "watch" ? "Scheduled check" : "Task execution"}</span><span className={`minipa-execution-state minipa-execution-state-${job.status}`}>{job.status}</span></div>
                                {(minipaProgress[worker.id] || []).filter((step) => step.jobId === job.id).length > 0
                                  ? <ol className="minipa-step-list">{(minipaProgress[worker.id] || []).filter((step) => step.jobId === job.id).map((step, index) => <li className={`minipa-step minipa-step-${step.state}`} key={`${step.timestamp}-${index}`}>
                                    <span className="minipa-step-mark" aria-hidden="true">{step.state === "completed" ? "✓" : step.state === "failed" ? "!" : <i />}</span>
                                    <span className="minipa-step-copy"><span>{step.tool ? miniPaToolLabel(step.tool) : step.step}</span>{step.url && <code>{step.url}</code>}</span>
                                    <span className="minipa-step-state">{step.state === "completed" ? "Done" : step.state === "failed" ? "Issue" : "In progress"}</span>
                                  </li>)}</ol>
                                  : <p className="minipa-step-fallback">{job.status === "queued" ? "Waiting for a worker to begin." : job.status === "running" ? "Starting this MiniPa’s execution." : job.status === "failed" ? "Execution stopped before step details were available." : "This execution finished before step tracking was available."}</p>}
                                {job.phase === "watch" && job.status === "queued" && Number.isFinite(Date.parse(job.due_at)) && <time className="minipa-next-check" dateTime={job.due_at}>Next · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(job.due_at))}</time>}
                                {job.error && <p className="minipa-job-error">{job.error}</p>}
                                {job.status === "failed" && worker.status !== "retired" && <button className="minipa-retry" type="button" onClick={() => void workspaceAction("ai.retry", { id: job.id })}>Retry execution <span aria-hidden="true">↗</span></button>}
                              </div>)}
                            </div>}
                            <div className="minipa-card-actions">
                              {worker.status === "active" && !hasPendingWork && <button className="minipa-run-button" type="button" onClick={() => void workspaceAction("ai.run", { id: worker.id })}><Icon name="play" size={13} />Start execution</button>}
                              {worker.status !== "retired" && <>
                                <button className="minipa-secondary-button" type="button" onClick={() => void workspaceAction("minipa.status", { id: worker.id, status: worker.status === "active" ? "paused" : "active" })}>{worker.status === "active" ? "Pause worker" : "Resume worker"}</button>
                                <button className="minipa-retire-button" type="button" onClick={() => void workspaceAction("minipa.status", { id: worker.id, status: "retired" })}>Retire</button>
                              </>}
                            </div>
                          </div>
                        </article>;
                      })}
                    </div>
                    {!workers.length && <div className="minipa-empty-state"><span className="empty-state-icon"><Icon name="layers" size={20} /></span><h3>No MiniPas yet</h3><p>When Grandpa creates a bounded task or watcher, it will appear here.</p></div>}
                  </section>
                </section>
              )}
              {activeTab === "attention" && (
                <section className="tab-page" aria-labelledby="page-heading">
                  <div className="page-heading-row">
                    <div><p className="eyebrow"><span className="eyebrow-mark" /> HELD REPORTS, ON YOUR TERMS</p><h1 id="page-heading">Attention</h1><p className="page-description">Choose when OJJIPA can bring held reports back to you.</p></div>
                  </div>
                  <section className="content-panel attention-simple-panel" aria-label="Attention controls">
                    <div className="attention-simple-heading"><div><p className="workroom-overline">YOUR HELD REPORTS</p><h2>{attentionData?.held_count ?? 0} waiting</h2></div><button className="attention-surface-button" type="button" disabled={!attentionData?.held_count} onClick={() => void surfaceHeldReport()}>Show next report <span aria-hidden="true">↗</span></button></div>
                    <div className="attention-simple-setting">
                      <div><strong>Automatic resurfacing</strong><p>Bring reports back after a minute of steady messaging activity. OJJIPA waits at least a minute between reports.</p></div>
                      <label className="attention-toggle"><span className="sr-only">Automatically resurface held reports</span><input type="checkbox" checked={Boolean(attentionData?.preferences.auto_surface_enabled && !attentionData?.preferences.focus_enabled)} onChange={(event) => void attentionAction("attention.settings", { auto_surface_enabled: event.target.checked, focus_enabled: false })} /><i aria-hidden="true" /></label>
                    </div>
                    {activityError && <p className="attention-monitoring-note" role="status">Automatic resurfacing is unavailable: {activityError}</p>}
                  </section>
                </section>
              )}
              {activeTab === "settings" && (
                <section className="tab-page" aria-labelledby="page-heading">
                  <div className="page-heading-row">
                    <div><p className="eyebrow"><span className="eyebrow-mark" /> MAKE OJJIPA YOURS</p><h1 id="page-heading">Settings</h1><p className="page-description">Each part of OJJIPA has a place of its own.</p></div>
                    <button className="text-link settings-run-setup" type="button" onClick={() => {
                      setActiveTab("welcome");
                      setHasEnteredWorkspace(false);
                    }}>Run setup again</button>
                  </div>
                  <div className="settings-layout">
                    <nav className="settings-categories" aria-label="Settings categories">
                      {([
                        ["appearance", "Appearance", "sun"],
                        ["notifications", "Notifications", "orbit"],
                        ["ai-models", "AI models & API", "spark"],
                        ["developer", "Developer mode", "terminal"],
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
                        <>
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
                        <section className="content-panel settings-reset-panel">
                          <div className="settings-section-heading">
                            <p className="workroom-overline">APP DATA</p>
                            <h2>Reset OJJIPA</h2>
                            <p>Start over with a clean setup on this device.</p>
                          </div>
                          {isConfirmingAppReset ? (
                            <div className="clear-thoughts-confirmation" role="group" aria-label="Confirm resetting OJJIPA">
                              <p><strong>Erase all OJJIPA data on this device?</strong><span>This permanently removes thoughts, MiniPas, findings, memories, API keys, Chrome pairing, and app preferences. OJJIPA will close; reopen it to run setup again.</span></p>
                              <div><button className="text-link" type="button" disabled={isResettingApp} onClick={() => setIsConfirmingAppReset(false)}>Cancel</button><button className="danger-button" type="button" disabled={isResettingApp} onClick={() => void resetApp()}>{isResettingApp ? "Resetting…" : "Reset and close OJJIPA"}</button></div>
                            </div>
                          ) : (
                            <div className="settings-reset-actions">
                              <p>Your saved content, credentials, and preferences will be erased.</p>
                              <button className="danger-button" type="button" onClick={() => setIsConfirmingAppReset(true)}>Reset app</button>
                            </div>
                          )}
                        </section>
                        </>
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

                      {settingsCategory === "developer" && (
                        <>
                          <section className="content-panel developer-settings-panel">
                            <div className="settings-section-heading">
                              <p className="workroom-overline">DIAGNOSTICS</p>
                              <h2>Developer mode</h2>
                              <p>Show live backend activity, MiniPa lifecycle events, Chrome actions, and opened page paths.</p>
                            </div>
                            <div className="settings-row">
                              <span className="settings-icon"><Icon name="terminal" size={18} /></span>
                              <span className="settings-copy"><strong>Backend logs</strong><small>Logs are kept locally in memory for this session and are cleared when OJJIPA closes.</small></span>
                              <button className="theme-toggle settings-theme-toggle" type="button" role="switch" aria-checked={developerMode} onClick={() => updateDeveloperMode(!developerMode)}>
                                <span>{developerMode ? "On" : "Off"}</span>
                                <span className={`theme-switch${developerMode ? " theme-switch-on" : ""}`} aria-hidden="true"><span /></span>
                              </button>
                            </div>
                          </section>
                          {developerMode && (
                            <section className="content-panel developer-logs-panel" aria-label="Backend logs">
                              <div className="developer-logs-heading">
                                <div><p className="workroom-overline">LIVE SESSION</p><h2>Backend logs</h2><p>{developerLogs.length} {developerLogs.length === 1 ? "event" : "events"} · latest 300</p></div>
                                <button className="text-link" type="button" onClick={() => setDeveloperLogs([])}>Clear logs</button>
                              </div>
                              {developerLogs.length ? (
                                <ol className="developer-log-list" aria-live="polite">
                                  {developerLogs.slice().reverse().map((entry, index) => (
                                    <li className={`developer-log-entry developer-log-${entry.level === "error" ? "error" : "info"}`} key={`${entry.timestamp}-${index}`}>
                                      <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                                      <span>{entry.message}</span>
                                      {entry.url && <code title={entry.url}>{entry.url}</code>}
                                    </li>
                                  ))}
                                </ol>
                              ) : <p className="developer-logs-empty">Waiting for backend activity. Submit a thought or start a MiniPa task to see events here.</p>}
                            </section>
                          )}
                        </>
                      )}

                      {settingsCategory === "ai-models" && <><ModelSettings /><ChromeSettings /><section className="content-panel model-settings-panel profile-settings-panel">
                        <div className="settings-section-heading"><p className="workroom-overline">PROFILE & MEMORY</p><h2>Grandpa remembers</h2><p>Explicit preferences and corrections retained across MiniPa lifetimes.</p></div>
                        <UserProfile />
                        <div className="profile-memory-list">{memories.map(memory=><div className="profile-memory-row" key={memory.id}><p>{memory.content}</p><button className="text-link" onClick={()=>void workspaceAction('ai.memory.forget',{id:memory.id})}>Forget</button></div>)}{!memories.length && <p className="profile-empty-state">No durable memories yet.</p>}</div>
                      </section></>}
                    </div>
                  </div>
                </section>
              )}
            </div>
            {workspaceError && <p className="dock-feedback dock-feedback-error" role="alert">{workspaceError}<button onClick={() => void refreshWorkspace()}>Retry connection</button></p>}
            {!(activeTab === "thoughts" && selectedThoughtId !== null) && captureComposer}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
