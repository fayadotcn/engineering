// In-memory confirmation gates. A run pauses on a confirm-flagged tool;
// POST /api/runs/[id]/confirm resolves it. Persisted pendingAction on the
// AgentRun row lets the UI rebuild the confirm card after reload, but the
// resolver itself lives only while the server process does.

interface Pending {
  resolve: (approved: boolean) => void;
  tool: string;
  description: string;
  timer: NodeJS.Timeout;
}

// Next 每个 route 是独立 module graph —— 必须挂 globalThis 才能跨请求共享。
const g = globalThis as unknown as { __pendingConfirms?: Map<string, Pending> };
const pending = (g.__pendingConfirms ??= new Map<string, Pending>());

const TIMEOUT_MS = 10 * 60 * 1000;

export function waitForConfirm(
  runId: string,
  tool: string,
  description: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(runId)) resolve(false); // 超时按取消处理
    }, TIMEOUT_MS);
    pending.set(runId, { resolve, tool, description, timer });
  });
}

/** Returns false if no live resolver (e.g. server restarted mid-confirm). */
export function resolveConfirm(runId: string, approved: boolean): boolean {
  const p = pending.get(runId);
  if (!p) return false;
  pending.delete(runId);
  clearTimeout(p.timer);
  p.resolve(approved);
  return true;
}
