// Session configOption values spell a model two ways: the bridge's
// `providerId\modelId` (backslash) and the agent-definition
// `custom:<encoded provider>:<model>`. A current value that missed the option
// list must still read as a name — dumping the raw pair is how the same model
// came to display as a full id string in one place and a name in another.

/** The bare model id out of a configOption value, whichever spelling it uses. */
export function bareModelIdFromConfigValue(value: string): string {
  const custom = /^custom:([^:]+):(.+)$/.exec(value);
  if (custom) {
    try {
      return decodeURIComponent(custom[2]!);
    } catch {
      return custom[2]!;
    }
  }
  const idx = value.lastIndexOf("\\");
  return idx >= 0 ? value.slice(idx + 1) : value;
}
