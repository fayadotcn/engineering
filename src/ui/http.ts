/** 保留服务端的业务错误；非 JSON 错误页使用可读的提示。 */
export async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || fallback);
  if (data === null) throw new Error(fallback);
  return data as T;
}
