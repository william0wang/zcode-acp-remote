import { useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { ConnectScreen } from "./screens/ConnectScreen";
import { InstancePicker } from "./screens/InstancePicker";
import { ChatScreen } from "./screens/ChatScreen";

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
  return <ChatScreen />;
}
