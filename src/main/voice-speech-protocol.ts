// The messages between the main process and the speech host, which reads replies aloud.
//
// Type-only: the host imports nothing from here at runtime, so it stays free of application code.

export interface VoiceSpeechRequest {
  id: number;
  /** Absolute path of `sherpa-onnx.node`. */
  addonPath: string;
  /** Kokoro uses a different model layout. Omitted for Supertonic. */
  kokoro?: true;
  /** The directory with the model files. */
  modelDirectory: string;
  text: string;
  /** A Supertonic 3 language code. */
  language: string;
  /** The model's speaker index. */
  speakerId: number;
  /** Only load the model, and answer with no audio. */
  loadOnly: boolean;
  /** ONNX Runtime threads. */
  numThreads: number;
  /** A file of ONNX Runtime session settings in the runtime directory, or empty for the defaults. */
  sessionConfig: string;
}

/**
 * Why a request failed. Only the category crosses the process boundary: the addon's own message
 * can contain paths, and the main process maps the category to a localized error.
 */
export type VoiceSpeechFailure = "runtime-unavailable" | "model-load-failed" | "inference-failed";

export type VoiceSpeechResponse =
  | {
      id: number;
      /** Little-endian 16-bit mono PCM. */
      pcm: Uint8Array;
      sampleRate: number;
    }
  | { id: number; error: VoiceSpeechFailure };

export interface VoiceSpeechHostProcess {
  send(request: VoiceSpeechRequest): void;
  onResponse(listener: (response: VoiceSpeechResponse) => void): void;
  /** The host ended, asked or not. */
  onExit(listener: () => void): void;
  /** End it now, whatever it is in the middle of. */
  kill(): void;
}
