import { memo, useCallback, useRef } from "react";
import {
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useTranslation } from "react-i18next";
import "highlight.js/styles/github-dark.css";
import { useAppStore } from "../store/appStore";
import type { ChatMessage } from "../lib/types";

// ACP chat model -> assistant-ui message model (the ACP runtime adapter).

const convertMessage = (m: ChatMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  createdAt: new Date(m.createdAt),
  content: m.parts.map((p) => {
    if (p.type === "text") return { type: "text" as const, text: p.text };
    // Thought streams render as markdown blockquotes (dim, visually set off).
    if (p.type === "thought") {
      return {
        type: "text" as const,
        text: p.text
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
      };
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
    <div className="prose prose-sm prose-invert prose-pre:border prose-pre:border-zinc-800 prose-pre:bg-zinc-950 max-w-none">
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
    <details className="my-2 max-w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-xs">
      <summary className="flex min-w-0 cursor-pointer list-none px-3 py-2 text-zinc-300">
        <span className="shrink-0 font-medium">{part.toolName}</span>
        {detail && <span className="ml-2 truncate text-zinc-500">{detail.slice(0, 72)}</span>}
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-zinc-800 px-3 py-2 text-zinc-400">
        {detail || "…"}
      </pre>
    </details>
  );
}

// memo: during replay every store write re-renders the list; unchanged
// messages skip re-parsing their markdown. Store-driven updates (streaming
// into the last message) still propagate via MessagePrimitive's own
// subscriptions.
const UserMessage = memo(function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex min-w-0 justify-end">
      <div className="max-w-[88%] min-w-0 break-words whitespace-pre-wrap rounded-2xl bg-blue-600 px-4 py-2.5 text-sm text-white">
        <MessagePrimitive.Parts>
          {({ part }) => (part.type === "text" ? <>{part.text}</> : null)}
        </MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
});

const AssistantMessage = memo(function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex min-w-0 justify-start">
      <div className="max-w-[88%] min-w-0 overflow-hidden rounded-2xl bg-zinc-900 px-4 py-3 text-sm leading-relaxed text-zinc-100">
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text") {
              if (!part.text) return null;
              return <MarkdownText text={part.text} />;
            }
            if (part.type === "tool-call") return <ToolCard part={part} />;
            return null;
          }}
        </MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
});

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
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        onScroll={onScroll}
        className="flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-3 py-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className="mt-24 text-center text-sm text-zinc-500">
            {activeSessionId ? t("chat.empty") : t("chat.noSession")}
          </div>
        </AuiIf>
        {hasMore && (
          <button
            onClick={onExpand}
            disabled={loadingEarlier}
            className="mx-auto shrink-0 rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400 active:bg-zinc-800 disabled:opacity-50"
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
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2">
          <ComposerPrimitive.Root className="flex items-end gap-2 rounded-3xl border border-zinc-700 bg-zinc-900 px-3 py-2">
            <ComposerPrimitive.Input
              rows={1}
              placeholder={t("chat.inputPlaceholder")}
              className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel
                aria-label={t("common.cancel")}
                className="flex size-9 items-center justify-center rounded-full bg-zinc-700 text-sm text-zinc-200"
              >
                ■
              </ComposerPrimitive.Cancel>
            </AuiIf>
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send
                className="flex size-9 items-center justify-center rounded-full bg-blue-600 text-sm text-white disabled:opacity-30"
              >
                ↑
              </ComposerPrimitive.Send>
            </AuiIf>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
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
