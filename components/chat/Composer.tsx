"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import UploadPreview from "@/components/upload/UploadPreview";

const ACCEPTED = ".pdf,.docx,.txt,.md";

export default function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string, file: File | null) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mobile voice recorder ref
  const recorderRef = useRef<any>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recorderRef.current) {
        recorderRef.current.destroy();
        recorderRef.current = null;
      }
    };
  }, []);

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (picked) setFile(picked);
    e.target.value = "";
  }

  function handleSend() {
    if (!text.trim() && !file) return;
    if (isListening) {
      stopVoiceInput();
    }
    onSend(text.trim(), file);
    setText("");
    setFile(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Transcribe recorded audio chunk via ultra-fast server route
  const transcribeAudioBlob = async (audioBlob: Blob, ext = "webm") => {
    if (audioBlob.size < 300) return; // ignore accidental empty tap

    setIsTranscribing(true);
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, `voice_input.${ext}`);

      const res = await fetch("/api/stt/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Transcription request failed");
      }

      const data = await res.json();
      if (data.transcript && data.transcript.trim()) {
        const clean = data.transcript.trim();
        setText((prev) => (prev ? `${prev} ${clean}` : clean));
      }
    } catch (err) {
      console.warn("[Composer Voice] Server STT notice:", err);
    } finally {
      setIsTranscribing(false);
    }
  };

  const stopVoiceInput = useCallback(async () => {
    setIsListening(false);
    setAudioLevel(0);
    if (recorderRef.current) {
      const result = await recorderRef.current.stop();
      if (result && result.blob) {
        await transcribeAudioBlob(result.blob, result.extension);
      }
    }
  }, []);

  const startVoiceInput = async () => {
    if (typeof window === "undefined") return;

    try {
      const { MobileVoiceRecorder } = await import("@/lib/services/audioRecorder");
      
      if (!recorderRef.current) {
        recorderRef.current = new MobileVoiceRecorder({
          onAudioLevel: (lvl) => setAudioLevel(lvl),
          enableVAD: true,
          silenceDurationMs: 1500,
          onSpeechEnd: () => {
            stopVoiceInput();
          },
        });
      }

      await recorderRef.current.start();
      setIsListening(true);
    } catch (err: any) {
      console.warn("[Composer] Mic recording notice:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        alert("Please allow microphone access in your browser settings to use voice typing.");
      }
      setIsListening(false);
      setAudioLevel(0);
    }
  };

  function toggleVoiceInput() {
    if (isListening) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  }

  return (
    <div className="sticky bottom-0 z-20 w-full border-t border-line/60 bg-ink-950/95 backdrop-blur-glass px-3 py-3 sm:px-4">
      <div className="mx-auto max-w-3xl">
        {file && <UploadPreview file={file} onRemove={() => setFile(null)} />}

        <div className="glass-panel flex items-end gap-2 p-1.5 sm:p-2">
          {/* File Attachment Button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="Upload file"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line hover:bg-ink-700 disabled:opacity-50 text-paper-200 transition-colors"
            title="Attach document"
          >
            +
          </button>
          <input ref={fileInputRef} type="file" accept={ACCEPTED} onChange={handleFilePick} className="hidden" />

          {/* Voice Microphone Input Button */}
          <button
            type="button"
            onClick={toggleVoiceInput}
            disabled={disabled || isTranscribing}
            aria-label={isListening ? "Stop voice input" : "Start voice input"}
            title={
              isTranscribing
                ? "Transcribing..."
                : isListening
                ? "Listening... (tap to finish)"
                : "Voice typing"
            }
            style={isListening ? { transform: `scale(${1 + Math.min(0.25, audioLevel * 0.4)})` } : undefined}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all duration-75 ${
              isListening
                ? "border-red-500 bg-red-500/20 text-red-400 shadow-md shadow-red-500/30 ring-2 ring-red-500/40"
                : isTranscribing
                ? "border-amber-500/50 bg-amber-500/20 text-amber-400 animate-spin"
                : "border-line text-paper-200 hover:bg-ink-700 hover:text-paper-100"
            } disabled:opacity-50`}
          >
            {isTranscribing ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            )}
          </button>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            placeholder={
              isTranscribing
                ? "Transcribing your voice..."
                : isListening
                ? "Listening... (tap mic icon when done speaking)"
                : "What would you like to understand today?"
            }
            className="max-h-36 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-paper-100 outline-none placeholder:text-paper-300/60"
          />

          <button
            onClick={handleSend}
            disabled={disabled || (!text.trim() && !file) || isTranscribing}
            aria-label="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal text-ink-950 disabled:opacity-40 hover:bg-signal-soft transition-colors font-bold"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

