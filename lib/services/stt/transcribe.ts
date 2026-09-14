import Groq from "groq-sdk";
import { AssemblyAI } from "assemblyai";
import { transcribeAudio as transcribeAssemblyAudio, isSTTConfigured as isAssemblyConfigured } from "./assemblyai";

export interface FastTranscriptionResult {
  text: string;
  provider: "groq-whisper" | "assemblyai";
  durationSeconds?: number;
}

export function isSTTAvailable(): boolean {
  return Boolean(process.env.GROQ_API_KEY || isAssemblyConfigured());
}

/**
 * Ultra-fast transcription of an audio File/Blob/Buffer.
 * Prioritizes Groq Whisper Turbo (~150-250ms sub-second latency),
 * with seamless fallback to AssemblyAI.
 */
export async function transcribeAudioData(
  audioData: File | Blob | Buffer,
  filename = "recording.webm"
): Promise<FastTranscriptionResult> {
  // 1. Attempt Groq Whisper Turbo first (ultra-fast ~150-250ms)
  if (process.env.GROQ_API_KEY) {
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      let uploadFile: any = audioData;
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(audioData)) {
        const mimeType = filename.endsWith(".mp4") || filename.endsWith(".m4a") ? "audio/mp4" : "audio/webm";
        uploadFile = new File([new Uint8Array(audioData)], filename, { type: mimeType });
      } else if (audioData instanceof Blob && !(audioData instanceof File)) {
        uploadFile = new File([audioData], filename, { type: audioData.type || "audio/webm" });
      }

      const response = await groq.audio.transcriptions.create({
        file: uploadFile,
        model: "whisper-large-v3-turbo",
        language: "en",
        response_format: "json",
        temperature: 0.0,
        prompt: "Conversational audio, natural speech, questions and statements.",
      });

      const text = response.text ? response.text.trim() : "";
      if (text) {
        return {
          text,
          provider: "groq-whisper",
        };
      }
    } catch (groqErr) {
      console.warn("[STT] Groq Whisper Turbo attempt failed, falling back to AssemblyAI:", groqErr);
    }
  }

  // 2. Fallback to AssemblyAI
  if (isAssemblyConfigured()) {
    const aai = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY! });
    
    let buffer: Buffer;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(audioData)) {
      buffer = audioData;
    } else if (audioData instanceof Blob || audioData instanceof File) {
      const arrayBuf = await audioData.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    } else {
      throw new Error("UNSUPPORTED_AUDIO_FORMAT");
    }

    const uploadUrl = await aai.files.upload(buffer);
    const transcript = await aai.transcripts.transcribe({
      audio: uploadUrl,
      speech_model: "best",
      punctuate: true,
      format_text: true,
    });

    if (transcript.status === "error") {
      throw new Error(transcript.error ?? "ASSEMBLYAI_TRANSCRIPTION_FAILED");
    }

    return {
      text: transcript.text?.trim() ?? "",
      provider: "assemblyai",
      durationSeconds: transcript.audio_duration ?? undefined,
    };
  }

  throw new Error("NO_STT_PROVIDER_CONFIGURED");
}

/**
 * Transcribe from an external URL
 */
export async function transcribeFromUrl(audioUrl: string): Promise<FastTranscriptionResult> {
  if (isAssemblyConfigured()) {
    const res = await transcribeAssemblyAudio(audioUrl);
    return {
      text: res.text,
      provider: "assemblyai",
      durationSeconds: res.durationSeconds,
    };
  }

  throw new Error("NO_STT_PROVIDER_CONFIGURED");
}
