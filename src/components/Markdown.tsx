import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// Shared by chat messages and the file viewer's markdown preview.
// memo: markdown + highlight parsing is the most expensive render in the app;
// identical text must never re-parse (belt-and-suspenders on top of the
// convertMessage identity cache in ChatView).
export const MarkdownText = memo(function MarkdownText({
  text,
}: {
  text: string;
}) {
  return (
    <div className="prose prose-sm prose-invert max-w-none prose-pre:rounded-xl prose-pre:bg-canvas prose-pre:ring-1 prose-pre:ring-hairline">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </Markdown>
    </div>
  );
});
