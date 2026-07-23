"use client";

import {
  Dispatch,
  FormEvent,
  KeyboardEvent,
  RefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RealtimeUpdate } from "../lib/realtime";
import { MessageAttachment, MessageContent } from "./message-content";

type Task = {
  id: string;
  origin_id: string;
  origin_name: string;
  destination_id: string;
  channel: string;
  status: string;
  last_event: string;
  initial_text: string;
  created_at: number;
  updated_at: number;
};
type EventItem = {
  id: string;
  task_id?: string;
  type: string;
  direction?: string;
  reason?: string;
  error_message?: string;
  created_at: number;
};
type Message = {
  id: string;
  task_id: string;
  direction: string;
  sender_type?: string;
  text: string;
  attachments_json?: string;
  delivery_status: string;
  created_at: number;
};
type AttachmentInput = {
  fileName: string;
  mimeType: string;
  fileUrl: string;
};
type AttachmentPolicy = {
  enabled: boolean;
  maxCount: number;
  maxSingleBytes: number;
  maxTotalBytes: number;
  allowedMimeTypes: string[];
};
type MobilePanel = "tasks" | "conversation" | "events";

const defaultPolicy: AttachmentPolicy = {
  enabled: true,
  maxCount: 5,
  maxSingleBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  allowedMimeTypes: ["image/*", "application/pdf", "text/plain"],
};
const emptyAttachment = (): AttachmentInput => ({
  fileName: "",
  mimeType: "",
  fileUrl: "",
});
const statusLabel: Record<string, string> = {
  accepted: "Awaiting event",
  created: "Created",
  routing: "Routing",
  connected: "Connected",
  ended: "Ended",
  failed: "Failed",
};
const terminalTaskStatuses = new Set(["ended", "failed"]);
const initialForm = {
  originId: "",
  originName: "",
  destinationId: "",
  channel: "",
  text: "",
  customerTier: "",
};
const mimeByExtension: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const commonMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

function metadataFromUrl(value: string) {
  try {
    const url = new URL(value);
    const encodedName = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    let fileName = encodedName;
    try {
      fileName = decodeURIComponent(encodedName);
    } catch {
      /* Keep the URL-safe filename. */
    }
    const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
    return { fileName, mimeType: mimeByExtension[extension] ?? "" };
  } catch {
    return { fileName: "", mimeType: "" };
  }
}

function allowedMimeOptions(patterns: string[]) {
  return [
    ...new Set([
      ...commonMimeTypes.filter((type) =>
        patterns.some((pattern) =>
          pattern.endsWith("/*")
            ? type.startsWith(pattern.slice(0, -1))
            : type === pattern,
        ),
      ),
      ...patterns.filter((pattern) => !pattern.endsWith("/*")),
    ]),
  ];
}

function FormattingToolbar({
  textareaRef,
  value,
  setValue,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
}) {
  function format(kind: "bold" | "italic" | "list" | "link") {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);
    let replacement = "";
    let selectionStart = start;
    let selectionEnd = start;
    if (kind === "bold") {
      replacement = `**${selected || "bold text"}**`;
      selectionStart = start + 2;
      selectionEnd = start + replacement.length - 2;
    }
    if (kind === "italic") {
      replacement = `*${selected || "italic text"}*`;
      selectionStart = start + 1;
      selectionEnd = start + replacement.length - 1;
    }
    if (kind === "list") {
      replacement = (selected || "List item")
        .split("\n")
        .map((line) => `- ${line}`)
        .join("\n");
      selectionStart = start + 2;
      selectionEnd = start + replacement.length;
    }
    if (kind === "link") {
      replacement = `[${selected || "link text"}](https://)`;
      selectionStart = start + 1;
      selectionEnd = start + 1 + (selected || "link text").length;
    }
    setValue(`${value.slice(0, start)}${replacement}${value.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
    });
  }
  return (
    <div className="formatting-toolbar" aria-label="Markdown formatting">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => format("bold")}
        title="Bold"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => format("italic")}
        title="Italic"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => format("list")}
        title="Bulleted list"
      >
        • List
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => format("link")}
        title="Link"
      >
        ↗ Link
      </button>
      <span>Markdown</span>
    </div>
  );
}

function localTime(value: number, detailed = false) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(
    undefined,
    detailed
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

function parseAttachments(value?: string): MessageAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatMegabytes(bytes: number) {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}

function AttachmentEditor({
  value,
  onChange,
  policy,
}: {
  value: AttachmentInput[];
  onChange: (value: AttachmentInput[]) => void;
  policy: AttachmentPolicy;
}) {
  if (!policy.enabled) {
    return (
      <div className="attachment-disabled" role="note">
        Attachments are disabled for this messaging channel.
      </div>
    );
  }
  const update = (index: number, patch: Partial<AttachmentInput>) =>
    onChange(
      value.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  const mimeOptions = allowedMimeOptions(policy.allowedMimeTypes);
  const updateUrl = (index: number, fileUrl: string) => {
    const derived = metadataFromUrl(fileUrl);
    update(index, {
      fileUrl,
      ...(derived.fileName ? { fileName: derived.fileName } : {}),
      mimeType: mimeOptions.includes(derived.mimeType) ? derived.mimeType : "",
    });
  };
  return (
    <div className="attachment-editor">
      <div className="attachment-editor-head">
        <span>Attachments by public URL</span>
        <button
          type="button"
          onClick={() => onChange([...value, emptyAttachment()])}
          disabled={value.length >= policy.maxCount}
        >
          + Add file
        </button>
      </div>
      <p className="attachment-help">
        Paste an HTTPS URL. The name and type are derived when possible; Webex
        verifies the remote file size. Configured limit: {policy.maxCount}{" "}
        files, {formatMegabytes(policy.maxSingleBytes)} each and{" "}
        {formatMegabytes(policy.maxTotalBytes)} total.
      </p>
      {value.map((attachment, index) => (
        <div className="attachment-row" key={index}>
          <label>
            File URL
            <input
              type="url"
              required
              value={attachment.fileUrl}
              onChange={(event) => updateUrl(index, event.target.value)}
              placeholder="https://cdn.example.com/image.png"
            />
          </label>
          <label>
            File name
            <input
              required
              value={attachment.fileName}
              onChange={(event) =>
                update(index, { fileName: event.target.value })
              }
              placeholder="image.png"
            />
          </label>
          <label>
            MIME type
            <select
              required
              value={attachment.mimeType}
              onChange={(event) =>
                update(index, { mimeType: event.target.value })
              }
            >
              <option value="">Choose a supported type</option>
              {mimeOptions.map((type) => (
                <option value={type} key={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <button
            className="remove-attachment"
            type="button"
            onClick={() =>
              onChange(value.filter((_, itemIndex) => itemIndex !== index))
            }
            aria-label={`Remove ${attachment.fileName || `attachment ${index + 1}`}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [mode, setMode] = useState<"sandbox" | "live">("sandbox");
  const [streamConnected, setStreamConnected] = useState(false);
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<
    AttachmentInput[]
  >([]);
  const [showAttachments, setShowAttachments] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("tasks");
  const [form, setForm] = useState(initialForm);
  const [formAttachments, setFormAttachments] = useState<AttachmentInput[]>([]);
  const [policy, setPolicy] = useState(defaultPolicy);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const initialMessageRef = useRef<HTMLTextAreaElement>(null);
  const selectedIdRef = useRef("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as {
      tasks: Task[];
      events: EventItem[];
      mode: "sandbox" | "live";
      attachmentPolicy?: AttachmentPolicy;
    };
    setTasks(data.tasks);
    setEvents(data.events);
    setMode(data.mode);
    if (data.attachmentPolicy) {
      setPolicy(data.attachmentPolicy);
      if (!data.attachmentPolicy.enabled) {
        setShowAttachments(false);
        setComposerAttachments([]);
        setFormAttachments([]);
      }
    }
    setSelectedId((current) => current || data.tasks[0]?.id || "");
  }, []);
  const loadMessages = useCallback(async (taskId: string) => {
    if (!taskId) {
      setMessages([]);
      return;
    }
    const response = await fetch(
      `/api/tasks/${encodeURIComponent(taskId)}/messages`,
      { cache: "no-store" },
    );
    if (response.ok) setMessages((await response.json()).messages as Message[]);
  }, []);
  const applyRealtimeUpdate = useCallback((update: RealtimeUpdate) => {
    if (update.task) {
      setTasks((current) =>
        [
          update.task!,
          ...current.filter((item) => item.id !== update.task!.id),
        ].sort((a, b) => Number(b.updated_at) - Number(a.updated_at)),
      );
      setSelectedId((current) => current || update.task!.id);
    } else if (update.taskPatch) {
      setTasks((current) =>
        current
          .map((item) =>
            item.id === update.taskPatch!.id
              ? { ...item, ...update.taskPatch }
              : item,
          )
          .sort((a, b) => Number(b.updated_at) - Number(a.updated_at)),
      );
    }
    if (update.event) {
      setEvents((current) =>
        [
          update.event!,
          ...current.filter((item) => item.id !== update.event!.id),
        ]
          .sort((a, b) => Number(b.created_at) - Number(a.created_at))
          .slice(0, 80),
      );
    }
    if (update.message && update.taskId === selectedIdRef.current) {
      setMessages((current) =>
        [
          ...current.filter((item) => item.id !== update.message!.id),
          update.message!,
        ].sort(
          (a, b) =>
            Number(a.created_at) - Number(b.created_at) ||
            a.id.localeCompare(b.id),
        ),
      );
    }
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    const initial = setTimeout(refresh, 0);
    const source = new EventSource("/api/live");
    let connectedOnce = false;
    let lastRecovery = 0;
    const recover = () => {
      void refresh();
      if (selectedIdRef.current) void loadMessages(selectedIdRef.current);
    };
    const receive = (event: globalThis.MessageEvent<string>) => {
      try {
        applyRealtimeUpdate(JSON.parse(event.data) as RealtimeUpdate);
      } catch {
        recover();
      }
    };
    source.addEventListener("update", receive as EventListener);
    source.onopen = () => {
      setStreamConnected(true);
      if (connectedOnce) recover();
      connectedOnce = true;
    };
    source.onerror = () => {
      setStreamConnected(false);
      if (Date.now() - lastRecovery > 30_000) {
        lastRecovery = Date.now();
        recover();
      }
    };
    const fallback = setInterval(recover, 5 * 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(fallback);
      source.removeEventListener("update", receive as EventListener);
      source.close();
    };
  }, [applyRealtimeUpdate, loadMessages, refresh]);
  useEffect(() => {
    const request = setTimeout(() => loadMessages(selectedId), 0);
    return () => clearTimeout(request);
  }, [selectedId, loadMessages]);
  useEffect(() => {
    if (!createOpen) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [createOpen]);
  const selected = tasks.find((task) => task.id === selectedId);
  const taskClosed = selected
    ? terminalTaskStatuses.has(selected.status)
    : false;
  const visibleTasks = useMemo(
    () =>
      tasks.filter((task) =>
        `${task.origin_name} ${task.origin_id} ${task.id} ${task.status}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [tasks, search],
  );
  const orderedMessages = useMemo(
    () =>
      [...messages].sort(
        (a, b) =>
          Number(a.created_at) - Number(b.created_at) ||
          a.id.localeCompare(b.id),
      ),
    [messages],
  );
  const newestMessageId = orderedMessages.at(-1)?.id;
  const activeCount = tasks.filter(
    (task) => !terminalTaskStatuses.has(task.status),
  ).length;
  const failureCount = tasks.filter((task) => task.status === "failed").length;

  useEffect(() => {
    if (!newestMessageId) return;
    const frame = requestAnimationFrame(() =>
      timelineRef.current?.scrollTo({
        top: timelineRef.current.scrollHeight,
        behavior: "smooth",
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [newestMessageId, selectedId]);

  function chooseTask(id: string) {
    setSelectedId(id);
    setMobilePanel("conversation");
  }
  async function createTask(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, attachments: formAttachments }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setNotice(data.error ?? "Could not create task.");
    setSelectedId(data.taskId);
    setCreateOpen(false);
    setForm(initialForm);
    setFormAttachments([]);
    setMobilePanel("conversation");
    if (data.update) applyRealtimeUpdate(data.update as RealtimeUpdate);
  }
  async function appendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || !composer.trim()) return;
    if (taskClosed) {
      setNotice("This conversation is closed and cannot accept messages.");
      return;
    }
    setBusy(true);
    setNotice("");
    const response = await fetch(
      `/api/tasks/${encodeURIComponent(selected.id)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: composer,
          attachments: composerAttachments,
        }),
      },
    );
    const data = await response.json();
    setBusy(false);
    if (!response.ok)
      return setNotice(data.error ?? "Could not append message.");
    setComposer("");
    setComposerAttachments([]);
    setShowAttachments(false);
    if (data.update) applyRealtimeUpdate(data.update as RealtimeUpdate);
  }
  async function advanceDemo() {
    if (!selected) return;
    setBusy(true);
    const response = await fetch("/api/demo/advance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: selected.id }),
    });
    const data = await response.json();
    setBusy(false);
    setNotice(response.ok ? `Received ${data.type}.` : data.error);
    if (response.ok && data.update)
      applyRealtimeUpdate(data.update as RealtimeUpdate);
  }
  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      setComposer((value) => `${value.slice(0, start)}\n${value.slice(end)}`);
      requestAnimationFrame(() =>
        target.setSelectionRange(start + 1, start + 1),
      );
      return;
    }
    if (event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Relay home">
          <span className="brand-mark">R</span>
          <span>Relay</span>
        </a>
        <div className="header-health">
          <div>
            <span>Active tasks</span>
            <strong>{activeCount}</strong>
          </div>
          <div>
            <span>Webhook health</span>
            <strong className={failureCount ? "health-fail" : "health-good"}>
              {failureCount ? "Check" : "Good"}
            </strong>
          </div>
        </div>
        <div className={`mode ${mode}`}>
          <span />
          {mode === "live" ? "Live Webex" : "Sandbox"}
        </div>
      </header>
      <section className="hero" id="top">
        <div>
          <p className="eyebrow">CUSTOM MESSAGING MIDDLEWARE</p>
          <h1>Every customer conversation, in one place.</h1>
          <p className="lede">
            Create Webex Contact Center tasks, append messages, and monitor
            lifecycle webhooks.
          </p>
        </div>
        <button className="hero-create" onClick={() => setCreateOpen(true)}>
          <span>+</span> Start new
        </button>
      </section>
      <div className="mobile-tabs" role="tablist" aria-label="Workspace panels">
        {(["tasks", "conversation", "events"] as MobilePanel[]).map((panel) => (
          <button
            role="tab"
            aria-selected={mobilePanel === panel}
            className={mobilePanel === panel ? "active" : ""}
            onClick={() => setMobilePanel(panel)}
            key={panel}
          >
            {panel === "events"
              ? "Events"
              : panel[0].toUpperCase() + panel.slice(1)}
          </button>
        ))}
      </div>
      <section className={`workspace panel-${mobilePanel}`}>
        <aside className="task-rail">
          <div className="section-head">
            <div>
              <p className="eyebrow">INBOX</p>
              <h2>Tasks</h2>
            </div>
            <button
              className="new-task-button"
              onClick={() => setCreateOpen(true)}
              aria-label="Start a new conversation"
            >
              +
            </button>
          </div>
          <label className="search">
            <span>⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search customer or task ID"
            />
          </label>
          <div className="task-list">
            {visibleTasks.map((task) => (
              <button
                className={`task-card ${task.id === selectedId ? "selected" : ""}`}
                key={task.id}
                onClick={() => chooseTask(task.id)}
              >
                <span className={`status-dot ${task.status}`} />
                <span className="task-copy">
                  <strong>{task.origin_name || task.origin_id}</strong>
                  <small>{task.initial_text}</small>
                  <em>{task.channel}</em>
                </span>
                <time title={new Date(Number(task.updated_at)).toString()}>
                  {localTime(task.updated_at)}
                </time>
              </button>
            ))}
            {!visibleTasks.length && (
              <button
                className="empty empty-action"
                onClick={() => setCreateOpen(true)}
              >
                <span>+</span>
                <strong>Start your first task</strong>
                <p>Create an inbound conversation.</p>
              </button>
            )}
          </div>
        </aside>
        <section className="conversation">
          {selected ? (
            <>
              <div className="conversation-head">
                <div>
                  <p className="eyebrow">CONVERSATION</p>
                  <h2>{selected.origin_name || selected.origin_id}</h2>
                  <p>
                    {selected.origin_id} <span>→</span>{" "}
                    {selected.destination_id}
                  </p>
                </div>
                <div className={`status-pill ${selected.status}`}>
                  {statusLabel[selected.status] ?? selected.status}
                </div>
              </div>
              <div className="task-meta">
                <span>Task ID</span>
                <code>{selected.id}</code>
                <button
                  onClick={() => navigator.clipboard?.writeText(selected.id)}
                >
                  Copy
                </button>
              </div>
              <div className="timeline" ref={timelineRef} aria-live="polite">
                {orderedMessages.map((message) => (
                  <article
                    className={`message ${message.direction.toLowerCase()}`}
                    key={message.id}
                  >
                    <div className="message-label">
                      <strong>
                        {message.direction === "OUTBOUND"
                          ? message.sender_type || "Agent"
                          : selected.origin_name || "Customer"}
                      </strong>
                      <time
                        title={new Date(Number(message.created_at)).toString()}
                      >
                        {localTime(message.created_at)}
                      </time>
                    </div>
                    <div className="message-bubble">
                      <MessageContent
                        text={message.text || "Attachment"}
                        attachments={parseAttachments(message.attachments_json)}
                      />
                    </div>
                    {message.direction === "OUTBOUND" ? (
                      <small>{`Relay: ${message.delivery_status}`}</small>
                    ) : (
                      <small className="message-delivery">
                        <span>{message.id.slice(0, 8)}</span>
                        <span
                          className={`delivery-check ${message.delivery_status}`}
                          role="img"
                          aria-label={
                            message.delivery_status === "appended"
                              ? "Successfully appended to Webex"
                              : message.delivery_status === "failed"
                                ? "Message append failed"
                                : "Message accepted for sending"
                          }
                          title={
                            message.delivery_status === "appended"
                              ? "Successfully appended to Webex"
                              : message.delivery_status === "failed"
                                ? "Message append failed"
                                : "Accepted by the Tasks API"
                          }
                        >
                          {message.delivery_status === "appended"
                            ? "✓✓"
                            : message.delivery_status === "failed"
                              ? "!"
                              : "✓"}
                        </span>
                      </small>
                    )}
                  </article>
                ))}
              </div>
              {taskClosed ? (
                <div className="conversation-closed" role="status">
                  <span>✓</span>
                  <div>
                    <strong>Conversation closed</strong>
                    <p>
                      Webex ended this task. Its history remains available, but
                      no additional messages can be appended.
                    </p>
                  </div>
                </div>
              ) : (
                <form className="composer" onSubmit={appendMessage}>
                  {showAttachments && (
                    <AttachmentEditor
                      value={composerAttachments}
                      onChange={setComposerAttachments}
                      policy={policy}
                    />
                  )}
                  <FormattingToolbar
                    textareaRef={composerRef}
                    value={composer}
                    setValue={setComposer}
                  />
                  <textarea
                    ref={composerRef}
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={composerKeyDown}
                    placeholder="Append a customer message…"
                    aria-label="Customer message"
                  />
                  <div>
                    <span>Enter sends · Shift/Ctrl/⌘ + Enter adds a line</span>
                    <span className="composer-actions">
                      <button
                        className="attach-button"
                        type="button"
                        onClick={() => setShowAttachments((value) => !value)}
                        aria-pressed={showAttachments}
                        disabled={!policy.enabled}
                        title={
                          policy.enabled
                            ? "Attach a public HTTPS file"
                            : "Attachments are disabled for this channel"
                        }
                      >
                        {policy.enabled ? "Attach" : "Attachments off"}
                        {composerAttachments.length
                          ? ` (${composerAttachments.length})`
                          : ""}
                      </button>
                      <button
                        className="send-button"
                        disabled={busy || !composer.trim()}
                      >
                        Append <b>↗</b>
                      </button>
                    </span>
                  </div>
                </form>
              )}
            </>
          ) : (
            <div className="select-empty">
              <span>↗</span>
              <h2>Select a task</h2>
              <p>Conversation details and message history will appear here.</p>
            </div>
          )}
        </section>
        <aside className="event-rail">
          <div className="section-head">
            <div>
              <p className="eyebrow">
                {streamConnected ? "LIVE" : "RECONNECTING"}
              </p>
              <h2>Event stream</h2>
            </div>
            <span
              className={`pulse${streamConnected ? "" : " disconnected"}`}
              title={
                streamConnected
                  ? "Real-time event stream connected"
                  : "Real-time event stream reconnecting"
              }
            />
          </div>
          <div className="event-list">
            {events
              .filter((item) => !selectedId || item.task_id === selectedId)
              .slice(0, 40)
              .map((item) => (
                <article className="event" key={item.id}>
                  <span
                    className={
                      item.type.includes("failed")
                        ? "event-icon fail"
                        : "event-icon"
                    }
                  >
                    {item.type.includes("message")
                      ? "↗"
                      : item.type.includes("ended")
                        ? "✓"
                        : "•"}
                  </span>
                  <div>
                    <strong>{item.type}</strong>
                    <p>
                      {item.error_message ||
                        item.reason ||
                        (item.direction
                          ? `${item.direction.toLowerCase()} event`
                          : "Lifecycle update")}
                    </p>
                    <time title={new Date(Number(item.created_at)).toString()}>
                      {localTime(item.created_at, true)}
                    </time>
                  </div>
                </article>
              ))}
            {!events.length && (
              <div className="empty slim">
                <span>⋮</span>
                <strong>Listening</strong>
                <p>Webhook events will appear here.</p>
              </div>
            )}
          </div>
          {mode === "sandbox" && selected && (
            <button
              className="demo-button"
              onClick={advanceDemo}
              disabled={busy || terminalTaskStatuses.has(selected.status)}
            >
              Advance demo event <span>→</span>
            </button>
          )}
        </aside>
      </section>
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button
            onClick={() => setNotice("")}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}
      {createOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreateOpen(false);
          }}
        >
          <section
            className="create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">NEW INBOUND TASK</p>
                <h2 id="create-title">Start a conversation.</h2>
              </div>
              <button onClick={() => setCreateOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <form className="create-form" onSubmit={createTask}>
              <div className="field-row">
                <label>
                  Customer ID
                  <input
                    autoFocus
                    required
                    value={form.originId}
                    onChange={(event) =>
                      setForm({ ...form, originId: event.target.value })
                    }
                    placeholder="customer@example.com"
                  />
                </label>
                <label>
                  Customer name
                  <input
                    value={form.originName}
                    onChange={(event) =>
                      setForm({ ...form, originName: event.target.value })
                    }
                    placeholder="Maya Chen"
                  />
                </label>
              </div>
              <div className="field-row">
                <label>
                  Business address
                  <input
                    required
                    value={form.destinationId}
                    onChange={(event) =>
                      setForm({ ...form, destinationId: event.target.value })
                    }
                    placeholder="support@channel.biz"
                  />
                </label>
                <label>
                  Channel name
                  <input
                    required
                    value={form.channel}
                    onChange={(event) =>
                      setForm({ ...form, channel: event.target.value })
                    }
                    placeholder="my-custom-channel"
                  />
                </label>
              </div>
              <div className="message-field">
                <label htmlFor="initial-message">
                  Initial customer message
                </label>
                <FormattingToolbar
                  textareaRef={initialMessageRef}
                  value={form.text}
                  setValue={(value) =>
                    setForm((current) => ({
                      ...current,
                      text:
                        typeof value === "function"
                          ? value(current.text)
                          : value,
                    }))
                  }
                />
                <textarea
                  id="initial-message"
                  ref={initialMessageRef}
                  required
                  value={form.text}
                  onChange={(event) =>
                    setForm({ ...form, text: event.target.value })
                  }
                  placeholder="Hello, I need help with my order."
                />
              </div>
              <label>
                Customer tier
                <input
                  value={form.customerTier}
                  onChange={(event) =>
                    setForm({ ...form, customerTier: event.target.value })
                  }
                  placeholder="gold (optional)"
                />
              </label>
              {policy.enabled ? (
                <AttachmentEditor
                  value={formAttachments}
                  onChange={setFormAttachments}
                  policy={policy}
                />
              ) : (
                <div className="attachment-disabled" role="note">
                  Attachments are disabled for this messaging channel.
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCreateOpen(false)}
                >
                  Cancel
                </button>
                <button disabled={busy}>
                  Create task <b>↗</b>
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
