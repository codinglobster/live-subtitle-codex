const { core, file, preferences, utils } = iina;

const GROQ_TRANSCRIPT_ENDPOINT =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";
const CURL_CANDIDATES = ["curl", "/usr/bin/curl"];
const FFMPEG_CANDIDATES = ["ffmpeg", "/opt/homebrew/bin/ffmpeg"];
const SUPPORTED_DIRECT_UPLOAD_EXTENSIONS = new Set([
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "ogg",
  "wav",
  "webm",
]);

function noop() {}

function getPreference(key, fallback = "") {
  const value = preferences.get(key);
  return typeof value === "string" ? value.trim() : fallback;
}

function sanitizeBasename(name) {
  return (name || "subtitle")
    .replace(/\.[^./\\]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function getFileExtension(path) {
  const match = path.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function buildSidecarSubtitlePath(sourcePath) {
  if (/\.[^./\\]+$/.test(sourcePath)) {
    return sourcePath.replace(/\.[^./\\]+$/, ".srt");
  }
  return `${sourcePath}.srt`;
}

function decodeFileURL(url) {
  if (!url) {
    return "";
  }
  if (!url.startsWith("file://")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return decodeURIComponent(url.replace(/^file:\/\//, ""));
  }
}

function formatSrtTime(totalSeconds) {
  const clamped = Math.max(0, Number(totalSeconds) || 0);
  const totalMilliseconds = Math.round(clamped * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  const pad = (value, length = 2) => value.toString().padStart(length, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

function segmentsToSrt(segments = []) {
  return segments
    .map((segment, index) => {
      const start = Number(segment.start) || 0;
      const end = Math.max(start + 0.2, Number(segment.end) || start + 2);
      const text = String(segment.text || "").trim();
      if (!text) {
        return null;
      }
      return [
        index + 1,
        `${formatSrtTime(start)} --> ${formatSrtTime(end)}`,
        text,
        "",
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

async function execOrThrow(fileName, args, label) {
  const { status, stdout, stderr } = await utils.exec(fileName, args);
  if (status !== 0) {
    throw new Error(
      `${label} failed (exit ${status})${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return { stdout, stderr };
}

function resolveExecutable(candidates, label) {
  for (const candidate of candidates) {
    if (utils.fileInPath(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${label} was not found in PATH.`);
}

async function extractAudio(inputPath, outputPseudoPath) {
  const ffmpegPath = resolveExecutable(
    FFMPEG_CANDIDATES,
    "ffmpeg",
  );
  await execOrThrow(
    ffmpegPath,
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      utils.resolvePath(outputPseudoPath),
    ],
    "Audio extraction",
  );
}

async function requestTranscription(inputPath, config) {
  const curlPath = resolveExecutable(CURL_CANDIDATES, "curl");
  const responsePseudoPath = `@tmp/groq-transcription-${Date.now()}.json`;
  const responsePath = utils.resolvePath(responsePseudoPath);
  const args = [
    "-sS",
    "-X",
    "POST",
    GROQ_TRANSCRIPT_ENDPOINT,
    "-H",
    `Authorization: Bearer ${config.apiKey}`,
    "-F",
    `file=@${inputPath}`,
    "-F",
    `model=${config.model}`,
    "-F",
    "response_format=verbose_json",
    "-F",
    "timestamp_granularities[]=segment",
    "-o",
    responsePath,
  ];
  if (config.language) {
    args.push("-F", `language=${config.language}`);
  }
  if (config.prompt) {
    args.push("-F", `prompt=${config.prompt}`);
  }
  await execOrThrow(
    curlPath,
    args,
    "Groq transcription",
  );
  const stdout = file.read(responsePseudoPath);
  if (!stdout) {
    throw new Error("Groq response file is empty.");
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Invalid Groq response: ${stdout.slice(0, 300)}`);
  }
  if (file.exists(responsePseudoPath)) {
    file.delete(responsePseudoPath);
  }
  if (parsed.error?.message) {
    throw new Error(`Groq API error: ${parsed.error.message}`);
  }
  return parsed;
}

function resolveInputSource() {
  if (core.status.idle) {
    throw new Error("No media is currently playing.");
  }
  if (core.status.isNetworkResource) {
    throw new Error("Network streams are not supported yet. Open a local file.");
  }
  const path = decodeFileURL(core.status.url);
  if (!path) {
    throw new Error("Cannot resolve the current media path.");
  }
  return path;
}

export async function transcribeCurrentMedia(onProgress = noop) {
  const apiKey = getPreference("groq_api_key");
  if (!apiKey) {
    throw new Error("Groq API key is missing. Set it in plugin preferences.");
  }

  onProgress("Preparing transcription");
  const model = getPreference("whisper_model", DEFAULT_MODEL) || DEFAULT_MODEL;
  const language = getPreference("transcription_language");
  const prompt = getPreference("transcription_prompt");
  const sourcePath = resolveInputSource();
  const baseName = sanitizeBasename(core.status.title || sourcePath);
  const stamp = Date.now();
  const sourceExt = getFileExtension(sourcePath);
  const canDirectUpload = SUPPORTED_DIRECT_UPLOAD_EXTENSIONS.has(sourceExt);

  let uploadPath = sourcePath;
  let extractedAudioPseudoPath = null;

  if (
    !canDirectUpload ||
    FFMPEG_CANDIDATES.some((candidate) => utils.fileInPath(candidate))
  ) {
    onProgress("Extracting audio");
    extractedAudioPseudoPath = `@tmp/${baseName}.${stamp}.m4a`;
    await extractAudio(sourcePath, extractedAudioPseudoPath);
    uploadPath = utils.resolvePath(extractedAudioPseudoPath);
  }

  onProgress("Uploading audio to Groq");
  const response = await requestTranscription(uploadPath, {
    apiKey,
    model,
    language,
    prompt,
  });

  if (!Array.isArray(response.segments) || response.segments.length < 1) {
    throw new Error("Groq returned no timed segments, cannot build SRT.");
  }

  onProgress("Generating SRT");
  const srtContent = segmentsToSrt(response.segments);
  if (!srtContent.trim()) {
    throw new Error("Generated SRT is empty.");
  }

  onProgress("Saving subtitle file");
  const srtPath = buildSidecarSubtitlePath(sourcePath);
  file.write(srtPath, srtContent);

  onProgress("Loading subtitle into player");
  core.subtitle.loadTrack(srtPath);

  if (extractedAudioPseudoPath && file.exists(extractedAudioPseudoPath)) {
    file.delete(extractedAudioPseudoPath);
  }

  return {
    path: srtPath,
    text: response.text || "",
    segmentCount: response.segments.length,
    model,
    language: language || response.language || "",
  };
}
