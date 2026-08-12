export interface DecodeMetricsRecord {
  sessionId: string;
  model: string;
  resultKind: "provisional" | "final";
  queueDelayMs: number;
  decodeDurationMs: number;
  audioDurationMs: number;
  realTimeFactor: number;
}

export interface MetricsSink {
  recordDecode(record: DecodeMetricsRecord): void;
}

export class JsonLinesMetricsSink implements MetricsSink {
  public constructor(private readonly writeLine: (line: string) => void) {}

  public recordDecode(record: DecodeMetricsRecord): void {
    this.writeLine(`${JSON.stringify(record)}\n`);
  }
}
