"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Image from "next/image";
import { getPremiumVoices, getBestNaturalVoice, type SpeechVoiceOption } from "@/lib/services/voice";
import { MobileVoiceRecorder } from "@/lib/services/audioRecorder";
import type { Mode } from "@/lib/types/database";

interface VoiceCallModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSendMessage: (text: string) => Promise<string | void>;
  initialGreeting?: string;
  mode?: Mode;
}

export default function VoiceCallModal({
  isOpen,
  onClose,
  onSendMessage,
  initialGreeting = "Hello! I'm Sona AI. How can I assist you today?",
  mode = "general",
}: VoiceCallModalProps) {
  const [status, setStatus] = useState<"connecting" | "listening" | "transcribing" | "thinking" | "speaking" | "ended">("connecting");
  const [transcript, setTranscript] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [availableVoices, setAvailableVoices] = useState<SpeechVoiceOption[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState<string>("");
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);

  // Recorder and Hardware Refs
  const recorderRef = useRef<MobileVoiceRecorder | null>(null);
  const isSpeakingRef = useRef(false);
  const isTranscribingRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  const isMutedRef = useRef(isMuted);
  const selectedVoiceNameRef = useRef(selectedVoiceName);
  const onSendMessageRef = useRef(onSendMessage);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const animSpeakingRef = useRef<number | null>(null);

  isOpenRef.current = isOpen;
  isMutedRef.current = isMuted;
  selectedVoiceNameRef.current = selectedVoiceName;
  onSendMessageRef.current = onSendMessage;

  // Complete hardware & audio teardown: guaranteed zero microphone leaks on call end
  const stopAllAudioAndHardware = useCallback(() => {
    if (recorderRef.current) {
      recorderRef.current.destroy();
      recorderRef.current = null;
    }

    if (animSpeakingRef.current) {
      cancelAnimationFrame(animSpeakingRef.current);
      animSpeakingRef.current = null;
    }

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    isSpeakingRef.current = false;
    isTranscribingRef.current = false;
    setAudioLevel(0);
  }, []);

  // Handle user-initiated End Call
  const handleEndCall = useCallback(() => {
    stopAllAudioAndHardware();
    setStatus("ended");
    onClose();
  }, [stopAllAudioAndHardware, onClose]);

  // Load voices on mount
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    function updateVoices() {
      const v = getPremiumVoices();
      setAvailableVoices(v);
      if (v.length > 0 && !selectedVoiceNameRef.current) {
        setSelectedVoiceName(v[0].id);
        selectedVoiceNameRef.current = v[0].id;
      }
    }
    updateVoices();
    window.speechSynthesis.onvoiceschanged = updateVoices;
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);

  // Forward ref declaration for turn-taking
  const startListeningLoopRef = useRef<() => void>(() => {});
  const finalizeAndTranscribeRef = useRef<() => Promise<void>>(async () => {});

  // Text-to-speech synthesis helper with mobile natural pitch and speaking wave
  const speak = useCallback((text: string, onComplete?: () => void) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !isOpenRef.current) {
      onComplete?.();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.pitch = 1.0;
    utterance.lang = "en-US";

    const voice = getBestNaturalVoice(selectedVoiceNameRef.current);
    if (voice) {
      utterance.voice = voice;
    }

    isSpeakingRef.current = true;
    setStatus("speaking");

    // Dynamic wave animation during AI speech
    let waveStep = 0;
    const animateSpeakingWave = () => {
      if (!isSpeakingRef.current || !isOpenRef.current) return;
      waveStep += 0.08;
      const simulatedLvl = 0.28 + Math.sin(waveStep) * 0.2 + Math.cos(waveStep * 1.5) * 0.1;
      setAudioLevel(Math.max(0.1, Math.min(0.7, simulatedLvl)));
      animSpeakingRef.current = requestAnimationFrame(animateSpeakingWave);
    };
    animSpeakingRef.current = requestAnimationFrame(animateSpeakingWave);

    const finishSpeaking = () => {
      if (!isOpenRef.current) return;
      isSpeakingRef.current = false;
      if (animSpeakingRef.current) {
        cancelAnimationFrame(animSpeakingRef.current);
        animSpeakingRef.current = null;
      }
      setAudioLevel(0);

      setTimeout(() => {
        if (isOpenRef.current && !isMutedRef.current) {
          onComplete?.();
        }
      }, 250);
    };

    utterance.onend = finishSpeaking;
    utterance.onerror = finishSpeaking;

    window.speechSynthesis.speak(utterance);
  }, []);

  // Dispatch transcription to ultra-fast Whisper Turbo route (~150ms)
  const finalizeAndTranscribe = useCallback(async () => {
    if (isTranscribingRef.current || isSpeakingRef.current || !isOpenRef.current) return;

    if (!recorderRef.current || !recorderRef.current.getIsRecording()) return;

    isTranscribingRef.current = true;
    setStatus("transcribing");

    try {
      const result = await recorderRef.current.stop();
      if (!result || !result.blob || result.blob.size < 400) {
        // Accidental silence/click, resume listening
        isTranscribingRef.current = false;
        if (isOpenRef.current && !isMutedRef.current && !isSpeakingRef.current) {
          startListeningLoopRef.current();
        }
        return;
      }

      const formData = new FormData();
      formData.append("audio", result.blob, `live_call.${result.extension}`);

      const res = await fetch("/api/stt/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error("STT request failed");
      }

      const data = await res.json();
      const userText = (data.transcript || "").trim();

      if (!userText || !isOpenRef.current) {
        // No distinct speech detected, resume listening
        isTranscribingRef.current = false;
        if (isOpenRef.current && !isMutedRef.current && !isSpeakingRef.current) {
          startListeningLoopRef.current();
        }
        return;
      }

      // Valid user speech!
      setTranscript(userText);
      setStatus("thinking");

      // Send to AI for response
      const reply = await onSendMessageRef.current(userText);
      if (!isOpenRef.current) return;

      const replyText = typeof reply === "string" ? reply : "I understand. How else can I assist you?";
      setAiResponse(replyText);
      setTranscript("");

      // AI speaks the response, then auto-resumes listening
      speak(replyText, () => {
        if (isOpenRef.current && !isMutedRef.current) {
          startListeningLoopRef.current();
        }
      });
    } catch (err) {
      console.warn("[Voice Call] Turn error:", err);
      if (isOpenRef.current) {
        const errMsg = "I had trouble hearing that. Could you please say that again?";
        setAiResponse(errMsg);
        speak(errMsg, () => {
          if (isOpenRef.current && !isMutedRef.current) {
            startListeningLoopRef.current();
          }
        });
      }
    } finally {
      isTranscribingRef.current = false;
    }
  }, [speak]);
  finalizeAndTranscribeRef.current = finalizeAndTranscribe;

  // Start responsive listening loop with VAD
  const startListeningLoop = useCallback(async () => {
    if (typeof window === "undefined" || !isOpenRef.current || isMutedRef.current || isSpeakingRef.current) return;

    setStatus("listening");
    setTranscript("");

    try {
      if (!recorderRef.current) {
        recorderRef.current = new MobileVoiceRecorder({
          onAudioLevel: (lvl) => {
            if (isOpenRef.current && !isSpeakingRef.current && !isMutedRef.current) {
              setAudioLevel(lvl);
            }
          },
          enableVAD: true,
          silenceThreshold: 0.04,
          silenceDurationMs: 1400,
          minSpeechDurationMs: 650,
          onSpeechEnd: () => {
            finalizeAndTranscribeRef.current();
          },
        });
      }

      await recorderRef.current.start();
      setMicPermissionError(null);
    } catch (err: any) {
      console.warn("[Voice Call] Recorder start error:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setMicPermissionError("Microphone permission was denied. Please allow microphone access in your browser settings.");
      }
    }
  }, []);
  startListeningLoopRef.current = startListeningLoop;

  // Interrupt AI speech (Barge-In) or Push-To-Send
  const handleOrbClick = useCallback(() => {
    if (status === "speaking" || isSpeakingRef.current) {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      isSpeakingRef.current = false;
      if (animSpeakingRef.current) {
        cancelAnimationFrame(animSpeakingRef.current);
        animSpeakingRef.current = null;
      }
      setAiResponse("");
      if (!isMutedRef.current) {
        startListeningLoop();
      } else {
        setStatus("listening");
      }
    } else if (status === "listening" && !isMutedRef.current) {
      // Manual tap to send turn immediately
      finalizeAndTranscribe();
    }
  }, [status, startListeningLoop, finalizeAndTranscribe]);

  // Mute / Unmute handler
  const toggleMute = useCallback(() => {
    if (isMuted) {
      setIsMuted(false);
      isMutedRef.current = false;
      if (!isSpeakingRef.current) {
        startListeningLoop();
      }
    } else {
      setIsMuted(true);
      isMutedRef.current = true;
      if (recorderRef.current) {
        recorderRef.current.stop();
      }
      setAudioLevel(0);
    }
  }, [isMuted, startListeningLoop]);

  // Lifecycle when modal opens
  useEffect(() => {
    if (!isOpen) {
      stopAllAudioAndHardware();
      return;
    }

    setCallDuration(0);
    setMicPermissionError(null);
    setTranscript("");
    setIsMuted(false);
    isMutedRef.current = false;
    setStatus("speaking");
    const greeting = initialGreeting;
    setAiResponse(greeting);

    timerIntervalRef.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);

    // Initial greeting delivery -> auto-start conversational listening
    speak(greeting, () => {
      if (isOpenRef.current && !isMutedRef.current) {
        startListeningLoop();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleEndCall();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      stopAllAudioAndHardware();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const modeLabels: Record<string, { label: string; color: string }> = {
    general: { label: "General", color: "text-amber-300 border-amber-500/30 bg-amber-500/10" },
    student: { label: "Student", color: "text-sky-300 border-sky-500/30 bg-sky-500/10" },
    business: { label: "Business", color: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" },
    creator: { label: "Creator", color: "text-purple-300 border-purple-500/30 bg-purple-500/10" },
    reading: { label: "Reading", color: "text-rose-300 border-rose-500/30 bg-rose-500/10" },
  };

  const currentModeInfo = modeLabels[mode] || modeLabels.general;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Live Voice Call"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-2xl p-0 sm:p-4 animate-in fade-in duration-300 select-none"
    >
      <div className="relative flex h-full sm:h-[650px] w-full sm:max-w-md flex-col justify-between rounded-none sm:rounded-3xl border-0 sm:border sm:border-white/10 bg-gradient-to-b from-[#0b0f19] via-[#080b12] to-[#04060a] p-5 sm:p-6 shadow-2xl overflow-hidden backdrop-blur-3xl">
        
        {/* Dynamic Multi-Color Ambient Glow in the background */}
        <div
          className={`pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 h-80 w-80 rounded-full blur-[110px] transition-all duration-1000 ${
            status === "speaking"
              ? "bg-amber-500/25"
              : status === "transcribing" || status === "thinking"
              ? "bg-indigo-500/30"
              : isMuted
              ? "bg-rose-500/20"
              : "bg-emerald-500/25"
          }`}
        />

        {/* 1. Header Bar */}
        <header className="relative z-20 flex w-full items-center justify-between gap-2 shrink-0 pt-1 sm:pt-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-ink-900 border border-white/10 shadow-inner overflow-hidden">
              <Image src="/logo.png" alt="Sona" width={20} height={20} className="rounded-md" />
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-display text-sm font-semibold tracking-tight text-white truncate">
                  Sona Live
                </span>
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${currentModeInfo.color}`}>
                  {currentModeInfo.label}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/10 bg-ink-900/80 backdrop-blur-md shadow-sm">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
              </span>
              <span className="font-mono text-[11px] font-medium text-paper-200">{formatTime(callDuration)}</span>
            </div>

            {availableVoices.length > 0 && (
              <div className="relative">
                <select
                  value={selectedVoiceName}
                  onChange={(e) => {
                    setSelectedVoiceName(e.target.value);
                    selectedVoiceNameRef.current = e.target.value;
                    if (status === "speaking" && aiResponse) {
                      speak(aiResponse);
                    }
                  }}
                  aria-label="Voice style"
                  className="h-7 rounded-full border border-white/10 bg-ink-900/90 px-2 text-[11px] text-paper-200 outline-none focus:border-signal/60 max-w-[90px] sm:max-w-[120px] truncate cursor-pointer hover:bg-ink-800 transition-colors"
                >
                  {availableVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              onClick={handleEndCall}
              aria-label="Close voice call"
              title="Close voice call (Esc)"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-ink-900/80 text-paper-300 hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-500/40 transition-all shrink-0"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        {/* 2. Interactive Voice Stage & Dynamic Living Orb */}
        <div className="relative z-10 flex flex-col items-center justify-center my-auto w-full px-2">
          {micPermissionError && (
            <div className="mb-3 rounded-xl border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 text-center animate-in fade-in">
              {micPermissionError}
            </div>
          )}

          <div className="relative flex items-center justify-center my-6 sm:my-8">
            {/* Outer Ripple 1 */}
            <div
              style={{
                transform: `scale(${1 + audioLevel * 0.45})`,
                opacity: status === "listening" && !isMuted ? 0.6 + audioLevel * 0.4 : status === "speaking" ? 0.45 : 0.1,
              }}
              className={`absolute h-48 w-48 sm:h-56 sm:w-56 rounded-full border transition-transform duration-75 ease-out ${
                status === "speaking"
                  ? "border-amber-400/30"
                  : status === "transcribing" || status === "thinking"
                  ? "border-indigo-400/30"
                  : isMuted
                  ? "border-rose-500/20"
                  : "border-emerald-400/30"
              }`}
            />

            {/* Outer Ripple 2 */}
            <div
              style={{
                transform: `scale(${1 + audioLevel * 0.75})`,
                opacity: status === "listening" && !isMuted ? 0.35 + audioLevel * 0.45 : status === "speaking" ? 0.25 : 0.05,
              }}
              className={`absolute h-60 w-60 sm:h-68 sm:w-68 rounded-full border transition-transform duration-100 ease-out ${
                status === "speaking"
                  ? "border-amber-400/20"
                  : status === "transcribing" || status === "thinking"
                  ? "border-indigo-400/20"
                  : isMuted
                  ? "border-rose-500/15"
                  : "border-emerald-400/20"
              }`}
            />

            {/* Main Interactive Orb */}
            <button
              onClick={handleOrbClick}
              title={
                status === "speaking"
                  ? "Tap to interrupt Sona AI"
                  : status === "listening"
                  ? "Tap to send speech now"
                  : undefined
              }
              className={`group relative flex h-36 w-36 sm:h-40 sm:w-40 items-center justify-center rounded-full border shadow-2xl transition-all duration-300 select-none ${
                status === "speaking"
                  ? "border-amber-400/40 bg-gradient-to-tr from-amber-600 via-amber-400 to-yellow-200 text-ink-950 scale-105 shadow-amber-500/40 hover:scale-100 active:scale-95 cursor-pointer ring-4 ring-amber-400/20"
                  : status === "transcribing" || status === "thinking"
                  ? "border-indigo-400/40 bg-gradient-to-tr from-indigo-700 via-purple-500 to-pink-400 text-white scale-100 shadow-indigo-500/35 ring-4 ring-indigo-400/20 animate-pulse"
                  : isMuted
                  ? "border-rose-500/40 bg-gradient-to-tr from-rose-950 via-ink-900 to-rose-900 text-rose-400 scale-95 shadow-rose-500/20"
                  : "border-emerald-400/40 bg-gradient-to-tr from-emerald-600 via-teal-400 to-cyan-300 text-ink-950 scale-100 shadow-emerald-500/35 ring-4 ring-emerald-400/20 active:scale-95 cursor-pointer"
              }`}
            >
              <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/30 to-transparent pointer-events-none" />

              {status === "speaking" ? (
                <div className="relative flex flex-col items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="h-5 w-1.5 rounded-full bg-ink-950 animate-bounce" />
                    <span className="h-9 w-1.5 rounded-full bg-ink-950 animate-bounce [animation-delay:0.15s]" />
                    <span className="h-11 w-1.5 rounded-full bg-ink-950 animate-bounce [animation-delay:0.3s]" />
                    <span className="h-7 w-1.5 rounded-full bg-ink-950 animate-bounce [animation-delay:0.45s]" />
                    <span className="h-4 w-1.5 rounded-full bg-ink-950 animate-bounce [animation-delay:0.6s]" />
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-ink-950/80">
                    Tap to Stop
                  </span>
                </div>
              ) : status === "transcribing" || status === "thinking" ? (
                <div className="relative flex flex-col items-center gap-1.5">
                  <svg className="animate-spin h-7 w-7 text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/90">
                    {status === "transcribing" ? "Transcribing" : "Thinking"}
                  </span>
                </div>
              ) : (
                <div className="relative flex flex-col items-center justify-center">
                  {isMuted ? (
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
                      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                      <line x1="12" y1="19" x2="12" y2="22" />
                    </svg>
                  ) : (
                    <div className="relative flex flex-col items-center gap-1">
                      <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                      {audioLevel > 0.05 && (
                        <span className="text-[9px] font-bold uppercase tracking-wider text-ink-950/80">
                          Tap to Send
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </button>
          </div>

          {/* Status Capsule Badge */}
          <div className="flex items-center justify-center">
            <span
              className={`inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-medium border backdrop-blur-md shadow-sm transition-all ${
                status === "speaking"
                  ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                  : status === "transcribing" || status === "thinking"
                  ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
                  : isMuted
                  ? "bg-rose-500/10 text-rose-300 border-rose-500/30"
                  : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  status === "speaking"
                    ? "bg-amber-400 animate-pulse"
                    : status === "transcribing" || status === "thinking"
                    ? "bg-indigo-400 animate-spin"
                    : isMuted
                    ? "bg-rose-400"
                    : "bg-emerald-400 animate-pulse"
                }`}
              />
              {status === "speaking" && "Sona AI is speaking…"}
              {status === "transcribing" && "Understanding audio…"}
              {status === "thinking" && "Sona AI is thinking…"}
              {status === "listening" && (isMuted ? "Microphone is muted" : "Listening to you…")}
              {status === "connecting" && "Connected"}
            </span>
          </div>

          {/* 3. Live Speech Subtitle Card */}
          <div className="mt-4 w-full max-w-sm min-h-[68px] flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl px-4 py-2.5 text-center shadow-inner">
            {(status === "listening" || status === "transcribing" || status === "thinking") && transcript && (
              <p className="text-xs sm:text-sm italic text-white animate-in fade-in line-clamp-3 leading-relaxed">
                <span className="text-emerald-400 font-semibold not-italic mr-1.5">You:</span>
                “{transcript}”
              </p>
            )}

            {status === "speaking" && aiResponse && (
              <p className="text-xs sm:text-sm text-paper-100 animate-in fade-in line-clamp-3 leading-relaxed">
                <span className="text-amber-400 font-semibold mr-1.5">Sona:</span>
                “{aiResponse}”
              </p>
            )}

            {status === "listening" && !transcript && (
              <p className="text-xs text-paper-400 leading-relaxed">
                {isMuted
                  ? "Microphone is muted. Tap Unmute below to talk."
                  : "Speak naturally. Sona AI detects pauses and responds automatically."}
              </p>
            )}

            {(status === "transcribing" || status === "thinking") && !transcript && (
              <p className="text-xs text-indigo-300 animate-pulse leading-relaxed">
                Processing speech...
              </p>
            )}
          </div>
        </div>

        {/* 4. Bottom Call Controls Dock */}
        <footer className="relative z-20 flex w-full items-center justify-center gap-3 pt-3 pb-2 sm:pb-0 shrink-0">
          <button
            onClick={toggleMute}
            aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            title={isMuted ? "Unmute microphone" : "Mute microphone"}
            className={`flex h-12 w-12 items-center justify-center rounded-full border transition-all duration-200 shadow-lg ${
              isMuted
                ? "border-rose-500 bg-rose-500/20 text-rose-300 ring-2 ring-rose-500/40"
                : "border-white/15 bg-ink-900/90 text-paper-200 hover:bg-ink-800 hover:text-white"
            }`}
          >
            {isMuted ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            )}
          </button>

          {status === "speaking" && (
            <button
              onClick={handleOrbClick}
              aria-label="Interrupt AI"
              title="Interrupt and speak"
              className="flex h-12 px-4 items-center justify-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-all text-xs font-semibold shadow-md animate-in fade-in"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
              <span>Interrupt</span>
            </button>
          )}

          <button
            onClick={handleEndCall}
            aria-label="End call"
            title="End call (Esc)"
            className="flex h-12 px-6 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-rose-600 to-red-600 text-white font-medium text-sm hover:from-rose-500 hover:to-red-500 transition-all shadow-lg shadow-rose-600/35 active:scale-95"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.8 19.8 0 0 1-3.12-8.68A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
              <line x1="23" y1="1" x2="1" y2="23" />
            </svg>
            <span>End Call</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
