import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadChildEnvironment } from "./config.mjs";
import { runProcess } from "./process-utils.mjs";

const MAX_TRANSCRIPT_LENGTH = 4000;
const FILE_KEY_PATTERN = /^file_[A-Za-z0-9._-]{1,512}$/;
const AUDIO_ELEMENT_PATTERN = /^<audio\b[^>]*\bkey="([^"]+)"[^>]*\bduration="([^"]+)"/i;

function voiceError(code, message = code, upstreamCode = null) {
  const error = new Error(message);
  error.code = code;
  error.upstreamCode = upstreamCode;
  return error;
}

function parseDuration(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim().toLowerCase();
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(text);
  if (seconds) return Number(seconds[1]) * 1000;
  const milliseconds = /^(\d+(?:\.\d+)?)ms$/.exec(text);
  if (milliseconds) return Number(milliseconds[1]);
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function audioFromElement(content) {
  const match = AUDIO_ELEMENT_PATTERN.exec(content.trim());
  if (!match) return null;
  const durationMs = parseDuration(match[2]);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return { fileKey: match[1], durationMs: Math.trunc(durationMs) };
}

export function parseAudioContent(content) {
  let value;
  if (content && typeof content === "object") {
    value = content;
  } else {
    const text = String(content ?? "");
    const fromElement = audioFromElement(text);
    if (fromElement) return fromElement;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const fileKey = String(value.key || value.file_key || "");
  const durationMs = parseDuration(value.duration);
  if (!FILE_KEY_PATTERN.test(fileKey)) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return { fileKey, durationMs: Math.trunc(durationMs) };
}

export function defaultDownloadArgs({ messageId, fileKey, outputPath }) {
  return [
    "im", "+messages-resources-download",
    "--message-id", messageId,
    "--file-key", fileKey,
    "--type", "file",
    "--output", outputPath,
    "--as", "bot",
  ];
}

export function defaultTranscodeArgs({ inputPath, outputPath }) {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-ac", "1", "-ar", "16000",
    "-f", "s16le", "-acodec", "pcm_s16le",
    outputPath,
  ];
}

export function defaultRecognizeArgs({ bodyPath }) {
  return [
    "api", "POST", "/open-apis/speech_to_text/v1/speech/file_recognize",
    "--data", `@${bodyPath}`,
    "--as", "bot",
  ];
}

function payloadOf(result) {
  for (const output of [result.stdout, result.stderr]) {
    try {
      const payload = JSON.parse(String(output || ""));
      if (payload && typeof payload === "object") return payload;
    } catch {}
  }
  return null;
}

function isScopeError(payload) {
  const error = payload?.error || payload;
  return [99991672, 99991679].includes(Number(error?.code))
    || ["app_scope_not_applied", "missing_scope"].includes(error?.subtype)
    || error?.missing_scopes?.includes("speech_to_text:speech");
}

function isRetryableRateLimit(payload) {
  const error = payload?.error;
  return error?.retryable === true
    && (error.code === 99991400 || error.subtype === "rate_limit");
}

function assertSuccess(result, code, payload) {
  if (payload?.ok === false || payload?.code != null && Number(payload.code) !== 0) {
    const upstreamCode = Number(payload.error?.code ?? payload.code) || null;
    if (isScopeError(payload)) throw voiceError("VOICE_SCOPE_MISSING", "speech_to_text:speech is not granted");
    if (/free.*not support|not support.*free|免费版|套餐.*不支持|subscription.*required/i.test(payload.error?.message || payload.msg || '')) {
      throw voiceError("VOICE_SERVICE_UNAVAILABLE", "Speech recognition service unavailable for this tenant", upstreamCode);
    }
    if (isRetryableRateLimit(payload)) throw voiceError("VOICE_RATE_LIMITED", "Speech recognition rate limited", upstreamCode);
    throw voiceError(code, payload.error?.message || "lark-cli returned an error");
  }
  if (result.code !== 0) throw voiceError(code, `lark-cli exited with ${result.code}`);
}

function recognitionText(stdout) {
  let payload;
  try {
    payload = JSON.parse(String(stdout || ""));
  } catch {
    throw voiceError("VOICE_RECOGNITION_FAILED", "Speech recognition returned invalid JSON");
  }
  if (!payload || typeof payload !== "object") {
    throw voiceError("VOICE_RECOGNITION_FAILED", "Speech recognition returned no payload");
  }
  if (payload.ok === false) {
    if (isScopeError(payload)) throw voiceError("VOICE_SCOPE_MISSING", "speech_to_text:speech is not granted");
    throw voiceError("VOICE_RECOGNITION_FAILED", payload.error?.message || "Speech recognition failed");
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const text = [data.recognition_text, data.recognitionText, data.text, payload.recognition_text]
    .find((item) => typeof item === "string");
  return (text || "").replace(/\s+/g, " ").trim();
}

function assertRegularFile(filePath, maxBytes, errorCode) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw voiceError(errorCode, "Audio file is missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw voiceError(errorCode, "Audio file is not a regular file");
  if (stat.size <= 0) throw voiceError(errorCode, "Audio file is empty");
  if (stat.size > maxBytes) throw voiceError("VOICE_TOO_LARGE", "Audio file is too large");
}

function requestFileId(messageId) {
  return `voice_${createHash("sha256").update(String(messageId)).digest("hex").slice(0, 10)}`;
}

export class VoiceTranscriber {
  constructor({
    executable,
    ffmpegExecutable = "ffmpeg",
    engineType = "16k_auto",
    maxDurationMs = 60000,
    maxBytes = 10 * 1024 * 1024,
    timeoutMs = 60000,
    recognitionRetryDelaysMs = [1000, 3000, 7000],
    tempRoot = os.tmpdir(),
    run = runProcess,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    downloadArgs = defaultDownloadArgs,
    transcodeArgs = defaultTranscodeArgs,
    recognizeArgs = defaultRecognizeArgs,
    checkScope = null,
    onRecognition = () => {},
  } = {}) {
    if (typeof executable !== "string" || !executable) throw new Error("Voice transcriber requires a lark-cli executable");
    this.executable = executable;
    this.ffmpegExecutable = ffmpegExecutable;
    this.engineType = engineType;
    this.maxDurationMs = maxDurationMs;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.recognitionRetryDelaysMs = [...recognitionRetryDelaysMs];
    this.tempRoot = tempRoot;
    this.run = run;
    this.sleep = sleep;
    this.downloadArgs = downloadArgs;
    this.transcodeArgs = transcodeArgs;
    this.recognizeArgs = recognizeArgs;
    this.checkScope = checkScope;
    this.onRecognition = onRecognition;
  }

  async recognize(bodyPath, cwd) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.run(this.executable, this.recognizeArgs({ bodyPath }), {
        env: loadChildEnvironment(),
        cwd,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: 1024 * 1024,
      });
      try {
        assertSuccess(result, "VOICE_RECOGNITION_FAILED", payloadOf(result));
        const text = recognitionText(result.stdout);
        this.onRecognition('ok');
        return text;
      } catch (error) {
        this.onRecognition(error.code, error.upstreamCode);
        const delayMs = this.recognitionRetryDelaysMs[attempt];
        if (error.code !== "VOICE_RATE_LIMITED" || delayMs === undefined) throw error;
        await this.sleep(delayMs);
      }
    }
  }

  async transcribe({ messageId, fileKey, durationMs }) {
    if (durationMs > this.maxDurationMs) {
      throw voiceError("VOICE_TOO_LONG", "Voice message exceeds the duration limit");
    }
    if ((await this.checkScope?.())?.permission === 'missing') {
      this.onRecognition('VOICE_SCOPE_MISSING');
      throw voiceError('VOICE_SCOPE_MISSING');
    }
    const directory = fs.mkdtempSync(path.join(this.tempRoot, "lark-claude-voice-"));
    const downloadPath = path.join(directory, "audio.opus");
    const pcmPath = path.join(directory, "audio.pcm");
    const bodyPath = path.join(directory, "request.json");
    try {
      const download = await this.run(this.executable, this.downloadArgs({ messageId, fileKey, outputPath: path.basename(downloadPath) }), {
        env: loadChildEnvironment(),
        cwd: directory,
        timeoutMs: this.timeoutMs,
      });
      assertSuccess(download, "VOICE_DOWNLOAD_FAILED", payloadOf(download));
      assertRegularFile(downloadPath, this.maxBytes, "VOICE_DOWNLOAD_FAILED");

      const transcode = await this.run(this.ffmpegExecutable, this.transcodeArgs({ inputPath: downloadPath, outputPath: pcmPath }), {
        env: loadChildEnvironment(),
        timeoutMs: this.timeoutMs,
      });
      if (transcode.code !== 0) throw voiceError("VOICE_TRANSCODE_FAILED", `ffmpeg exited with ${transcode.code}`);
      assertRegularFile(pcmPath, this.maxBytes, "VOICE_TRANSCODE_FAILED");

      fs.writeFileSync(bodyPath, JSON.stringify({
        speech: { speech: fs.readFileSync(pcmPath).toString("base64") },
        config: { file_id: requestFileId(messageId), format: "pcm", engine_type: this.engineType },
      }));
      const text = await this.recognize(path.basename(bodyPath), directory);
      if (!text) throw voiceError("VOICE_EMPTY", "Speech recognition returned no text");
      return text.slice(0, MAX_TRANSCRIPT_LENGTH);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

export function voiceFailureText(error) {
  switch (error?.code) {
    case "VOICE_TOO_LONG":
      return "语音时长超过限制，请缩短或改用文字。";
    case "VOICE_TOO_LARGE":
      return "语音文件过大，请缩短或改用文字。";
    case "VOICE_EMPTY":
      return "未能识别出语音内容，请重试或改用文字。";
    case "VOICE_SCOPE_MISSING":
      return "语音识别权限未开通，请在飞书开发者后台申请 speech_to_text:speech 后重试。";
    case "VOICE_RATE_LIMITED":
      return "飞书语音识别接口返回限流，已短暂重试。若持续发生，请核查租户套餐与服务配额（免费版不支持此接口）；当前可改用文字。";
    case "VOICE_SERVICE_UNAVAILABLE":
      return "当前租户套餐或服务状态不支持飞书语音识别，请检查语音服务开通状态；当前可改用文字。";
    case "VOICE_TRANSCODE_FAILED":
      return "语音转码失败，请稍后重试或改用文字。";
    default:
      return "语音识别失败，请稍后重试或改用文字。";
  }
}
