import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
// core + registered subset instead of lib/common: the full common set adds
// ~200 KB minified to the APK for languages this viewer never renders.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { ArrowLeft, FileText, Link2, Share2, X } from "lucide-react";
import type { FsEntry } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { Spinner } from "./Spinner";

for (const lang of [
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  markdown,
  perl,
  php,
  python,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
]) {
  hljs.registerLanguage(lang.name, lang);
}

// Extensions the registered languages don't claim as aliases, mapped to the
// closest registered language (verified: without this, hljs.getLanguage()
// misses ~20 of the 60+ text extensions and silently degrades to plaintext).
const EXT_LANGUAGE: Record<string, string> = {
  mdx: "markdown",
  htm: "xml",
  sass: "scss",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  toml: "ini",
  zsh: "bash",
};

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

const TEXT_EXT = new Set([
  "txt",
  "md",
  "mdx",
  "markdown",
  "json",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "env",
  "log",
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cs",
  "php",
  "sql",
  "r",
  "pl",
  "lua",
  "dart",
  "scala",
  "proto",
  "graphql",
  "gql",
  "lock",
  "diff",
  "patch",
  "gitignore",
  "gitattributes",
  "npmrc",
  "editorconfig",
]);

// Extension-less files that are known text (compared lowercased).
const TEXT_NAMES = new Set([
  "dockerfile",
  "makefile",
  "rakefile",
  "license",
  "readme",
  "changelog",
  "notice",
]);

export function fileKindOf(name: string): "image" | "text" | "binary" {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (ext && IMAGE_EXT.has(ext)) return "image";
  if (ext && TEXT_EXT.has(ext)) return "text";
  if (!ext && TEXT_NAMES.has(lower)) return "text";
  return "binary";
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FIRST_WINDOW = 200;
const NEXT_WINDOW = 500;
const MAX_LINES = 10000;
// Text files past this size exceed the viewer's MAX_LINES budget (10k lines
// is ~300-500 KB of typical source) and highlighting the growing buffer janks
// the WebView — they get the download card instead.
const LARGE_TEXT_BYTES = 512 * 1024;

interface TextViewerProps {
  path: string;
}

function TextViewer({ path }: TextViewerProps) {
  const { t } = useTranslation();
  const fsFileText = useAppStore((s) => s.fsFileText);
  const [firstLine, setFirstLine] = useState(1);
  const [text, setText] = useState("");
  const [eof, setEof] = useState(false);
  // eof via the MAX_LINES cap is not the real end of file — the footer must
  // not claim "end of file" when the viewer simply refused to load more.
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    fsFileText(path, 1, FIRST_WINDOW).then((res) => {
      if (!alive) return;
      setLoading(false);
      if (!res) {
        setFailed(true);
        return;
      }
      setFirstLine(res.firstLine);
      setText(res.text);
      // An empty or short window shorter than requested means EOF.
      if (!res.text || res.text.split("\n").length < FIRST_WINDOW) setEof(true);
    });
    return () => {
      alive = false;
    };
  }, [path, attempt, fsFileText]);

  const lines = text ? text.split("\n") : [];

  const loadMore = () => {
    if (loading || eof) return;
    setLoading(true);
    const from = firstLine + lines.length;
    fsFileText(path, from, NEXT_WINDOW).then((res) => {
      setLoading(false);
      if (!res) {
        setFailed(true);
        return;
      }
      setText((cur) => (cur ? `${cur}\n${res.text}` : res.text));
      if (!res.text || res.text.split("\n").length < NEXT_WINDOW) setEof(true);
      else if (
        firstLine + lines.length + res.text.split("\n").length >=
        MAX_LINES
      ) {
        setEof(true);
        setCapped(true);
      }
    });
  };

  const name = path.split("/").pop() ?? path;
  const ext = name.toLowerCase().includes(".")
    ? name.toLowerCase().split(".").pop()!
    : "";
  const language =
    (ext && EXT_LANGUAGE[ext]) ||
    (ext && hljs.getLanguage(ext) ? ext : "") ||
    "plaintext";
  // Memoized: re-highlighting the whole (growing) buffer on every render
  // janks the UI each "Load more".
  const html = useMemo(() => {
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return hljs.highlight(text, { language: "plaintext" }).value;
    }
  }, [text, language]);

  if (loading && !text) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-7" />
      </div>
    );
  }
  if (failed && !text) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-sm text-dim">
        <span>{t("files.loadError")}</span>
        <button
          onClick={() => setAttempt((n) => n + 1)}
          className="text-xs text-blue-400 active:text-blue-300"
        >
          {t("files.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-w-max text-[12px] leading-5">
          <div className="sticky left-0 shrink-0 select-none border-r border-hairline bg-surface px-2 py-2 text-right text-faint">
            {lines.map((_, i) => (
              <div key={i}>{firstLine + i}</div>
            ))}
          </div>
          <pre className="px-3 py-2 font-mono text-ink">
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-2 text-[11px] text-faint">
        <span>
          {t("viewer.lines", { count: firstLine + lines.length - 1 })}
        </span>
        {eof ? (
          <span>{capped ? t("viewer.lineCap") : t("viewer.loadedAll")}</span>
        ) : loading ? (
          <Spinner className="size-4" />
        ) : (
          <button
            onClick={loadMore}
            className="rounded-full bg-white/[0.06] px-3 py-1 text-dim active:bg-white/[0.1]"
          >
            {t("viewer.loadMore")}
          </button>
        )}
      </div>
    </div>
  );
}

interface FileViewerProps {
  file: FsEntry;
  path: string;
  onClose: () => void;
  /** Exit the whole file browser back to the session — the back arrow only
   * returns to the browser at the same directory depth. */
  onExit?: () => void;
}

export function FileViewer({ file, path, onClose, onExit }: FileViewerProps) {
  const { t } = useTranslation();
  const fsFileUrl = useAppStore((s) => s.fsFileUrl);
  const notify = useAppStore((s) => s.notify);
  const [sharing, setSharing] = useState(false);
  // Unknown kinds AND oversized text files can be forced into the text
  // viewer — binary content shows as garbage, which the user can see and
  // back out of.
  const [forcedText, setForcedText] = useState(false);
  const baseKind = fileKindOf(file.name);
  const kind: "image" | "text" | "binary" = forcedText
    ? "text"
    : baseKind === "text" && file.size > LARGE_TEXT_BYTES
      ? "binary"
      : baseKind;
  const url = fsFileUrl(path);

  // wry's Android WebView registers no DownloadListener (verified in
  // wry 0.55.1 source), so `<a download>` is silently ignored there. Web
  // Share with the fetched file works everywhere the API exists; copying
  // the URL is the universal fallback.
  const canShareFiles =
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";

  const shareFile = async () => {
    if (!url || sharing) return;
    setSharing(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const f = new File([blob], file.name, { type: blob.type });
      if (!navigator.canShare({ files: [f] })) throw new Error("cannot share");
      await navigator.share({ files: [f], title: file.name });
    } catch (e) {
      // Dismissing the system share sheet throws AbortError — not a failure.
      if ((e as DOMException)?.name !== "AbortError")
        notify(t("viewer.shareFailed"));
    } finally {
      setSharing(false);
    }
  };

  const copyLink = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify(t("viewer.linkCopied"));
    } catch {
      notify(t("viewer.shareFailed"));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink">
      <header className="flex items-center gap-2 border-b border-hairline px-1.5 pb-2 pt-[max(var(--safe-top),0.5rem)]">
        <button
          onClick={onClose}
          aria-label={t("files.back")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium">{file.name}</div>
          <div className="text-[11px] text-faint">{fmtSize(file.size)}</div>
        </div>
        {onExit && (
          <button
            onClick={onExit}
            aria-label={t("files.close")}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
          >
            <X className="size-5" />
          </button>
        )}
      </header>

      {kind === "image" && url && (
        <Lightbox
          open
          close={onClose}
          plugins={[Zoom]}
          slides={[{ src: url }]}
          zoom={{ maxZoomPixelRatio: 5 }}
        />
      )}

      {kind === "text" && <TextViewer path={path} />}

      {kind === "binary" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <FileText className="size-10 text-faint" />
          <div className="text-sm text-dim">
            {file.name} · {fmtSize(file.size)}
          </div>
          {baseKind === "text" && (
            <div className="text-xs text-faint">{t("viewer.tooLarge")}</div>
          )}
          {url && (
            <div className="flex items-center gap-2">
              {canShareFiles && (
                <button
                  onClick={shareFile}
                  disabled={sharing}
                  className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-4 py-2 text-sm text-dim active:bg-white/[0.1] disabled:opacity-50"
                >
                  {sharing ? (
                    <Spinner className="size-4" />
                  ) : (
                    <Share2 className="size-4" />
                  )}
                  {t("viewer.share")}
                </button>
              )}
              <button
                onClick={copyLink}
                className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-4 py-2 text-sm text-dim active:bg-white/[0.1]"
              >
                <Link2 className="size-4" />
                {t("viewer.copyLink")}
              </button>
            </div>
          )}
          <button
            onClick={() => setForcedText(true)}
            className="text-xs text-blue-400 active:text-blue-300"
          >
            {t("viewer.openAsText")}
          </button>
        </div>
      )}
    </div>
  );
}
