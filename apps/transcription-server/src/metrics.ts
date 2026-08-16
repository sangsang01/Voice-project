export interface DecodeMetrics {
  sessionId: string;
  kind: "provisional" | "final";
  queueDelayMs: number;
  decodeMs: number;
  audioMs: number;
  realtimeFactor: number;
  model: string;
}

export interface MetricsSink {
  recordDecode(metrics: DecodeMetrics): void;
}

export interface LineWriter {
  write(chunk: string): void;
}

export function recordDecode(metrics: DecodeMetrics, sink: LineWriter = process.stdout): void {
  sink.write(`${JSON.stringify(metrics)}\n`);
}

export class JsonLinesMetricsSink implements MetricsSink {
  public constructor(private readonly sink: LineWriter = process.stdout) {}

  public recordDecode(metrics: DecodeMetrics): void {
    recordDecode(metrics, this.sink);
  }
}
