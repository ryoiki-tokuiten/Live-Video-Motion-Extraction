/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'preact';
import { useRef, useState, useEffect, useCallback } from 'preact/hooks';
import { html } from 'htm/preact';
import { MotionEngine, MotionControls } from './gl/motion-engine';

const App = () => {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [isWebcam, setIsWebcam] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 640, height: 360 });
  const [isRecording, setIsRecording] = useState(false);
  const [gpuInfo, setGpuInfo] = useState<string>('');

  // Default controls
  const [controls, setControls] = useState<MotionControls>({
    detectionMode: 'color', // 'color', 'luminance'
    detectionThreshold: 15.0,
    processingResolution: 1.0, // GPU can handle 100% easily
    noiseReduction: 0,
    adaptationRate: 0.05,
    morphology: 'open', // 'none', 'open', 'close'
    effect: 'classic', // 'classic', 'colorBurn', 'electricTrails', 'heatmap', 'chromatic'
    invert: false,
    persistence: 0.85,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  // sourceCanvasRef is no longer strictly needed for processing, but good for visualization if we want to show raw input?
  // Actually, let's keep it to show "Source" vs "Motion".
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const motionCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MotionEngine | null>(null);
  const animationFrameId = useRef<number>();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const handleControlChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const value =
      target.type === 'checkbox'
        ? target.checked
        : target.type === 'range'
          ? Number(target.value)
          : target.value;

    const newControls = { ...controls, [target.id]: value };

    if (target.id === 'detectionMode') {
      if (value === 'color') {
        newControls.detectionThreshold = 15.0;
      } else {
        newControls.detectionThreshold = 2.5;
      }
    }

    setControls(newControls as MotionControls);
  };

  const startWebcam = async () => {
    try {
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream)
          .getTracks()
          .forEach((track) => track.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, // Request HD for GPU power!
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.src = '';
        setIsWebcam(true);
        setSourceUrl(null);
      }
    } catch (err) {
      console.error('Error accessing webcam:', err);
      alert('Could not access the webcam. Please ensure permissions are granted.');
    }
  };

  const handleFileUpload = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      const file = target.files[0];
      const url = URL.createObjectURL(file);
      setIsWebcam(false);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream)
          .getTracks()
          .forEach((track) => track.stop());
        videoRef.current.srcObject = null;
      }
      setSourceUrl(url);
    }
  };

  const startRecording = () => {
    if (!motionCanvasRef.current) return;
    if (isRecording) return;

    const stream = motionCanvasRef.current.captureStream(60); // 60 FPS for GPU smoothness
    mediaRecorderRef.current = new MediaRecorder(stream, {
      mimeType: 'video/webm; codecs=vp9',
      videoBitsPerSecond: 5000000 // High quality
    });

    recordedChunksRef.current = [];

    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    mediaRecorderRef.current.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      document.body.appendChild(a);
      a.style.display = 'none';
      a.href = url;
      a.download = 'motion-extract-gpu.webm';
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      recordedChunksRef.current = [];
    };

    mediaRecorderRef.current.start();
    setIsRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  // Initialize Engine
  useEffect(() => {
    if (motionCanvasRef.current && !engineRef.current) {
      try {
        engineRef.current = new MotionEngine(motionCanvasRef.current);
        setGpuInfo(engineRef.current.getGPUInfo());
        console.log("MotionEngine initialized (GPU)");
      } catch (e) {
        console.error("Failed to init MotionEngine:", e);
        alert("WebGL 2 not supported! Browser too old?");
      }
    }
  }, []);

  const draw = useCallback(() => {
    const video = videoRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    const engine = engineRef.current;

    if (!video || !sourceCanvas || !engine || video.ended || video.readyState < 2) {
      animationFrameId.current = requestAnimationFrame(draw);
      return;
    }

    // Draw source for visualization (optional, CPU bound but lightweight usually)
    const sourceCtx = sourceCanvas.getContext('2d');
    if (sourceCtx) {
      // Only draw if we want to see the source side-by-side
      sourceCtx.drawImage(video, 0, 0, dimensions.width, dimensions.height);
    }

    // Run GPU Engine
    // Note: Engine handles its own context
    try {
      if (!engine['isInitialized']) { // Hacky check or public getter? 
        // We called init in useEffect? No, we need to call init with dimensions.
        // See playback init effect below.
      } else {
        engine.render(video, controls);
      }
    } catch (e) {
      console.error("Render error:", e);
    }

    animationFrameId.current = requestAnimationFrame(draw);
  }, [dimensions, controls]);

  // Effect to manage video source lifecycle
  useEffect(() => {
    const video = videoRef.current;
    const engine = engineRef.current;

    if (!video || (!sourceUrl && !isWebcam)) return;

    if (sourceUrl) {
      video.src = sourceUrl;
    }

    // Cleanup previous listener
    video.onloadedmetadata = null;
    video.oncanplay = null;

    let hasInitialized = false;
    const initPlayback = () => {
      if (hasInitialized || !video) return;
      hasInitialized = true;

      const vWidth = video.videoWidth || 640;
      const vHeight = video.videoHeight || 360;
      const aspectRatio = vWidth / vHeight;
      const displayWidth = 640;
      // Keep display size manageable for UI, but internal resolution can be higher
      setDimensions({ width: displayWidth, height: displayWidth / aspectRatio });

      // Init Engine with VIDEO dimensions for max quality, or DISPLAY dimensions?
      // For "insane speed", let's use full video resolution if possible, or a high capped one.
      // Let's us the display dimensions for now to match canvas size.
      // Or better: Use the video's native resolution for processing!
      // But we need to fit in the canvas.
      // Let's stick to dimensions state.

      if (engine) {
        engine.init(displayWidth, displayWidth / aspectRatio); // Init/Resize
      }

      video.play().catch(e => {
        if (e.name !== 'AbortError') {
          console.error("Error playing video:", e);
        }
      });
    };

    video.onloadedmetadata = initPlayback;
    video.oncanplay = initPlayback;
    if (video.readyState >= 2) initPlayback();

    return () => {
      if (video) {
        video.onloadedmetadata = null;
        video.oncanplay = null;
      }
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl, isWebcam]); // engineRef is stable

  // Resize Engine if dimensions change
  useEffect(() => {
    if (engineRef.current && dimensions.width > 0) {
      engineRef.current.resize(dimensions.width, dimensions.height);
    }
  }, [dimensions]);


  // Rendering Loop
  useEffect(() => {
    if (animationFrameId.current) {
      cancelAnimationFrame(animationFrameId.current);
    }

    if (sourceUrl || isWebcam) {
      animationFrameId.current = requestAnimationFrame(draw);
    }

    return () => {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, [draw, sourceUrl, isWebcam]);

  return html`
    <div class="sidebar">
      <div class="sidebar-header">GPU Controls</div>
      <fieldset>
        <legend>Source</legend>
        <div class="button-group">
          <label for="video-upload" class="btn">Upload Video</label>
          <input id="video-upload" type="file" accept="video/*" onChange=${handleFileUpload} />
          <button class="btn secondary" onClick=${startWebcam}>Use Webcam (HD)</button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Algorithm</legend>
        <div class="control-group">
            <label for="detectionMode">Detection Mode</label>
            <select id="detectionMode" value=${controls.detectionMode} onChange=${handleControlChange}>
                <option value="color">Color (Robust)</option>
                <option value="luminance">Luminance (Fast)</option>
            </select>
        </div>
      </fieldset>

      <fieldset>
        <legend>Detection</legend>
        <div class="control-group">
          <label for="detectionThreshold">
            Threshold: ${controls.detectionThreshold.toFixed(1)}
          </label>
          <input 
            id="detectionThreshold" 
            type="range" 
            min="1.0" 
            max="50.0"
            step="0.1" 
            value=${controls.detectionThreshold} 
            onInput=${handleControlChange} />
        </div>
        <div class="control-group">
          <label for="adaptationRate">Adaptation Speed: ${Math.round(controls.adaptationRate * 1000)}</label>
          <input id="adaptationRate" type="range" min="0.001" max="0.5" step="0.001" value=${controls.adaptationRate} onInput=${handleControlChange} />
        </div>
        <!-- Resolution is now typically fixed to canvas size for GPU, but we could add scaling if needed. Removed for simplicity as GPU is fast. -->
        <div class="control-group">
          <label for="morphology">Cleanup Filter (GPU)</label>
          <select id="morphology" value=${controls.morphology} onChange=${handleControlChange}>
            <option value="none">None</option>
            <option value="open">Clean Noise</option>
            <option value="close">Fill Gaps</option>
          </select>
        </div>
      </fieldset>

      <fieldset>
        <legend>Effects</legend>
        <div class="control-group">
          <label for="effect">Style</label>
          <select id="effect" value=${controls.effect} onChange=${handleControlChange}>
            <option value="classic">Classic</option>
            <option value="colorBurn">Color Burn</option>
            <option value="electricTrails">Electric Trails</option>
            <option value="heatmap">Motion Heatmap</option>
            <option value="chromatic">Chromatic Aberration</option>
          </select>
        </div>
        <div class="toggle-switch">
          <span class="toggle-label">Invert Colors</span>
          <label class="switch">
            <input id="invert" type="checkbox" checked=${controls.invert} onChange=${handleControlChange} />
            <span class="slider"></span>
          </label>
        </div>
      </fieldset>
      
      <fieldset>
        <legend>Output</legend>
        <button class="btn ${isRecording ? 'recording' : ''}" onClick=${isRecording ? stopRecording : startRecording}>
          ${isRecording ? 'Stop Recording' : 'Start Recording'}
        </button>
      </fieldset>
    </div>

    <main>
      ${!sourceUrl && !isWebcam && html`
        <div class="message">
          <h1>GPU Motion Extractor</h1>
          <p>Powered by WebGL 2.0. Upload a video or use webcam to see "Insane Speed".</p>
          <p style="font-size: 0.8em; opacity: 0.7; margin-top: 10px;">Hardware: ${gpuInfo}</p>
        </div>
      `}
      <div class="canvas-container" style=${{ display: sourceUrl || isWebcam ? 'flex' : 'none' }}>
        <div class="canvas-wrapper">
          <h2>Source</h2>
          <canvas ref=${sourceCanvasRef} width=${dimensions.width} height=${dimensions.height}></canvas>
        </div>
        <div class="canvas-wrapper">
          <h2>Motion (GL)</h2>
          <canvas ref=${motionCanvasRef} width=${dimensions.width} height=${dimensions.height}></canvas>
        </div>
      </div>
    </main>

    <video ref=${videoRef} class="hidden" loop muted playsinline></video>
  `;
};

render(html`<${App} />`, document.getElementById('app') as HTMLElement);