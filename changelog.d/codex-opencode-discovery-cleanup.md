### Added

- Turn on live voice in desktop Voice settings and choose Codex or MOSS Live to speak with an OpenBot agent.
- Choose the default voice, Nuannuan, or Mumu for MOSS Live calls in desktop Voice settings.
- Choose Kokoro v1.1 (ZH) in Voice settings to read Chinese and English replies with a local neural voice.

- On supported Windows 11 computers, choose Solid, Frosted glass (Mica), or Acrylic in General settings. Adjust transparency across the workspace and chat backgrounds. macOS also has a transparency slider.

### Changed

- Windows controls now share the OpenBot toolbar in the main window and separate chat windows.

### Fixed

- Windows provider update notifications open below the window controls.
- MOSS Live schedules reply audio on a continuous playback clock to prevent crackles between chunks.
- Codex live voice waits for the audio connection before it shows Listening. If the connection fails, the voice pane shows an error and releases the microphone.

- OpenCode discovers models in a temporary folder and deletes the sessions it creates for discovery. Before, empty sessions stayed in OpenCode's history.
- Agent replies now play aloud when you use dictation or start a voice conversation in a separate chat window. Before, that window skipped the events that start playback.
- OpenBot reads Chinese replies on Windows with an installed Chinese voice when Supertonic 3 is selected.
