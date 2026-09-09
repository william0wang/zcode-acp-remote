import { lazy, Suspense, useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { ConnectScreen } from "./screens/ConnectScreen";
import { InstancePicker } from "./screens/InstancePicker";
import { Spinner } from "./components/Spinner";

// ChatScreen carries the chat engine + diff/lightbox/highlight stack (~63%
// of the bundle); the connect/picker screens only pay for it once a session
// actually opens. In the APK the chunk loads from local disk, on the web
// deployment this cuts first paint from ~406 KB to ~150 KB gzipped.
const ChatScreen = lazy(() =>
  import("./screens/ChatScreen").then((m) => ({ default: m.ChatScreen })),
);

export default function App() {
  const init = useAppStore((s) => s.init);
  const profile = useAppStore((s) => s.profile);
  const instanceId = useAppStore((s) => s.instanceId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);

  useEffect(() => {
    init();
  }, [init]);

  if (!profile) return <ConnectScreen />;
  // The instance connection outlives the open session (closeSession keeps
  // it so the list keeps receiving broadcast activity) — the chat screen
  // needs BOTH an instance and an attached session.
  if (!instanceId || !activeSessionId) return <InstancePicker />;
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-canvas">
          <Spinner className="size-6" />
        </div>
      }
    >
      <ChatScreen />
    </Suspense>
  );
}
