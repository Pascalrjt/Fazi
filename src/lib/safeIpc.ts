/**
 * Channel-based IPC wrappers construct a Tauri `Channel` synchronously, which
 * THROWS (rather than rejecting) when the app runs without a Tauri backend
 * (plain `npm run dev`). This shim converts sync throws into rejections so
 * every call site can rely on `.catch()`.
 */
export function safeIpc<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
