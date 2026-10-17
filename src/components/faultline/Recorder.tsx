"use client";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/faultline";

export function Recorder() {
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [download, setDownload] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const interval = setInterval(() => setSeconds((n) => n + 1), 1000);
    const timeout = setTimeout(() => recorder.current?.state === "recording" && recorder.current.stop(), 60_000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [recording]);
  useEffect(() => () => { stream.current?.getTracks().forEach((t) => t.stop()); }, []);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download); }, [download]);
  async function start() {
    setError("");
    try {
      if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") throw new Error("Screen recording requires Chrome/Edge or a supported desktop browser.");
      const capture = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      stream.current = capture;
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4"].find((v) => MediaRecorder.isTypeSupported(v));
      const mediaRecorder = new MediaRecorder(capture, mimeType ? { mimeType } : {});
      const chunks: BlobPart[] = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        setDownload(URL.createObjectURL(new Blob(chunks, { type: mediaRecorder.mimeType })));
        setRecording(false); capture.getTracks().forEach((t) => t.stop());
      };
      capture.getVideoTracks()[0]?.addEventListener("ended", () => { if (mediaRecorder.state === "recording") mediaRecorder.stop(); });
      recorder.current = mediaRecorder; setSeconds(0); setRecording(true); mediaRecorder.start(1000);
    } catch (err) { setError(errorMessage(err)); stream.current?.getTracks().forEach((t) => t.stop()); }
  }
  return <div className="fl-recording">
    <button className="fl-button fl-button-secondary" onClick={() => recording ? recorder.current?.stop() : void start()}>{recording ? `Stop recording · ${seconds}s / 60s` : "Record 60-second demo"}</button>
    {download && <a className="fl-text-link" href={download} download={`faultline-demo-${Date.now()}.${recorder.current?.mimeType.includes("mp4") ? "mp4" : "webm"}`}>Download actual recording</a>}
    {error && <p className="fl-error" role="alert">{error}</p>}
  </div>;
}
