export function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
