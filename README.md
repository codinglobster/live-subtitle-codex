# AI Subtitle Studio

IINA plugin that extracts the current video's audio, sends it to Groq Whisper,
and loads the generated SRT subtitle automatically.

## Requirements

Before using the plugin, install the required command line tools with Homebrew:

```bash
brew install ffmpeg curl
```

The plugin currently depends on:

- `ffmpeg` to extract audio from the current video
- `curl` to upload the audio file to Groq Whisper

You also need a Groq API key, which can be configured in the plugin
preferences page inside IINA.

## Build

```bash
npm install
npm run build
```

## Load locally

```bash
iina-plugin link .
```
