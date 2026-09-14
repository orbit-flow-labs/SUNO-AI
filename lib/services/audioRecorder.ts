/**
 * Universal Mobile & Desktop Audio Recording Utility
 * Designed for low-latency, stutter-free mic capture on Android & iOS Safari.
 */

export interface AudioLevelCallback {
  (level: number): void;
}

export interface SupportedMime {
  mimeType: string;
  extension: string;
}

/**
 * Detects the highest quality, natively supported audio container format
 * across Android Chrome, iOS Safari, desktop browsers, and PWAs.
 */
export function getSupportedAudioMimeType(): SupportedMime {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return { mimeType: "audio/webm", extension: "webm" };
  }

  const candidateTypes = [
    { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    { mimeType: "audio/webm", extension: "webm" },
    { mimeType: "audio/mp4;codecs=mp4a.40.2", extension: "mp4" },
    { mimeType: "audio/mp4", extension: "mp4" },
    { mimeType: "audio/aac", extension: "aac" },
    { mimeType: "audio/ogg;codecs=opus", extension: "ogg" },
  ];

  for (const candidate of candidateTypes) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate;
    }
  }

  return { mimeType: "", extension: "webm" };
}

export interface MobileVoiceRecorderOptions {
  onAudioLevel?: AudioLevelCallback;
  onSpeechEnd?: () => void;
  silenceThreshold?: number; // 0.0 to 1.0 (default: 0.04)
  silenceDurationMs?: number; // silence ms before auto-stop trigger (default: 1350)
  minSpeechDurationMs?: number; // min speech ms required to trigger silence stop (default: 700)
  enableVAD?: boolean;
}

export class MobileVoiceRecorder {
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private chunks: Blob[] = [];
  private options: MobileVoiceRecorderOptions;

  private isRecording = false;
  private speechStartTime: number | null = null;
  private lastSpeechTime: number | null = null;
  private silenceCheckTimer: NodeJS.Timeout | null = null;
  private hasDetectedSpeech = false;
  private mimeInfo: SupportedMime = { mimeType: "", extension: "webm" };

  constructor(options: MobileVoiceRecorderOptions = {}) {
    this.options = {
      silenceThreshold: 0.04,
      silenceDurationMs: 1350,
      minSpeechDurationMs: 700,
      enableVAD: false,
      ...options,
    };
  }

  /**
   * Unlocks iOS Safari Web Audio Session.
   * Must be called during or immediately after user interaction.
   */
  public static async unlockAudioContext(ctx?: AudioContext | null): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      const targetCtx = ctx || (window as any).__sonaAudioCtx;
      if (targetCtx && targetCtx.state === "suspended") {
        await targetCtx.resume();
      }
    } catch {}
  }

  /**
   * Starts capturing audio with mobile-optimized constraints and audio analysis.
   */
  public async start(existingStream?: MediaStream | null): Promise<MediaStream> {
    await this.stop();
    this.chunks = [];
    this.hasDetectedSpeech = false;
    this.speechStartTime = null;
    this.lastSpeechTime = null;

    this.mimeInfo = getSupportedAudioMimeType();

    // 1. Acquire clean microphone stream if not provided
    if (existingStream && existingStream.active) {
      this.stream = existingStream;
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: { ideal: 48000, min: 16000 },
        },
      });
    }

    // 2. Setup Web Audio Analyser for RMS metering and VAD
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        if (!this.audioContext || this.audioContext.state === "closed") {
          this.audioContext = new AudioCtx();
        }
        if (this.audioContext.state === "suspended") {
          await this.audioContext.resume();
        }

        const source = this.audioContext.createMediaStreamSource(this.stream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.65;
        source.connect(analyser);
        this.analyser = analyser;

        this.startLevelLoop();
      }
    } catch (err) {
      console.warn("[MobileVoiceRecorder] AudioContext setup notice:", err);
    }

    // 3. Initialize MediaRecorder
    const recorderOptions: MediaRecorderOptions = {};
    if (this.mimeInfo.mimeType) {
      recorderOptions.mimeType = this.mimeInfo.mimeType;
    }

    const recorder = new MediaRecorder(this.stream, recorderOptions);
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    // Request data in 200ms slices for responsive buffering
    recorder.start(200);
    this.isRecording = true;

    return this.stream;
  }

  /**
   * Real-time Audio Level loop (RMS computation)
   */
  private startLevelLoop() {
    if (!this.analyser) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const checkLevel = () => {
      if (!this.isRecording || !this.analyser) return;

      this.analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      const normalizedLevel = Math.min(1, Math.max(0, avg / 128));

      // Callback to UI visualizer
      this.options.onAudioLevel?.(normalizedLevel);

      // Voice Activity Detection (VAD) Logic
      if (this.options.enableVAD) {
        const threshold = this.options.silenceThreshold ?? 0.04;
        const now = Date.now();

        if (normalizedLevel > threshold) {
          if (!this.speechStartTime) {
            this.speechStartTime = now;
          }
          this.lastSpeechTime = now;
          this.hasDetectedSpeech = true;
        } else if (this.hasDetectedSpeech && this.speechStartTime) {
          const speechDuration = (this.lastSpeechTime || now) - this.speechStartTime;
          const minDuration = this.options.minSpeechDurationMs ?? 700;
          const silenceDuration = this.options.silenceDurationMs ?? 1350;

          if (speechDuration >= minDuration && this.lastSpeechTime && now - this.lastSpeechTime > silenceDuration) {
            // Silence detected after valid speech
            this.hasDetectedSpeech = false;
            this.speechStartTime = null;
            this.lastSpeechTime = null;
            this.options.onSpeechEnd?.();
          }
        }
      }

      this.animFrameId = requestAnimationFrame(checkLevel);
    };

    this.animFrameId = requestAnimationFrame(checkLevel);
  }

  /**
   * Stops recording and returns the final high-quality audio Blob and extension.
   */
  public async stop(): Promise<{ blob: Blob; mimeType: string; extension: string } | null> {
    this.isRecording = false;

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.silenceCheckTimer) {
      clearTimeout(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }

    this.options.onAudioLevel?.(0);

    const recorder = this.mediaRecorder;
    if (!recorder) {
      return null;
    }

    return new Promise((resolve) => {
      const finalize = () => {
        const effectiveMime = this.mimeInfo.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type: effectiveMime });
        this.chunks = [];
        this.mediaRecorder = null;
        resolve({
          blob,
          mimeType: effectiveMime,
          extension: this.mimeInfo.extension,
        });
      };

      if (recorder.state !== "inactive") {
        recorder.onstop = finalize;
        try {
          recorder.stop();
        } catch {
          finalize();
        }
      } else {
        finalize();
      }
    });
  }

  /**
   * Cleanly releases all hardware tracks and closes audio context.
   */
  public destroy() {
    this.stop();
    if (this.stream) {
      try {
        this.stream.getTracks().forEach((track) => {
          track.stop();
          track.enabled = false;
        });
      } catch {}
      this.stream = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        this.audioContext.close().catch(() => {});
      } catch {}
      this.audioContext = null;
    }
    this.analyser = null;
  }

  public getStream(): MediaStream | null {
    return this.stream;
  }

  public getIsRecording(): boolean {
    return this.isRecording;
  }
}
