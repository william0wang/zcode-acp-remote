// @vitest-environment node
// The session panel's current-model fallback: a value that missed the option
// list must still read as a model NAME, not the raw `provider\model` or
// `custom:…` spelling it arrived as. Same logic as the config screens' labels
// (bare id unless qualified), expressed against the two wire spellings.
import { describe, expect, it } from "vitest";
import { bareModelIdFromConfigValue } from "../src/lib/modelValue";

describe("bareModelIdFromConfigValue", () => {
  it("strips the provider from the bridge's backslash spelling", () => {
    expect(
      bareModelIdFromConfigValue("builtin:bigmodel-coding-plan\\GLM-5.3"),
    ).toBe("GLM-5.3");
    expect(bareModelIdFromConfigValue("uuid-1\\deepseek-v4")).toBe(
      "deepseek-v4",
    );
  });

  it("decodes the agent-definition custom: spelling", () => {
    expect(
      bareModelIdFromConfigValue(
        "custom:account%3Abigmodel-individual-coding-plan:GLM-5.3",
      ),
    ).toBe("GLM-5.3");
    // A malformed escape degrades to the raw segment, not a throw.
    expect(bareModelIdFromConfigValue("custom:prov:bad%")).toBe("bad%");
  });

  it("passes a bare value through unchanged", () => {
    // Mode and thought options use bare words; they must not be mangled.
    expect(bareModelIdFromConfigValue("max")).toBe("max");
    expect(bareModelIdFromConfigValue("build")).toBe("build");
  });
});
