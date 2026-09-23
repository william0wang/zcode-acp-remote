import { useEffect, useRef } from "react";

// Android back-gesture routing. The app has no router — screens and overlays
// are React/store state — so the OS back press (forwarded by Tauri's
// onBackButtonPress, registered in App.tsx) walks a LIFO stack of handlers:
// the component that mounted last answers first, which matches how overlays
// stack visually. A handler returns true when it consumed the press (closed
// its overlay, went up one level); false lets the next handler decide, and an
// empty stack falls through to the root double-back-to-exit in App.tsx.

export type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

export function addBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** True when some handler consumed the back press. */
export function dispatchBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]!()) return true;
  }
  return false;
}

// The hook keeps the registration for the component's whole lifetime (mount
// order is what matters) while the callback stays fresh per render.
export function useBackHandler(handler: BackHandler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => addBackHandler(() => ref.current()), []);
}
