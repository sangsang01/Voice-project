import { describe, expect, it } from "vitest";
import { assertLoopbackBindHost, assertLoopbackWebSocketUrl } from "../src/index.js";

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
    expect(() => assertLoopbackWebSocketUrl("wss://127.0.0.1:8787")).toThrow(/ws/);
  });
});

describe("assertLoopbackBindHost", () => {
  it("accepts loopback bind hosts", () => {
    expect(() => assertLoopbackBindHost("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackBindHost("localhost")).not.toThrow();
    expect(() => assertLoopbackBindHost("::1")).not.toThrow();
    expect(() => assertLoopbackBindHost("[::1]")).not.toThrow();
  });

  it("rejects non-loopback bind hosts", () => {
    expect(() => assertLoopbackBindHost("0.0.0.0")).toThrow(/loopback/);
  });
});
