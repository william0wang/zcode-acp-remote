/**
 * Parse the optional workflow start-args textarea; "" = no args.
 * Shared by the config workflows page and the in-chat start sheet.
 */
export function parseArgsInput(text: string): {
  args?: Record<string, unknown>;
  error?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: "args must be a JSON object" };
    }
    return { args: value as Record<string, unknown> };
  } catch {
    return { error: "invalid JSON" };
  }
}

/**
 * Extract the declared-args map from a workflow's meta (upstream
 * `zcodeSavedWorkflowArgsDeclarationSchema`). Null when the workflow declares
 * no args — the launcher then falls back to the free-form JSON textarea.
 */
export function argsDeclaration(
  meta: Record<string, unknown> | null | undefined,
): Record<
  string,
  { type?: string; description?: string; required?: boolean; default?: unknown }
> | null {
  const raw = meta?.["args"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const out: Record<
    string,
    {
      type?: string;
      description?: string;
      required?: boolean;
      default?: unknown;
    }
  > = {};
  let any = false;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "object" || v === null) continue;
    out[k] = v as {
      type?: string;
      description?: string;
      required?: boolean;
      default?: unknown;
    };
    any = true;
  }
  return any ? out : null;
}
