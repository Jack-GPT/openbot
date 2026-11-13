import { execFile } from "node:child_process";
import type { SpeechAudio } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { VoiceOperationError } from "./voice-model-service";

const SAMPLE_RATE = 24_000;
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$audio = [System.IO.MemoryStream]::new()
try {
  $voice = $synth.GetInstalledVoices() | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'zh'
  } | Sort-Object { $_.VoiceInfo.Culture.Name -ne 'zh-CN' } | Select-Object -First 1
  if (!$voice) { exit 2 }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
    ${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  $synth.SetOutputToAudioStream($audio, $format)
  $synth.Speak([Console]::In.ReadToEnd())
  $audio.Position = 0
  $audio.CopyTo([Console]::OpenStandardOutput())
} finally {
  $synth.Dispose()
  $audio.Dispose()
}
`;

/** Sends the reply to the installed voice over stdin and returns raw PCM. */
export const speakChineseOnWindows = Effect.fn("VoiceSpeech.speakChineseOnWindows")(function* (text: string) {
  const failed = () => new VoiceOperationError({ cause: new Error(sourceText("error.voice.speech.failed")) });
  if (process.platform !== "win32") return yield* failed();
  return yield* Effect.callback<SpeechAudio, VoiceOperationError>((resume) => {
    // The command is fixed. Reply text is input data and never appears in command arguments or logs.
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")],
      { encoding: "buffer", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error || stdout.byteLength < 2 || stdout.byteLength % 2 !== 0) resume(Effect.fail(failed()));
        else resume(Effect.succeed({ pcm: stdout, sampleRate: SAMPLE_RATE }));
      },
    );
    child.stdin?.on("error", () => child.kill());
    child.stdin?.end(text, "utf8");
    return Effect.sync(() => {
      if (child.exitCode === null) child.kill();
    });
  });
});
