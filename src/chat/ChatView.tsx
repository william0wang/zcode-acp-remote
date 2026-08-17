import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useExternalStoreRuntime,
  groupPartByType,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ArrowUp, Brain, ChevronDown, Square, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import "highlight.js/styles/github-dark.css";
import { useAppStore } from "../store/appStore";
import { Spinner } from "../components/Spinner";
import type { ChatMessage } from "../lib/types";

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
      args: { detail: p.detail },
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

function ToolCard({
  part,
}: {
  part: { toolName: string; args?: unknown };
}) {
  const detail = (part.args as { detail?: string } | undefined)?.detail ?? "";
  return (
    <details className="my-2 max-w-full overflow-hidden rounded-xl bg-white/[0.04] text-xs">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-dim">
        <Wrench className="size-3.5 shrink-0 text-faint" />
        <span className="shrink-0 font-medium">{part.toolName}</span>
        {detail && <span className="truncate text-faint">{detail.slice(0, 72)}</span>}
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-hairline px-3 py-2 text-faint">
        {detail || "…"}
      </pre>
    </details>
  );
}

// Collapsible reasoning block. `streaming` comes from the group part's
// auto-status: it holds the block open (bottom-pinned on the newest tokens)
// while the model thinks, collapses once the answer starts, and defers to the
// first manual toggle permanently afterwards.
function ThoughtCard({ streaming, children }: { streaming: boolean; children: ReactNode }) {
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
        <Brain className={`size-3.5 shrink-0 ${streaming ? "animate-pulse text-dim" : "text-faint"}`} />
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

// memo: during replay every store write re-renders the list; unchanged
// messages skip re-parsing their markdown. Store-driven updates (streaming
// into the last message) still propagate via MessagePrimitive's own
// subscriptions.
const UserMessage = memo(function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex min-w-0 justify-end">
      <div className="max-w-[85%] min-w-0 break-words whitespace-pre-wrap rounded-[22px] rounded-br-md bg-raised px-4 py-2.5 text-[15px] text-ink">
        <MessagePrimitive.Parts>
          {({ part }) => (part.type === "text" ? <>{part.text}</> : null)}
        </MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
});

// Assistant replies render full-width without a bubble — markdown (code,
// lists) reads far better unconfined; only the user side gets a bubble.
const AssistantMessage = memo(function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="min-w-0">
      <div className="w-full text-[15px] leading-relaxed text-ink">
        <MessagePrimitive.GroupedParts groupBy={groupPartByType({ reasoning: ["group-reasoning"] })}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-reasoning":
                return <ThoughtCard streaming={part.status.type === "running"}>{children}</ThoughtCard>;
              case "reasoning":
                return part.text ? <p className="whitespace-pre-wrap">{part.text}</p> : null;
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
  const open = matches.length > 0 && !/\s/.test(value) && dismissedToken !== token;
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
    <ThreadPrimitive.ViewportFooter className="sticky bottom-0 bg-canvas pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2">
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
              <span className="shrink-0 font-mono text-sm text-dim">/{c.name}</span>
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
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel
            aria-label={t("common.cancel")}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-transform active:scale-90"
          >
            <Square className="size-3 fill-current" />
          </ComposerPrimitive.Cancel>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition disabled:opacity-25 active:scale-90">
            <ArrowUp className="size-4.5" strokeWidth={2.5} />
          </ComposerPrimitive.Send>
        </AuiIf>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.ViewportFooter>
  );
}

function Thread({
  viewportRef,
  onScroll,
  hasMore,
  remaining,
  loadingEarlier,
  onExpand,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  hasMore: boolean;
  remaining: number | null;
  loadingEarlier: boolean;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const loadingSession = useAppStore((s) => s.loadingSession);
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        onScroll={onScroll}
        className="flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-3.5 py-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className="mt-[22vh] flex flex-col items-center gap-3 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">ZCode</h1>
            <p className="max-w-64 text-sm text-faint">
              {loadingSession ? (
                t("chat.loadingSession")
              ) : activeSessionId ? (
                t("chat.empty")
              ) : (
                t("chat.noSession")
              )}
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
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
        <Composer />
      </ThreadPrimitive.Viewport>
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
  // visual position.
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
      />
    </AssistantRuntimeProvider>
  );
}
