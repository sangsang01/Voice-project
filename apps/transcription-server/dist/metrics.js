export function recordDecode(metrics, sink = process.stdout) {
    sink.write(`${JSON.stringify(metrics)}\n`);
}
export class JsonLinesMetricsSink {
    sink;
    constructor(sink = process.stdout) {
        this.sink = sink;
    }
    recordDecode(metrics) {
        recordDecode(metrics, this.sink);
    }
}
