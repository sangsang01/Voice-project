import { createProductionSpeechClientFactory, GoogleStream } from "@voice/google-transcription-engine/server";
import { loadConfig } from "./config";
import { createServer } from "./server";
import type { ProviderSessionFactory } from "./websocket/transcriptionHandler";

const config = loadConfig();
const speechClientFactory = createProductionSpeechClientFactory();

function log(fields: Record<string, string | number | boolean>): void {
  // Session ID, timings, counts, and safe error codes only -- never audio or transcript text.
  console.log(JSON.stringify(fields));
}

const createProviderSession: ProviderSessionFactory = ({ sessionId, candidateLanguages, onEvent }) => {
  const stream = new GoogleStream({ sessionId, candidateLanguages, factory: speechClientFactory, onEvent });
  return {
    write: (frame) => stream.write(frame),
    stop: async () => stream.stop(),
    cancel: () => stream.cancel(),
  };
};

const server = createServer({
  createProviderSession,
  limits: config.limits,
  allowedOrigins: config.allowedOrigins,
  logger: { info: log },
});

server.httpServer.listen(config.port, () => {
  log({ event: "listening", port: config.port });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ event: "shutdown", signal });
  void server.close().then(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
