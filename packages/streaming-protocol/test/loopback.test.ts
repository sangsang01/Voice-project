import { describe, expect, it } from "vitest";
import { assertLoopbackWebSocketUrl } from "../src/index.js";

describe("assertLoopbackWebSocketUrl", () => {
  it("accepts loopback ws URLs", () => {
    expect(() => assertLoopbackWebSocketUrl("ws://127.0.0.1:8787")).not.toThrow();
    expect(() => assertLoopbackWebSocketUrl("ws://localhost:8787")).not.toThrow();
    expect(() => assertLoopbackWebSocketUrl("ws://[::1]:8787")).not.toThrow();
  });

  it("rejects non-loopback and non-ws URLs", () => {
    expect(() => assertLoopbackWebSocketUrl("ws://192.168.1.8:8787")).toThrow(/loopback/);
    expect(() => assertLoopbackWebSocketUrl("ws://0.0.0.0:8787")).toThrow(/loopback/);
    expect(() => assertLoopbackWebSocketUrl("http://127.0.0.1:8787")).toThrow(/ws/);
  });
});
