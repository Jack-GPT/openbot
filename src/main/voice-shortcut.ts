import { readFile } from "node:fs/promises";
import { DEFAULT_VOICE_SHORTCUT, isVoiceShortcut } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import { globalShortcut } from "electron";
import { parseStoredJson, writeJsonFileAtomically } from "../backend/atomic-json-file";
import { isMissingFileError } from "../backend/file-errors";

const logger = createOpenBotLogger("voice-shortcut");

export class VoiceShortcut {
  readonly #writes = Semaphore.makeUnsafe(1);
  #accelerator: string | null = null;
  #registered: string | null = null;
  #disposed = false;

  constructor(
    private readonly path: string,
    private readonly activate: () => void,
  ) {}

  get value(): string | null {
    return this.#accelerator;
  }

  readonly load = Effect.fn("VoiceShortcut.load")(function* (this: VoiceShortcut) {
    const value = yield* Effect.tryPromise({
      try: () => readFile(this.path, "utf8"),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((raw) =>
        parseStoredJson(this.path, raw, (data) =>
          isDynamicRecord(data) &&
          data.version === 1 &&
          (data.accelerator === null || isVoiceShortcut(data.accelerator))
            ? data.accelerator
            : DEFAULT_VOICE_SHORTCUT,
        ),
      ),
      Effect.catch((cause) => {
        if (!isMissingFileError(cause)) logger.warn("Could not read the voice shortcut setting.");
        return Effect.succeed(isMissingFileError(cause) ? DEFAULT_VOICE_SHORTCUT : null);
      }),
    );
    if (this.#disposed || value === null) return;
    this.#accelerator = value;
    if (this.#register(value)) this.#registered = value;
    else logger.warn("Could not register the voice shortcut.", { accelerator: value });
  });

  readonly set = Effect.fn("VoiceShortcut.set")(function* (this: VoiceShortcut, value: string | null) {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const previous = this.#registered;
        if (this.#disposed || (value !== null && value !== previous && !this.#register(value))) {
          return yield* Effect.fail(new Error(sourceText("error.voice.shortcut.unavailable")));
        }
        const write = yield* Effect.result(writeJsonFileAtomically(this.path, { version: 1, accelerator: value }));
        if (write._tag === "Failure" || this.#disposed) {
          if (value !== null && value !== previous) globalShortcut.unregister(value);
          return yield* Effect.fail(new Error(sourceText("error.voice.shortcut.saveFailed")));
        }
        if (previous !== null && previous !== value) globalShortcut.unregister(previous);
        this.#registered = value;
        this.#accelerator = value;
        return value;
      }).pipe(Effect.uninterruptible),
    );
  });

  #register(value: string): boolean {
    try {
      return globalShortcut.register(value, () => {
        if (!this.#disposed && this.#registered === value) this.activate();
      });
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#registered !== null) globalShortcut.unregister(this.#registered);
    this.#registered = null;
  }
}
