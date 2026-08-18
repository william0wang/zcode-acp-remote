import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActionBarPrimitive,
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useExternalStoreRuntime,
  useThreadViewport,
  useThreadViewportAutoScroll,
  groupPartByType,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import ReactDiffViewer from "react-diff-viewer-continued";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Brain,
  Check,
  ChevronDown,
  Copy,
  FilePen,
  FileText,
  Globe,
  History,
  Layers,
  ListChecks,
  Search,
  Square,
  Terminal,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import "highlight.js/styles/github-dark.css";
import { useAppStore } from "../store/appStore";
import { Spinner } from "../components/Spinner";
import type { AcpDiffContent, ChatMessage } from "../lib/types";

// ACP chat model -> assistant-ui message model (the ACP runtime adapter).

const convertMessage = (m: ChatMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  createdAt: new Date(m.createdAt),
  content: m.parts.map((p) => {
    if (p.type === "text") return { type: "text" as const, text: p.text };
    // Thought streams map onto the reasoning part type so they render through
    // the collapsible ThoughtCard (auto-status marks the last part of the
    // streaming message "running", which drives expand/collapse).
    if (p.type === "thought") {
      return { type: "reasoning" as const, text: p.text };
    }
    return {
      type: "tool-call" as const,
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      // args must be JSON-clean: diffs ride as a serialized array.
      args: {
        detail: p.detail,
        title: p.toolName,
        ...(p.kind ? { kind: p.kind } : {}),
        ...(p.rawName ? { rawName: p.rawName } : {}),
        ...(p.foldKind ? { foldKind: p.foldKind } : {}),
        ...(p.diffs ? { diffs: JSON.stringify(p.diffs) } : {}),
      },
      result: p.status === "completed" ? p.detail : p.status,
    };
  }),
});

function messageText(message: ThreadMessageLike | string): string {
  if (typeof message === "string") return message;
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
}

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none prose-pre:rounded-xl prose-pre:bg-canvas prose-pre:ring-1 prose-pre:ring-hairline">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </Markdown>
    </div>
  );
}

// Per-kind icon + accent colour (ADR 0004: rendering leans on libraries;
// the mapping itself is ours).
const TOOL_KIND_META: Record<string, { icon: LucideIcon; className: string }> =
  {
    execute: { icon: Terminal, className: "text-amber-400" },
    edit: { icon: FilePen, className: "text-sky-400" },
    read: { icon: FileText, className: "text-zinc-400" },
    search: { icon: Search, className: "text-violet-400" },
    fetch: { icon: Globe, className: "text-emerald-400" },
    switch_mode: { icon: ListChecks, className: "text-cyan-400" },
    other: { icon: Wrench, className: "text-faint" },
  };

// Replay harness folds (`_meta.zcode.kind`, server 0.6.0): collapsed-by-default
// plumbing cards; the summary row shows the label only, full text behind expand.
const TOOL_FOLD_META: Record<string, { icon: LucideIcon; className: string }> =
  {
    "context-handoff": { icon: Layers, className: "text-amber-400" },
    "tool-transcript": { icon: History, className: "text-zinc-400" },
  };

interface ToolCardArgs {
  detail?: string;
  kind?: string;
  rawName?: string;
  title?: string;
  foldKind?: string;
  diffs?: string;
}

function parseDiffs(raw: string | undefined): AcpDiffContent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as AcpDiffContent[]) : [];
  } catch {
    return [];
  }
}

// jsdiff (inside ReactDiffViewer) on whole-file old/new texts can freeze the
// WebView for seconds or kill it on memory — cap what we hand it and say so.
const MAX_DIFF_CHARS = 20000;

function DiffBlock({ diff }: { diff: AcpDiffContent }) {
  const { t } = useTranslation();
  const truncOld = (diff.oldText ?? "").length > MAX_DIFF_CHARS;
  const truncNew = diff.newText.length > MAX_DIFF_CHARS;
  return (
    <div className="mt-2 overflow-hidden rounded-lg ring-1 ring-hairline">
      {diff.path && (
        <div className="truncate border-b border-hairline bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-dim">
          {diff.path}
        </div>
      )}
      {(truncOld || truncNew) && (
        <div className="border-b border-hairline bg-amber-950/40 px-2 py-1 text-[10px] text-amber-300">
          {t("chat.diffTruncated")}
        </div>
      )}
      <ReactDiffViewer
        oldValue={
          truncOld
            ? diff.oldText!.slice(0, MAX_DIFF_CHARS)
            : (diff.oldText ?? "")
        }
        newValue={
          truncNew ? diff.newText.slice(0, MAX_DIFF_CHARS) : diff.newText
        }
        splitView={false}
        useDarkTheme
        hideLineNumbers
        showDiffOnly={false}
        styles={{
          contentText: {
            fontSize: "11px",
            lineHeight: "1.5",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
          },
        }}
      />
    </div>
  );
}

function ToolCard({ part }: { part: { toolName: string; args?: unknown } }) {
  const { t } = useTranslation();
  const a = (part.args ?? {}) as ToolCardArgs;
  const detail = a.detail ?? "";
  const diffs = useMemo(() => parseDiffs(a.diffs), [a.diffs]);
  const foldKind = typeof a.foldKind === "string" ? a.foldKind : null;
  const foldMeta = foldKind ? (TOOL_FOLD_META[foldKind] ?? null) : null;
  const meta = foldMeta ?? TOOL_KIND_META[a.kind ?? ""] ?? TOOL_KIND_META.other;
  const Icon = meta.icon;
  // `toolName` holds the wire title "Bash: npm test"; prefer the raw backend
  // name, else the segment before the first colon. Handoff folds use the
  // localized label — the wire title is English-only plumbing.
  const name =
    foldKind === "context-handoff"
      ? t("chat.contextHandoff")
      : a.rawName ||
        (a.title ?? part.toolName).split(":")[0]?.trim() ||
        part.toolName;
  return (
    <details className="group my-2 max-w-full overflow-hidden rounded-xl bg-white/[0.04] text-xs">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-dim">
        <Icon className={`size-3.5 shrink-0 ${meta.className}`} />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {/* Fold summaries stay clean: the body is harness plumbing text. */}
        {!foldKind && detail && (
          <span className="truncate text-faint">{detail.slice(0, 120)}</span>
        )}
        <ChevronDown className="ml-auto size-3.5 shrink-0 text-faint transition-transform duration-200 group-open:rotate-180" />
      </summary>
      {diffs.length > 0 ? (
        <div className="border-t border-hairline px-2 py-2">
          {diffs.map((d, i) => (
            <DiffBlock key={`${d.path}-${i}`} diff={d} />
          ))}
          {detail && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border-t border-hairline px-3 py-2 text-faint">
              {detail}
            </pre>
          )}
        </div>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-hairline px-3 py-2 text-faint">
          {detail || "…"}
        </pre>
      )}
    </details>
  );
}

// Collapsible reasoning block. `streaming` comes from the group part's
// auto-status: it holds the block open (bottom-pinned on the newest tokens)
// while the model thinks, collapses once the answer starts, and defers to the
// first manual toggle permanently afterwards.
function ThoughtCard({
  streaming,
  children,
}: {
  streaming: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (touched) return;
    setOpen(streaming);
  }, [streaming, touched]);

  // Bottom-pinned live preview while streaming.
  useEffect(() => {
    if (streaming && open) {
      const el = boxRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  });

  return (
    <div className="my-2 rounded-xl bg-white/[0.04]">
      <button
        onClick={() => {
          setTouched(true);
          setOpen((o) => !o);
        }}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
      >
        <Brain
          className={`size-3.5 shrink-0 ${streaming ? "animate-pulse text-dim" : "text-faint"}`}
        />
        <span className="text-xs font-medium text-dim">
          {streaming ? t("chat.thinking") : t("chat.thought")}
        </span>
        <ChevronDown
          className={`ml-auto size-3.5 shrink-0 text-faint transition-transform duration-200 ${
            open ? "" : "-rotate-90"
          }`}
        />
      </button>
      {open && (
        <div
          ref={boxRef}
          className="max-h-52 overflow-y-auto px-3 pb-2.5 text-[13px] leading-relaxed text-faint"
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Harness task lifecycle notices arrive as user-role XML blocks; they are
// system plumbing, not user speech — rendered as a centered system chip.
const TASK_NOTIFICATION = /^<task-notification>[\s\S]*<\/task-notification>$/;

function parseTaskNotification(
  text: string,
): { status: string; summary: string } | null {
  const t = text.trim();
  if (!TASK_NOTIFICATION.test(t)) return null;
  const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(t)?.[1] ?? "";
  const summary = /<summary>\s*([^<]*?)\s*<\/summary>/.exec(t)?.[1] ?? "";
  return { status, summary };
}

// memo: during replay every store write re-renders the list; unchanged
// messages skip re-parsing their markdown. Store-driven updates (streaming
// into the last message) still propagate via MessagePrimitive's own
// subscriptions.
const UserMessage = memo(function UserMessage({
  collapsed,
  notice,
}: {
  collapsed?: boolean;
  notice?: { status: string; summary: string };
}) {
  const { t } = useTranslation();
  const notify = useAppStore((s) => s.notify);

  // Long-press copy: the bubble is plain text, so the rendered text is the
  // source (assistant-side copying uses ActionBarPrimitive on markdown source).
  const copyFrom = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const text = e.currentTarget.innerText.trim();
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => notify(t("chat.copied")))
      .catch(() => notify(t("chat.copyFailed")));
  };
  if (notice) {
    return (
      <MessagePrimitive.Root className="flex min-w-0 justify-center">
        <div className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-[11px] text-faint">
          <Bell className="size-3 shrink-0" />
          <span className="truncate">
            {notice.summary || t("chat.taskNotice")}
          </span>
          {notice.status && (
            <span className="shrink-0 uppercase tracking-wide">
              · {notice.status}
            </span>
          )}
        </div>
      </MessagePrimitive.Root>
    );
  }
  if (collapsed) {
    // Replay-only flag: harness-injected context handoffs render as a
    // one-line summary behind an expand control, not a wall of user text.
    return (
      <MessagePrimitive.Root className="flex min-w-0 justify-end">
        <details className="group max-w-[85%] min-w-0 rounded-[22px] rounded-br-md bg-raised px-4 py-2.5 text-[13px] text-dim">
          <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-xs text-faint [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
            {t("chat.contextHandoff")}
          </summary>
          <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed">
            <MessagePrimitive.Parts>
              {({ part }) => (part.type === "text" ? <>{part.text}</> : null)}
            </MessagePrimitive.Parts>
          </div>
        </details>
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root className="flex min-w-0 justify-end">
      <div
        onContextMenu={copyFrom}
        className="max-w-[85%] min-w-0 break-words whitespace-pre-wrap rounded-[22px] rounded-br-md bg-raised px-4 py-2.5 text-[15px] text-ink select-none"
      >
        <MessagePrimitive.Parts>
          {({ part }) => (part.type === "text" ? <>{part.text}</> : null)}
        </MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
});

// Assistant replies render full-width without a bubble — markdown (code,
// lists) reads far better unconfined; only the user side gets a bubble.
// A trailing copy action (library primitive, ADR 0004) copies the message's
// markdown source.
const AssistantMessage = memo(function AssistantMessage() {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root className="min-w-0">
      <div className="w-full text-[15px] leading-relaxed text-ink">
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({ reasoning: ["group-reasoning"] })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-reasoning":
                return (
                  <ThoughtCard streaming={part.status.type === "running"}>
                    {children}
                  </ThoughtCard>
                );
              case "reasoning":
                return part.text ? (
                  <p className="whitespace-pre-wrap">{part.text}</p>
                ) : null;
              case "text":
                return part.text ? <MarkdownText text={part.text} /> : null;
              case "tool-call":
                return <ToolCard part={part} />;
              case "indicator":
                return <Spinner className="my-1 size-4" />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </div>
      <ActionBarPrimitive.Root className="mt-0.5 flex justify-end">
        <ActionBarPrimitive.Copy
          aria-label={t("chat.copy")}
          className="flex size-7 items-center justify-center rounded-full text-faint active:bg-white/[0.06] group"
        >
          <Copy className="size-3 group-data-[copied]:hidden" />
          <Check className="hidden size-3 text-emerald-400 group-data-[copied]:block" />
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
});

// Composer input row + the "/" completion menu. The command list comes from
// the bridge's available_commands_update; the query is the composer's first
// (and so far only) token. Enter/Tab complete, arrows navigate, Escape or a
// space dismisses until the query changes. Keydown is intercepted in the
// CAPTURE phase on the form so it beats ComposerPrimitive.Input's Enter-send.
function Composer() {
  const { t } = useTranslation();
  const commands = useAppStore((s) => s.availableCommands);
  const isRunning = useAppStore((s) => s.isRunning);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const { value, setText } = unstable_useComposerInput();
  const [highlight, setHighlight] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const token = value.split(/\s/, 1)[0] ?? "";
  const matches = useMemo(() => {
    if (!token.startsWith("/")) return [];
    const q = token.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [token, commands]);

  // Still typing the command token (no space yet) and not dismissed.
  const open =
    matches.length > 0 && !/\s/.test(value) && dismissedToken !== token;
  const idx = Math.min(highlight, matches.length - 1);

  useEffect(() => {
    setHighlight(0);
  }, [token]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${idx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [idx, open]);

  const select = useCallback(
    (name: string) => {
      setText(`/${name} ` + value.slice(token.length).trimStart());
      setDismissedToken(`/${name}`);
    },
    [setText, value, token],
  );

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!open || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      select(matches[idx].name);
    } else if (e.key === "Escape") {
      setDismissedToken(token);
    }
  };

  return (
    <ThreadPrimitive.ViewportFooter className="sticky bottom-0 bg-canvas pb-[max(var(--safe-bottom),0.5rem)] pt-2">
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="mb-2 max-h-56 overflow-y-auto rounded-2xl bg-surface py-1 shadow-2xl ring-1 ring-hairline"
        >
          {matches.map((c, i) => (
            <button
              key={c.name}
              data-idx={i}
              role="option"
              aria-selected={i === idx}
              // Keep the software keyboard open: focus stays in the textarea.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => select(c.name)}
              className={`flex w-full items-baseline gap-2 px-3 py-2 text-left ${
                i === idx ? "bg-white/[0.06]" : "active:bg-white/[0.06]"
              }`}
            >
              <span className="shrink-0 font-mono text-sm text-dim">
                /{c.name}
              </span>
              <span className="min-w-0 truncate text-xs text-faint">
                {c.description}
                {c.input?.hint ? ` — ${c.input.hint}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      <ComposerPrimitive.Root
        onKeyDownCapture={onKeyDownCapture}
        className="flex items-end gap-1.5 rounded-[26px] bg-raised p-1.5 pl-4 ring-1 ring-inset ring-hairline"
      >
        <ComposerPrimitive.Input
          rows={1}
          placeholder={t("chat.inputPlaceholder")}
          className="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-2 text-[15px] text-ink placeholder:text-faint focus:outline-none"
        />
        {/* While a turn runs the Send stays a Send: a draft queues as pending
            (sendPrompt routes it), never a dead button. Cancel stops the turn.
            Plain button on purpose — ComposerPrimitive.Send disables itself
            while the thread runs. */}
        {isRunning && (
          <ComposerPrimitive.Cancel
            aria-label={t("common.cancel")}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-transform active:scale-90"
          >
            <Square className="size-3 fill-current" />
          </ComposerPrimitive.Cancel>
        )}
        {(!isRunning || value.trim().length > 0) && (
          <button
            onClick={() => {
              const text = value.trim();
              if (!text) return;
              setText("");
              void sendPrompt(text);
            }}
            disabled={!value.trim()}
            aria-label={t("chat.send")}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition disabled:opacity-25 active:scale-90"
          >
            <ArrowUp className="size-4.5" strokeWidth={2.5} />
          </button>
        )}
      </ComposerPrimitive.Root>
    </ThreadPrimitive.ViewportFooter>
  );
}

// Queued follow-ups while a turn runs or a replay is still loading: dimmed
// user bubbles that go out by themselves when the turn settles / the session
// attaches — or right away via force-send (which interrupts the current turn).
function PendingPrompts() {
  const { t } = useTranslation();
  const pendingPrompts = useAppStore((s) => s.pendingPrompts);
  const forceSendPending = useAppStore((s) => s.forceSendPending);
  const discardPending = useAppStore((s) => s.discardPending);
  const loadingSession = useAppStore((s) => s.loadingSession);
  const lastRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    lastRef.current?.scrollIntoView({ block: "end" });
  }, [pendingPrompts.length]);

  if (pendingPrompts.length === 0) return null;
  return (
    <>
      {pendingPrompts.map((text, i) => (
        <div
          key={i}
          ref={i === pendingPrompts.length - 1 ? lastRef : undefined}
          className="flex min-w-0 justify-end opacity-60"
        >
          <div className="flex max-w-[85%] min-w-0 flex-col break-words whitespace-pre-wrap rounded-[22px] rounded-br-md bg-raised px-4 py-2.5 text-[15px] text-ink">
            <span>{text}</span>
            <span className="mt-1 flex items-center justify-end gap-3 text-[11px]">
              <span className="text-faint">{t("chat.pending")}</span>
              {/* No force-send while replaying: there is no turn to interrupt
                  and the queue fires on its own once the attach lands. */}
              {!loadingSession && (
                <button
                  onClick={forceSendPending}
                  className="flex items-center gap-1 font-medium text-dim active:text-ink"
                >
                  <Zap className="size-3" />
                  {t("chat.sendNow")}
                </button>
              )}
              <button
                onClick={() => discardPending(i)}
                aria-label={t("chat.discard")}
                className="flex size-4 items-center justify-center text-faint"
              >
                <X className="size-3" />
              </button>
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

function Thread({
  viewportRef,
  onScroll,
  hasMore,
  remaining,
  loadingEarlier,
  onExpand,
  collapsedIds,
  taskNotices,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  hasMore: boolean;
  remaining: number | null;
  loadingEarlier: boolean;
  onExpand: () => void;
  collapsedIds: ReadonlySet<string>;
  taskNotices: ReadonlyMap<string, { status: string; summary: string }>;
}) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const loadingSession = useAppStore((s) => s.loadingSession);
  const messages = useAppStore((s) => s.messages);

  // Stick-to-bottom and the isAtBottom signal come from the library hook
  // (ADR 0004); only the load-earlier anchoring stays hand-rolled below.
  const autoScrollRef = useThreadViewportAutoScroll({ autoScroll: true });
  const isAtBottom = useThreadViewport((s) => s.isAtBottom);

  // Unread count: messages appended while the viewport is away from the
  // bottom. Prepended history pages are not unread content.
  const [unread, setUnread] = useState(0);
  const lastLenRef = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length - lastLenRef.current;
    lastLenRef.current = messages.length;
    if (isAtBottom) {
      setUnread(0);
      return;
    }
    if (grew > 0 && !loadingEarlier) setUnread((u) => u + grew);
  }, [messages, isAtBottom, loadingEarlier]);

  const composeRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      autoScrollRef(el);
    },
    [viewportRef, autoScrollRef],
  );

  return (
    <ThreadPrimitive.Root className="relative flex h-full flex-col">
      <ThreadPrimitive.Viewport
        ref={composeRef}
        onScroll={onScroll}
        className="flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-3.5 py-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className="mt-[22vh] flex flex-col items-center gap-3 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              ZCode
            </h1>
            <p className="max-w-64 text-sm text-faint">
              {loadingSession
                ? t("chat.loadingSession")
                : activeSessionId
                  ? t("chat.empty")
                  : t("chat.noSession")}
            </p>
            {loadingSession && <Spinner className="size-5" />}
          </div>
        </AuiIf>
        {hasMore && (
          <button
            onClick={onExpand}
            disabled={loadingEarlier}
            className="mx-auto shrink-0 rounded-full bg-surface px-3 py-1 text-xs text-dim ring-1 ring-hairline active:bg-white/[0.06] disabled:opacity-50"
          >
            {loadingEarlier
              ? t("chat.loadingEarlier")
              : remaining != null
                ? t("chat.loadEarlier", { n: remaining })
                : t("chat.loadEarlierGeneric")}
          </button>
        )}
        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? (
              <UserMessage
                key={message.id}
                collapsed={collapsedIds.has(message.id)}
                notice={taskNotices.get(message.id)}
              />
            ) : (
              <AssistantMessage key={message.id} />
            )
          }
        </ThreadPrimitive.Messages>
        <PendingPrompts />
        <Composer />
      </ThreadPrimitive.Viewport>
      {!isAtBottom && messages.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-end px-4">
          <div className="pointer-events-auto relative">
            <ThreadPrimitive.ScrollToBottom
              aria-label={t("chat.jumpToLatest")}
              className="flex size-9 items-center justify-center rounded-full bg-raised text-dim shadow-lg ring-1 ring-hairline transition-transform active:scale-90"
            >
              <ArrowDown className="size-4" />
            </ThreadPrimitive.ScrollToBottom>
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 flex size-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </div>
        </div>
      )}
    </ThreadPrimitive.Root>
  );
}

export function ChatView() {
  const messages = useAppStore((s) => s.messages);
  const isRunning = useAppStore((s) => s.isRunning);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const cancelTurn = useAppStore((s) => s.cancelTurn);
  const hasMore = useAppStore((s) => s.hasMore);
  const totalMessages = useAppStore((s) => s.totalMessages);
  const loadingEarlier = useAppStore((s) => s.loadingEarlier);
  const loadEarlier = useAppStore((s) => s.loadEarlier);

  const remaining =
    totalMessages != null ? Math.max(0, totalMessages - messages.length) : null;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const expandingRef = useRef(false);

  // Older history arrives as PREPENDED pages (session/load_earlier). Anchor
  // the viewport: sample until the content height actually grew (network +
  // assistant-ui's async mount both take frames), then restore the exact
  // visual position. (Live-stream stick-to-bottom is the library hook.)
  const expand = useCallback(() => {
    if (expandingRef.current) return;
    expandingRef.current = true;
    const el = viewportRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevScrollTop = el ? el.scrollTop : 0;
    void loadEarlier().then((applied) => {
      expandingRef.current = false;
      if (!applied || !el) return;
      const deadline = performance.now() + 10000;
      const restore = () => {
        if (el.scrollHeight > prevHeight) {
          el.scrollTop = prevScrollTop + (el.scrollHeight - prevHeight);
          return;
        }
        if (performance.now() < deadline) requestAnimationFrame(restore);
      };
      requestAnimationFrame(restore);
    });
  }, [loadEarlier]);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (el.scrollTop < 60 && el.scrollHeight > el.clientHeight) expand();
  }, [expand]);

  const onNew = useCallback(
    async (message: ThreadMessageLike | string) => {
      await sendPrompt(messageText(message));
    },
    [sendPrompt],
  );
  const onCancel = useCallback(async () => {
    cancelTurn();
  }, [cancelTurn]);

  // Collapsed (context-handoff) message ids, resolved once per store write so
  // the message components keep stable boolean props and stay memoized.
  const collapsedIds = useMemo(
    () => new Set(messages.filter((m) => m.collapsed).map((m) => m.id)),
    [messages],
  );

  // Task-notification ids parsed the same way — one pass per store write,
  // stable object identity keeps UserMessage memoization intact.
  const taskNotices = useMemo(() => {
    const map = new Map<string, { status: string; summary: string }>();
    for (const m of messages) {
      if (m.role !== "user") continue;
      const text = m.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      const notice = parseTaskNotification(text);
      if (notice) map.set(m.id, notice);
    }
    return map;
  }, [messages]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    onNew,
    onCancel,
    isRunning,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        viewportRef={viewportRef}
        onScroll={onScroll}
        hasMore={hasMore}
        remaining={remaining}
        loadingEarlier={loadingEarlier}
        onExpand={expand}
        collapsedIds={collapsedIds}
        taskNotices={taskNotices}
      />
    </AssistantRuntimeProvider>
  );
}
