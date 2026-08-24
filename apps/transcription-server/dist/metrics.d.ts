export interface DecodeMetrics {
    sessionId: string;
    kind: "provisional" | "final";
    queueDelayMs: number;
    decodeMs: number;
    audioMs: number;
    realtimeFactor: number;
    model: string;
    text?: never;
    samples?: never;
    pcm?: never;
}
export interface MetricsSink {
    recordDecode(metrics: DecodeMetrics): void;
}
export interface LineWriter {
    write(chunk: string): void;
}
export declare function recordDecode(metrics: DecodeMetrics, sink?: LineWriter): void;
export declare class JsonLinesMetricsSink implements MetricsSink {
    private readonly sink;
    constructor(sink?: LineWriter);
    recordDecode(metrics: DecodeMetrics): void;
}
