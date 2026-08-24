import { decodePcmMessage } from "@voice/streaming-protocol";
import {
  describeEngineContract,
  makePcmFrame,
  makeSessionRequest,
} from "@voice/transcription-contracts/testing";
import { RemoteWhisperEngine } from "../src/index.js";
import { FakeSocket } from "./fakeSocket.js";

const request = makeSessionRequest(["en-US"]);
const frame = makePcmFrame(0);

function createEngine() {
  return new RemoteWhisperEngine({
    endpoint: "ws://127.0.0.1:8787",
    socketFactory: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      let eventSequence = 0;
      const originalSend = socket.send.bind(socket);
      socket.send = (data: string | ArrayBuffer) => {
        originalSend(data);
        if (typeof data !== "string") {
          const pcm = decodePcmMessage(data);
          queueMicrotask(() => {
            socket.emitJson({
              type: "audio.ack",
              sessionId: request.sessionId,
              throughSequence: pcm.sequence,
            });
          });
          return;
        }

        const message = JSON.parse(data) as {
          type?: string;
          sessionId?: string;
          request?: { sessionId?: string };
        };
        const sessionId = message.sessionId ?? message.request?.sessionId;
        if (!sessionId) return;

        if (message.type === "session.start") {
          queueMicrotask(() => {
            socket.emitJson({
              type: "session.accepted",
              sessionId,
              model: "small",
              backend: "cpu",
            });
            socket.emitJson({
              type: "engine.event",
              event: {
                type: "state",
                sessionId,
                sequence: eventSequence,
                state: "listening",
              },
            });
            eventSequence += 1;
          });
          return;
        }

        if (message.type === "session.stop") {
          queueMicrotask(() => {
            socket.emitJson({
              type: "engine.event",
              event: { type: "state", sessionId, sequence: eventSequence, state: "draining" },
            });
            eventSequence += 1;
            socket.emitJson({
              type: "engine.event",
              event: {
                type: "segment.upsert",
                sessionId,
                sequence: eventSequence,
                segment: {
                  id: `${sessionId}:final`,
                  ordinal: 0,
                  revision: 1,
                  startMs: 0,
                  endMs: 20,
                  text: "hello",
                  language: { tag: "en-US" },
                  isFinal: true,
                },
              },
            });
            eventSequence += 1;
            socket.emitJson({
              type: "engine.event",
              event: { type: "state", sessionId, sequence: eventSequence, state: "stopped" },
            });
            eventSequence += 1;
          });
          return;
        }

        if (message.type === "session.cancel") {
          queueMicrotask(() => {
            socket.emitJson({
              type: "engine.event",
              event: { type: "state", sessionId, sequence: eventSequence, state: "stopped" },
            });
            eventSequence += 1;
          });
        }
      };
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
}

describeEngineContract("remote whisper", createEngine, {
  request,
  frame,
  framesBeforeStop: 1,
});
