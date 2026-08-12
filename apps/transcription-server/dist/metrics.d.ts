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
export declare class JsonLinesMetricsSink implements MetricsSink {
    private readonly writeLine;
    constructor(writeLine: (line: string) => void);
    recordDecode(record: DecodeMetricsRecord): void;
}
