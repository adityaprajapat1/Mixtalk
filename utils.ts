export function cn(...inputs: (string | undefined | null | false)[]) {
  return inputs.filter(Boolean).join(" ");
}

export function generateSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "sess_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function shortId(id: string, length = 8): string {
  return id.replace(/-/g, "").slice(0, length).toUpperCase();
}
