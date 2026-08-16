export const PCM_PROTOCOL_VERSION = 1;
export const PCM_MESSAGE_TYPE = 1;
export const PCM_HEADER_BYTES = 16;
export const PCM_MESSAGE_BYTES = 656;
export function encodePcmMessage(frame) {
    if (!(frame.samples instanceof Int16Array) || frame.samples.length !== 320) {
        throw new TypeError("PCM frame must contain 320 Int16 samples");
    }
    const buffer = new ArrayBuffer(PCM_MESSAGE_BYTES);
    const view = new DataView(buffer);
    view.setUint8(0, PCM_PROTOCOL_VERSION);
    view.setUint8(1, PCM_MESSAGE_TYPE);
    view.setUint16(2, 0, true);
    view.setUint32(4, frame.sequence, true);
    view.setFloat64(8, frame.startMs, true);
    for (let index = 0; index < 320; index += 1) {
        view.setInt16(PCM_HEADER_BYTES + index * 2, frame.samples[index], true);
    }
    return buffer;
}
export function decodePcmMessage(buffer) {
    if (buffer.byteLength !== PCM_MESSAGE_BYTES) {
        throw new RangeError("PCM message must be 656 bytes");
    }
    const view = new DataView(buffer);
    if (view.getUint8(0) !== PCM_PROTOCOL_VERSION) {
        throw new TypeError("unsupported PCM protocol version");
    }
    if (view.getUint8(1) !== PCM_MESSAGE_TYPE) {
        throw new TypeError("unsupported binary message type");
    }
    if (view.getUint16(2, true) !== 0) {
        throw new TypeError("reserved PCM header bytes must be zero");
    }
    const samples = new Int16Array(320);
    for (let index = 0; index < 320; index += 1) {
        samples[index] = view.getInt16(PCM_HEADER_BYTES + index * 2, true);
    }
    return { sequence: view.getUint32(4, true), startMs: view.getFloat64(8, true), samples };
}
