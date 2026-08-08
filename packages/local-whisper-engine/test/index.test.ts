import { describe, expect, it } from "vitest";

import { LOCAL_MODEL, inspectLocalCapabilities, prepareModelCache } from "../src/index.js";

describe("local-whisper-engine public entrypoint", () => {
  it("exports the manifest, capability inspection, and cache policy", () => {
    expect(LOCAL_MODEL.id).toBe("onnx-community/whisper-small");
    expect(inspectLocalCapabilities).toBeTypeOf("function");
    expect(prepareModelCache).toBeTypeOf("function");
  });
});
