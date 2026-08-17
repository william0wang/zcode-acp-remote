import { useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { ConnectScreen } from "./screens/ConnectScreen";
import { InstancePicker } from "./screens/InstancePicker";
import { ChatScreen } from "./screens/ChatScreen";

export default function App() {
  const init = useAppStore((s) => s.init);
  const profile = useAppStore((s) => s.profile);
  const instanceId = useAppStore((s) => s.instanceId);

  useEffect(() => {
    init();
  }, [init]);

  if (!profile) return <ConnectScreen />;
  if (!instanceId) return <InstancePicker />;
  return <ChatScreen />;
}
