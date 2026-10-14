/** Transport handshakes carry no changed data; reconnects already request a snapshot. */
export function isRefreshMessage(data: string): boolean {
  try {
    const event: unknown = JSON.parse(data);
    return typeof event === "object" && event !== null && "type" in event
      && typeof event.type === "string" && event.type !== "hello";
  } catch {
    return false;
  }
}

/** A fixed window coalesces bursts without starving the last update under ongoing traffic. */
export function createRefreshBatch(refresh: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    request() {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 250);
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
