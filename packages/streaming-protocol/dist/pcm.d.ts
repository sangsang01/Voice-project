import type { PcmFrame } from "@voice/transcription-contracts";
export declare const PCM_PROTOCOL_VERSION = 1;
export declare const PCM_MESSAGE_TYPE = 1;
export declare const PCM_HEADER_BYTES = 16;
export declare const PCM_MESSAGE_BYTES = 656;
export declare function encodePcmMessage(frame: PcmFrame): ArrayBuffer;
export declare function decodePcmMessage(buffer: ArrayBuffer): PcmFrame;
