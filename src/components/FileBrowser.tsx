import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Link2,
  RefreshCw,
} from "lucide-react";
import type { FsEntry, FsListing } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { FileViewer, fmtSize } from "./FileViewer";
import { Spinner } from "./Spinner";

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function EntryIcon({ kind }: { kind: FsEntry["kind"] }) {
  if (kind === "dir")
    return <Folder className="size-4.5 shrink-0 text-blue-400" />;
  if (kind === "symlink")
    return <Link2 className="size-4.5 shrink-0 text-faint" />;
  return <FileText className="size-4.5 shrink-0 text-faint" />;
}

interface FileBrowserProps {
  onClose: () => void;
}

export function FileBrowser({ onClose }: FileBrowserProps) {
  const { t } = useTranslation();
  const fsList = useAppStore((s) => s.fsList);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [viewing, setViewing] = useState<{
    entry: FsEntry;
    path: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    // Drop the previous directory while loading: stale rows stay clickable
    // otherwise and would join against the NEW path on tap.
    setListing(null);
    fsList(path).then((res) => {
      if (!alive) return;
      setLoading(false);
      if (!res) {
        setFailed(true);
        return;
      }
      setListing(res);
    });
    return () => {
      alive = false;
    };
  }, [path, attempt, fsList]);

  // A new directory must start at the top, not wherever the last one scrolled.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [path, attempt]);

  const entries = (listing?.entries ?? []).filter(
    (e) => showHidden || !e.name.startsWith("."),
  );

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 8,
  });

  const segments = path ? path.split("/") : [];
  const rootName = listing?.root
    ? listing.root.replace(/\/+$/, "").split("/").pop() || "/"
    : t("files.root");

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink">
      <header className="flex items-center gap-1 border-b border-hairline px-1.5 pb-2 pt-[max(var(--safe-top),0.5rem)]">
        <button
          onClick={
            segments.length
              ? () => setPath(segments.slice(0, -1).join("/"))
              : onClose
          }
          aria-label={t("files.back")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <ArrowLeft className="size-5" />
        </button>
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[13px] text-dim">
          <button
            onClick={() => setPath("")}
            className="shrink-0 truncate text-ink active:text-blue-400"
          >
            {rootName}
          </button>
          {segments.map((seg, i) => (
            <span key={i} className="flex shrink-0 items-center gap-0.5">
              <span className="text-faint">/</span>
              <button
                onClick={() => setPath(segments.slice(0, i + 1).join("/"))}
                className={
                  i === segments.length - 1
                    ? "truncate text-ink"
                    : "truncate active:text-blue-400"
                }
              >
                {seg}
              </button>
            </span>
          ))}
        </nav>
        <button
          onClick={() => setShowHidden((v) => !v)}
          aria-label={t("files.showHidden")}
          className={`flex size-9 shrink-0 items-center justify-center rounded-full active:bg-white/[0.06] ${
            showHidden ? "text-blue-400" : "text-dim"
          }`}
        >
          {showHidden ? (
            <Eye className="size-4.5" />
          ) : (
            <EyeOff className="size-4.5" />
          )}
        </button>
        <button
          onClick={() => setAttempt((n) => n + 1)}
          aria-label={t("files.retry")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <RefreshCw className="size-4.5" />
        </button>
      </header>

      {listing?.truncated && (
        <div className="bg-amber-950 px-4 py-1 text-center text-[11px] text-amber-300">
          {t("files.truncated")}
        </div>
      )}

      {loading && !listing ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-7" />
        </div>
      ) : failed && !listing ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-sm text-dim">
          <span>{t("files.loadError")}</span>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="text-xs text-blue-400 active:text-blue-300"
          >
            {t("files.retry")}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-faint">
          {t("files.empty")}
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const entry = entries[item.index];
              return (
                <button
                  key={item.key}
                  onClick={() =>
                    entry.kind === "dir"
                      ? setPath(joinPath(path, entry.name))
                      : setViewing({ entry, path: joinPath(path, entry.name) })
                  }
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                  className="flex items-center gap-2.5 border-b border-hairline px-4 text-left active:bg-white/[0.04]"
                >
                  <EntryIcon kind={entry.kind} />
                  <span className="min-w-0 flex-1 truncate text-[14px]">
                    {entry.name}
                  </span>
                  {entry.kind === "file" && (
                    <span className="shrink-0 text-[11px] text-faint">
                      {fmtSize(entry.size)}
                    </span>
                  )}
                  {entry.kind === "dir" && (
                    <ChevronRight className="size-4 shrink-0 text-faint" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {viewing && (
        <FileViewer
          file={viewing.entry}
          path={viewing.path}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
