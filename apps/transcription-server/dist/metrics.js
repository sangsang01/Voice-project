export class JsonLinesMetricsSink {
    writeLine;
    constructor(writeLine) {
        this.writeLine = writeLine;
    }
    recordDecode(record) {
        this.writeLine(`${JSON.stringify(record)}\n`);
    }
}
