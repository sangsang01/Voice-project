export interface GoogleRecognitionAlternative {
  transcript: string;
  confidence?: number;
}

export interface GoogleDuration {
  seconds?: number;
  nanos?: number;
}

export interface GoogleStreamingRecognitionResult {
  alternatives: GoogleRecognitionAlternative[];
  isFinal?: boolean;
  languageCode?: string;
  resultEndTime?: GoogleDuration;
}

export interface GoogleStreamingRecognizeResponse {
  results?: GoogleStreamingRecognitionResult[];
}

export interface GoogleProviderError {
  code: number;
  message: string;
}
