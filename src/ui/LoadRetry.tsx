"use client";
import { useEffect, useState } from "react";

/**
 * 路由级加载兜底：流式渲染在弱网/服务重启时可能截断，
 * 页面会一直停在加载占位。超过 18s 还没渲染出内容，
 * 给出人工重试入口，避免无声卡死。
 */
export function LoadRetry() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 18000);
    return () => clearTimeout(t);
  }, []);
  if (!slow) return null;
  return (
    <p className="cost-empty-hint">
      等待时间有点长，可能是网络波动。
      <button className="cost-btn" onClick={() => location.reload()}>重新加载</button>
    </p>
  );
}
