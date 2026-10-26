import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeLarkEvent } from "../src/lark.mjs";
import { parseAudioContent, VoiceTranscriber, voiceFailureText } from "../src/voice.mjs";

const AUDIO_CONTENT = JSON.stringify({ file_key: "file_v3_abc-123", duration: 3200 });

test("parseAudioContent accepts JSON and audio element payloads", () => {
  assert.deepEqual(parseAudioContent(AUDIO_CONTENT), { fileKey: "file_v3_abc-123", durationMs: 3200 });
  assert.deepEqual(parseAudioContent({ file_key: "file_v3_abc-123", duration: "3200" }), { fileKey: "file_v3_abc-123", durationMs: 3200 });
  assert.deepEqual(parseAudioContent('<audio key="file_v3_abc-123" duration="2s"/>'), { fileKey: "file_v3_abc-123", durationMs: 2000 });
  assert.deepEqual(parseAudioContent({ key: "file_v3_abc-123", duration: "1500ms" }), { fileKey: "file_v3_abc-123", durationMs: 1500 });
});

test("parseAudioContent rejects malformed audio payloads", () => {
  assert.equal(parseAudioContent("not-json"), null);
  assert.equal(parseAudioContent("{}"), null);
  assert.equal(parseAudioContent({ file_key: "https://example.com/a.opus", duration: 1000 }), null);
  assert.equal(parseAudioContent({ file_key: "file_1", duration: 0 }), null);
  assert.equal(parseAudioContent({ file_key: "file_1", duration: "soon" }), null);
});

test("normalizeLarkEvent serializes object message content", () => {
  const event = normalizeLarkEvent({
    message_id: "om_1", sender_id: "ou_1", sender_type: "user", chat_id: "oc_1",
    chat_type: "p2p", message_type: "audio", content: { file_key: "file_1", duration: 1000 },
  });
  assert.equal(event.content, JSON.stringify({ file_key: "file_1", duration: 1000 }));
});

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lark-voice-test-"));
}

function rateLimitResult(retryable, { includeRetryable = true } = {}) {
  const error = { code: 99991400, subtype: "rate_limit", message: "request trigger frequency limit" };
  if (includeRetryable) error.retryable = retryable;
  return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error }) };
}

test("VoiceTranscriber downloads, transcodes, recognizes, and cleans up", async () => {
  const root = tempRoot();
  let transcodeSawDownload = false;
  let recognizeSawPcm = false;
  let outputPath = null;
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      ffmpegExecutable: "ffmpeg",
      tempRoot: root,
      run: async (file, args) => {
        if (file === "ffmpeg") {
          transcodeSawDownload = fs.existsSync(args[args.indexOf("-i") + 1]);
          fs.writeFileSync(args[args.length - 1], Buffer.from("pcm"));
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("api")) {
          const body = JSON.parse(fs.readFileSync(args[args.indexOf("--data") + 1].replace(/^@/, ""), "utf8"));
          assert.equal(body.config.format, "pcm");
          assert.equal(body.config.engine_type, "16k_auto");
          assert.match(body.config.file_id, /^[A-Za-z0-9_]{16}$/);
          recognizeSawPcm = Buffer.from(body.speech.speech, "base64").toString() === "pcm";
          return { code: 0, stdout: JSON.stringify({ ok: true, data: { recognition_text: "  继续修复第一项  " } }), stderr: "" };
        }
        outputPath = args[args.indexOf("--output") + 1];
        fs.writeFileSync(outputPath, Buffer.from("opus"));
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
    });
    assert.equal(await transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 3200 }), "继续修复第一项");
    assert.equal(transcodeSawDownload, true);
    assert.equal(recognizeSawPcm, true);
    assert.equal(fs.existsSync(outputPath), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VoiceTranscriber rejects overlong audio before running lark-cli", async () => {
  const root = tempRoot();
  let calls = 0;
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      tempRoot: root,
      maxDurationMs: 1000,
      run: async () => { calls += 1; return { code: 0, stdout: "{}", stderr: "" }; },
    });
    await assert.rejects(
      transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1001 }),
      (error) => error.code === "VOICE_TOO_LONG",
    );
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VoiceTranscriber bounds the downloaded file and cleans up on failure", async () => {
  const root = tempRoot();
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      tempRoot: root,
      maxBytes: 2,
      run: async (file, args) => {
        const outputPath = args[args.indexOf("--output") + 1];
        fs.writeFileSync(outputPath, Buffer.from("too large"));
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    await assert.rejects(
      transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1000 }),
      (error) => error.code === "VOICE_TOO_LARGE",
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VoiceTranscriber surfaces recognition failure without leaking lark-cli output", async () => {
  const root = tempRoot();
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      ffmpegExecutable: "ffmpeg",
      tempRoot: root,
      run: async (file, args) => {
        if (file === "ffmpeg") {
          fs.writeFileSync(args[args.length - 1], Buffer.from("pcm"));
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("--output")) {
          fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.from("opus"));
          return { code: 0, stdout: "{}", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "secret internal detail" };
      },
    });
    await assert.rejects(
      transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1000 }),
      (error) => error.code === "VOICE_RECOGNITION_FAILED" && !error.message.includes("secret"),
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VoiceTranscriber reports a missing speech scope distinctly", async () => {
  const root = tempRoot();
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      ffmpegExecutable: "ffmpeg",
      tempRoot: root,
      run: async (file, args) => {
        if (file === "ffmpeg") {
          fs.writeFileSync(args[args.length - 1], Buffer.from("pcm"));
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("--output")) {
          fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.from("opus"));
          return { code: 0, stdout: "{}", stderr: "" };
        }
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({ ok: false, error: { code: 99991672, subtype: "app_scope_not_applied", message: "denied" } }),
        };
      },
    });
    await assert.rejects(
      transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1000 }),
      (error) => error.code === "VOICE_SCOPE_MISSING",
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VoiceTranscriber retries explicit rate limits without repeating download or transcode", async () => {
  const root = tempRoot();
  const delays = [];
  let downloads = 0;
  let transcodes = 0;
  let recognitions = 0;
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      ffmpegExecutable: "ffmpeg",
      tempRoot: root,
      sleep: async (delay) => { delays.push(delay); },
      run: async (file, args) => {
        if (file === "ffmpeg") {
          transcodes += 1;
          fs.writeFileSync(args[args.length - 1], Buffer.from("pcm"));
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("--output")) {
          downloads += 1;
          fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.from("opus"));
          return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        recognitions += 1;
        if (recognitions < 3) return rateLimitResult(true);
        return { code: 0, stdout: JSON.stringify({ ok: true, data: { recognition_text: "继续执行" } }), stderr: "" };
      },
    });
    assert.equal(await transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1000 }), "继续执行");
    assert.equal(downloads, 1);
    assert.equal(transcodes, 1);
    assert.equal(recognitions, 3);
    assert.deepEqual(delays, [1000, 3000]);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VoiceTranscriber reports a rate limit after bounded retries", async () => {
  const root = tempRoot();
  const delays = [];
  let recognitions = 0;
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      ffmpegExecutable: "ffmpeg",
      tempRoot: root,
      sleep: async (delay) => { delays.push(delay); },
      run: async (file, args) => {
        if (file === "ffmpeg") {
          fs.writeFileSync(args[args.length - 1], Buffer.from("pcm"));
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("--output")) {
          fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.from("opus"));
          return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        recognitions += 1;
        return rateLimitResult(true);
      },
    });
    await assert.rejects(
      transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1000 }),
      (error) => error.code === "VOICE_RATE_LIMITED",
    );
    assert.equal(recognitions, 4);
    assert.deepEqual(delays, [1000, 3000, 7000]);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VoiceTranscriber does not retry rate limits without explicit retryable true", async () => {
  const scenarios = [
    rateLimitResult(false),
    rateLimitResult(null),
    rateLimitResult("true"),
    rateLimitResult(undefined, { includeRetryable: false }),
  ];
  for (const result of scenarios) {
    const root = tempRoot();
    let recognitions = 0;
    try {
      const transcriber = new VoiceTranscriber({
        executable: "lark-cli",
        ffmpegExecutable: "ffmpeg",
        tempRoot: root,
        sleep: async () => { throw new Error("must not wait"); },
        run: async (file, args) => {
          if (file === "ffmpeg") {
            fs.writeFileSync(args[args.length - 1], Buffer.from("pcm"));
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args.includes("--output")) {
            fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.from("opus"));
            return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
          }
          recognitions += 1;
          return result;
        },
      });
      await assert.rejects(
        transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1000 }),
        (error) => error.code === "VOICE_RECOGNITION_FAILED",
      );
      assert.equal(recognitions, 1);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("VoiceTranscriber reports transcode failure and cleans up", async () => {
  const root = tempRoot();
  try {
    const transcriber = new VoiceTranscriber({
      executable: "lark-cli",
      ffmpegExecutable: "ffmpeg",
      tempRoot: root,
      run: async (file, args) => {
        if (file === "ffmpeg") return { code: 1, stdout: "", stderr: "invalid data" };
        fs.writeFileSync(args[args.indexOf("--output") + 1], Buffer.from("opus"));
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      },
    });
    await assert.rejects(
      transcriber.transcribe({ messageId: "om_1", fileKey: "file_1", durationMs: 1000 }),
      (error) => error.code === "VOICE_TRANSCODE_FAILED",
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("voiceFailureText maps failures to actionable Chinese replies", () => {
  assert.match(voiceFailureText({ code: "VOICE_TOO_LONG" }), /语音时长/);
  assert.match(voiceFailureText({ code: "VOICE_EMPTY" }), /未能识别/);
  assert.match(voiceFailureText({ code: "VOICE_TRANSCODE_FAILED" }), /转码/);
  assert.match(voiceFailureText({ code: "VOICE_SCOPE_MISSING" }), /权限/);
  assert.match(voiceFailureText({ code: "VOICE_RATE_LIMITED" }), /限流/);
  assert.match(voiceFailureText(new Error("boom")), /语音识别失败/);
});
