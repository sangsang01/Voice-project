import { describe, expect, it } from "vitest";

import { LOCAL_MODEL, inspectLocalCapabilities } from "../src/index.js";

describe("package entrypoint", () => {
  it("exports the model manifest and the capability probe", () => {
    expect(LOCAL_MODEL.whisper).toBeTypeOf("string");
    expect(inspectLocalCapabilities).toBeTypeOf("function");
  });
});
