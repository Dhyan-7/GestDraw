// ===== GestDraw — Gesture-Based Doodler =====
// A gesture-based drawing app using MediaPipe hand tracking

// ===== Application State =====
const state = {
  handLandmarker: null,
  webcamStream: null,
  isReady: false,
  strokes: [],
  currentStroke: null,
  activeColor: "#00f0ff",
  thickness: 6,
  glowIntensity: 60,
  currentGesture: "idle",
  previousGesture: "idle",
  gestureStableFrames: 0,
  gestureStartTime: 0,
  isModalOpen: true,
  isGrabbing: false,
  grabStartPos: null,
  grabOffset: { x: 0, y: 0 },
  totalOffset: { x: 0, y: 0 },
  nearestStrokeIdx: -1,
  eraserRadius: 28,
  showCamera: true,
  cameraOpacity: 0.35,
  particles: [],
  smoothPos: { x: 0, y: 0 },
  smoothFactor: 0.35,
  width: 0,
  height: 0,
  audioCtx: null,
};

// ===== DOM References =====
const $ = (id) => document.getElementById(id);

const loadingScreen = $("loading-screen");
const appContainer = $("app");
const webcamVideo = $("webcam");
const cameraCanvas = $("camera-canvas");
const drawingCanvas = $("drawing-canvas");
const uiCanvas = $("ui-canvas");

const cameraCtx = cameraCanvas.getContext("2d");
const drawCtx = drawingCanvas.getContext("2d");
const uiCtx = uiCanvas.getContext("2d");

const gestureHud = $("gesture-hud");
const gestureIcon = $("gesture-icon");
const gestureLabel = $("gesture-label");

const thicknessSlider = $("thickness-slider");
const thicknessValue = $("thickness-value");
const glowSlider = $("glow-slider");
const glowValue = $("glow-value");

const cameraModeText = $("camera-mode-text");
const cameraModeIndicator = $("camera-mode-indicator");
const onboardingModal = $("onboarding-modal");
const btnStart = $("btn-start");

// ===== Audio System =====
function getAudioCtx() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioCtx;
}

function playTone(freq, duration, type = "sine", vol = 0.06) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {
    // Audio not supported
  }
}

function soundDrawStart() { playTone(880, 0.08, "sine", 0.04); }
function soundDrawEnd() { playTone(440, 0.1, "sine", 0.03); }
function soundErase() { playTone(200, 0.06, "triangle", 0.03); }
function soundGrabStart() { playTone(660, 0.1, "sine", 0.05); }
function soundGrabEnd() { playTone(330, 0.15, "sine", 0.04); }
function soundClick() { playTone(1200, 0.05, "sine", 0.03); }

// ===== Canvas Sizing =====
function resizeCanvases() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  state.width = w;
  state.height = h;
  [cameraCanvas, drawingCanvas, uiCanvas].forEach((c) => {
    c.width = w;
    c.height = h;
  });
}

window.addEventListener("resize", () => {
  resizeCanvases();
  redrawStrokes();
});

// ===== MediaPipe Hand Landmarker =====
async function initHandTracking() {
  const { FilesetResolver, HandLandmarker } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs"
  );

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );

  state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });

  return true;
}

// ===== Webcam Setup =====
async function initWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
    },
  });
  webcamVideo.srcObject = stream;
  state.webcamStream = stream;
  return new Promise((resolve) => {
    webcamVideo.onloadedmetadata = () => {
      webcamVideo.play();
      resolve();
    };
  });
}

// ===== Gesture Detection =====
function detectGesture(landmarks) {
  if (!landmarks || landmarks.length === 0) return "none";

  const lm = landmarks;
  const thumbTip = lm[4];
  const thumbIP = lm[3];
  const indexTip = lm[8];
  const indexMCP = lm[6];
  const middleTip = lm[12];
  const middleMCP = lm[10];
  const ringTip = lm[16];
  const ringMCP = lm[14];
  const pinkyTip = lm[20];
  const pinkyMCP = lm[18];

  const indexUp = indexTip.y < indexMCP.y - 0.02;
  const middleDown = middleTip.y > middleMCP.y;
  const ringDown = ringTip.y > ringMCP.y;
  const pinkyDown = pinkyTip.y > pinkyMCP.y;
  const middleUp = middleTip.y < middleMCP.y;
  const ringUp = ringTip.y < ringMCP.y;
  const pinkyUp = pinkyTip.y < pinkyMCP.y;
  const thumbOut = Math.abs(thumbTip.x - thumbIP.x) > 0.03 || thumbTip.y < thumbIP.y;

  // Pinch: thumb tip close to index tip
  const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
  if (pinchDist < 0.06 && !middleUp && !ringUp && !pinkyUp) return "pinch";

  // Open palm: all fingers extended
  if (indexUp && middleUp && ringUp && pinkyUp && thumbOut) return "open_palm";

  // Index finger: only index pointing up
  if (indexUp && middleDown && ringDown && pinkyDown) return "index_finger";

  // Fist: all fingers curled
  if (!indexUp && !middleUp && !ringUp && !pinkyUp) return "fist";

  return "idle";
}

// ===== Gesture Stabilization =====
function stabilizeGesture(rawGesture) {
  if (rawGesture === state.currentGesture) {
    state.previousGesture = rawGesture;
    state.gestureStableFrames = 0;
    return state.currentGesture;
  }

  if (rawGesture === state.previousGesture) {
    state.gestureStableFrames++;
  } else {
    state.previousGesture = rawGesture;
    state.gestureStableFrames = 1;
  }

  const threshold = rawGesture === "pinch" ? 3 : 4;

  if (state.gestureStableFrames >= threshold) {
    const prev = state.currentGesture;
    state.currentGesture = rawGesture;
    state.gestureStableFrames = 0;
    state.gestureStartTime = Date.now();
    if (prev !== rawGesture) {
      onGestureTransition(prev, rawGesture);
    }
    return rawGesture;
  }

  return state.currentGesture;
}

// ===== Gesture Transition Handling =====
function onGestureTransition(from, to) {
  // Play sounds
  if (to === "index_finger") soundDrawStart();
  else if (to === "open_palm") soundClick();
  else if (to === "pinch") soundGrabStart();
  else if (from === "index_finger") soundDrawEnd();

  // End current stroke if leaving drawing mode
  if (from === "index_finger" && state.currentStroke) {
    if (state.currentStroke.points.length > 1) {
      state.strokes.push({ ...state.currentStroke });
    }
    state.currentStroke = null;
  }

  // End grab if leaving pinch mode
  if (from === "pinch") endGrab();

  updateGestureHUD(to);
}

// ===== Gesture HUD Update =====
function updateGestureHUD(gesture) {
  const map = {
    index_finger: { icon: "☝️", label: "Drawing", cls: "drawing" },
    open_palm: { icon: "✋", label: "Erasing", cls: "erasing" },
    pinch: { icon: "🤏", label: "Grab", cls: "grabbing" },
    fist: { icon: "✊", label: "Idle", cls: "" },
    idle: { icon: "🖐️", label: "Ready", cls: "" },
    none: { icon: "👋", label: "Show hand", cls: "" },
  };
  const info = map[gesture] || map.idle;
  gestureIcon.textContent = info.icon;
  gestureLabel.textContent = info.label;
  gestureHud.className = info.cls;
}

// ===== Coordinate Conversion =====
function landmarkToCanvas(landmark) {
  return {
    x: (1 - landmark.x) * state.width,
    y: landmark.y * state.height,
  };
}

function smoothPosition(pos) {
  state.smoothPos.x += (pos.x - state.smoothPos.x) * state.smoothFactor;
  state.smoothPos.y += (pos.y - state.smoothPos.y) * state.smoothFactor;
  return { x: state.smoothPos.x, y: state.smoothPos.y };
}

// ===== Drawing Mode =====
function handleDrawing(landmarks) {
  const indexTip = landmarks[8];
  const raw = landmarkToCanvas(indexTip);
  const pos = smoothPosition(raw);

  // Grace period after gesture starts
  if (Date.now() - state.gestureStartTime < 300) {
    state.smoothPos = { ...raw };
    return;
  }

  if (state.currentStroke) {
    state.currentStroke.points.push({ ...pos });
  } else {
    state.currentStroke = {
      points: [pos],
      color: state.activeColor,
      thickness: state.thickness,
      glow: state.glowIntensity,
    };
    state.smoothPos = { ...raw };
  }

  spawnParticles(pos.x, pos.y, state.activeColor);
  redrawStrokes();
}

// ===== Erasing Mode =====
function handleErasing(landmarks) {
  const wrist = landmarks[0];
  const midBase = landmarks[9];
  const center = {
    x: (1 - (wrist.x + midBase.x) / 2) * state.width,
    y: ((wrist.y + midBase.y) / 2) * state.height,
  };
  const radius = state.eraserRadius;
  let erased = false;

  const surviving = [];
  for (let i = 0; i < state.strokes.length; i++) {
    const stroke = state.strokes[i];
    const segments = [];
    let current = [];

    for (const pt of stroke.points) {
      const dx = pt.x - center.x;
      const dy = pt.y - center.y;
      if (Math.sqrt(dx * dx + dy * dy) >= radius) {
        current.push(pt);
      } else {
        erased = true;
        if (current.length >= 2) segments.push(current);
        current = [];
      }
    }
    if (current.length >= 2) segments.push(current);

    if (segments.length === 0 && stroke.points.length > 0) continue;
    if (segments.length === 1 && segments[0].length === stroke.points.length) {
      surviving.push(stroke);
    } else {
      for (const seg of segments) {
        surviving.push({
          points: seg,
          color: stroke.color,
          thickness: stroke.thickness,
          glow: stroke.glow,
        });
      }
    }
  }

  state.strokes = surviving;
  if (erased) soundErase();

  // Draw eraser indicator
  uiCtx.beginPath();
  uiCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  uiCtx.strokeStyle = "rgba(255, 45, 107, 0.5)";
  uiCtx.lineWidth = 1.5;
  uiCtx.setLineDash([5, 5]);
  uiCtx.stroke();
  uiCtx.setLineDash([]);
  uiCtx.fillStyle = "rgba(255, 45, 107, 0.05)";
  uiCtx.fill();

  redrawStrokes();
}

// ===== Grab/Move Mode =====
function handleGrabbing(landmarks) {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const center = {
    x: (1 - (thumbTip.x + indexTip.x) / 2) * state.width,
    y: ((thumbTip.y + indexTip.y) / 2) * state.height,
  };

  if (!state.isGrabbing) {
    state.isGrabbing = true;
    state.grabStartPos = { ...center };
    state.nearestStrokeIdx = findNearestStroke(center);
  } else {
    const dx = center.x - state.grabStartPos.x;
    const dy = center.y - state.grabStartPos.y;

    if (state.nearestStrokeIdx >= 0 && state.nearestStrokeIdx < state.strokes.length) {
      const stroke = state.strokes[state.nearestStrokeIdx];
      const prevOffX = state.grabOffset.x;
      const prevOffY = state.grabOffset.y;
      const deltaX = dx - prevOffX;
      const deltaY = dy - prevOffY;

      for (let i = 0; i < stroke.points.length; i++) {
        stroke.points[i].x += deltaX;
        stroke.points[i].y += deltaY;
      }
    }
    state.grabOffset = { x: dx, y: dy };
  }

  // Draw grab indicator
  uiCtx.beginPath();
  uiCtx.arc(center.x, center.y, 18, 0, Math.PI * 2);
  uiCtx.strokeStyle = "rgba(255, 215, 0, 0.7)";
  uiCtx.lineWidth = 2;
  uiCtx.stroke();
  uiCtx.fillStyle = "rgba(255, 215, 0, 0.1)";
  uiCtx.fill();

  // Highlight grabbed stroke
  if (state.nearestStrokeIdx >= 0 && state.nearestStrokeIdx < state.strokes.length) {
    highlightStroke(state.strokes[state.nearestStrokeIdx]);
  }

  redrawStrokes();
}

function endGrab() {
  if (state.isGrabbing && state.nearestStrokeIdx >= 0) soundGrabEnd();
  state.isGrabbing = false;
  state.grabStartPos = null;
  state.grabOffset = { x: 0, y: 0 };
  state.nearestStrokeIdx = -1;
  redrawStrokes();
}

function findNearestStroke(pos) {
  let minDist = Infinity;
  let idx = -1;
  for (let i = 0; i < state.strokes.length; i++) {
    const stroke = state.strokes[i];
    for (const pt of stroke.points) {
      const dist = Math.hypot(pt.x - pos.x, pt.y - pos.y);
      if (dist < minDist) {
        minDist = dist;
        idx = i;
      }
    }
  }
  return minDist < 80 ? idx : -1;
}

function highlightStroke(stroke) {
  if (!stroke || stroke.points.length < 2) return;
  uiCtx.save();
  uiCtx.beginPath();
  uiCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    uiCtx.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  uiCtx.strokeStyle = "rgba(255, 215, 0, 0.3)";
  uiCtx.lineWidth = stroke.thickness + 12;
  uiCtx.lineCap = "round";
  uiCtx.lineJoin = "round";
  uiCtx.setLineDash([8, 8]);
  uiCtx.stroke();
  uiCtx.setLineDash([]);
  uiCtx.restore();
}

// ===== Stroke Rendering =====
function renderStroke(ctx, stroke, isActive = false) {
  if (!stroke || stroke.points.length < 2) return;

  const pts = stroke.points;
  const color = stroke.color;
  const thickness = stroke.thickness;
  const glowFactor = stroke.glow / 100;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Outer glow pass
  if (glowFactor > 0) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness * 3;
    ctx.globalAlpha = 0.1 * glowFactor;
    ctx.shadowColor = color;
    ctx.shadowBlur = 35 * glowFactor;
    ctx.stroke();
  }

  // Mid glow pass
  if (glowFactor > 0) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness * 1.6;
    ctx.globalAlpha = 0.35 * glowFactor;
    ctx.shadowBlur = 15 * glowFactor;
    ctx.stroke();
  }

  // Core line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  ctx.strokeStyle = lightenColor(color, 0.5);
  ctx.lineWidth = thickness;
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 6 * glowFactor;
  ctx.shadowColor = color;
  ctx.stroke();

  ctx.restore();
}

function lightenColor(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `rgb(${lr}, ${lg}, ${lb})`;
}

function redrawStrokes() {
  drawCtx.clearRect(0, 0, state.width, state.height);
  for (const stroke of state.strokes) {
    renderStroke(drawCtx, stroke);
  }
  if (state.currentStroke && state.currentStroke.points.length > 1) {
    renderStroke(drawCtx, state.currentStroke, true);
  }
}

// ===== Particles =====
function spawnParticles(x, y, color) {
  for (let i = 0; i < 2; i++) {
    state.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 3,
      life: 1,
      decay: 0.02 + Math.random() * 0.03,
      size: 2 + Math.random() * 3,
      color,
    });
  }
}

function updateAndDrawParticles(ctx) {
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    p.size *= 0.97;

    if (p.life <= 0) {
      state.particles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = p.life * 0.7;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ===== Hand Skeleton Rendering =====
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

function drawHandSkeleton(ctx, landmarks) {
  if (!landmarks) return;

  ctx.save();
  ctx.globalAlpha = 0.3;

  // Draw connections
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = landmarkToCanvas(landmarks[a]);
    const pb = landmarkToCanvas(landmarks[b]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Draw all landmarks
  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarkToCanvas(landmarks[i]);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
    ctx.fill();
  }

  // Highlight fingertips
  const fingertips = [4, 8, 12, 16, 20];
  for (const idx of fingertips) {
    const pt = landmarkToCanvas(landmarks[idx]);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

// ===== Drawing Cursor =====
function drawCursor(ctx, landmarks, gesture) {
  if (gesture === "index_finger") {
    const tip = landmarkToCanvas(landmarks[8]);
    ctx.save();

    // Outer ring
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, state.thickness / 2 + 6, 0, Math.PI * 2);
    ctx.strokeStyle = state.activeColor;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.5;
    ctx.shadowColor = state.activeColor;
    ctx.shadowBlur = 8;
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = state.activeColor;
    ctx.globalAlpha = 0.9;
    ctx.fill();

    ctx.restore();
  }
}

// ===== Main Render Loop =====
let lastVideoTime = -1;

function renderLoop() {
  if (!state.handLandmarker || !state.isReady) {
    requestAnimationFrame(renderLoop);
    return;
  }

  const video = webcamVideo;
  const now = performance.now();

  // Clear camera canvas and redraw
  cameraCtx.clearRect(0, 0, state.width, state.height);
  if (state.showCamera) {
    cameraCtx.save();
    cameraCtx.globalAlpha = state.cameraOpacity;
    cameraCtx.translate(state.width, 0);
    cameraCtx.scale(-1, 1);
    cameraCtx.drawImage(video, 0, 0, state.width, state.height);
    cameraCtx.restore();
  }

  // Clear UI canvas
  uiCtx.clearRect(0, 0, state.width, state.height);

  // Process hand detection
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    const results = state.handLandmarker.detectForVideo(video, now);

    if (results.landmarks && results.landmarks.length > 0) {
      const landmarks = results.landmarks[0];
      const rawGesture = detectGesture(landmarks);
      const gesture = stabilizeGesture(rawGesture);

      if (!state.isModalOpen) {
        if (gesture === "index_finger") handleDrawing(landmarks);
        if (gesture === "open_palm") handleErasing(landmarks);
        if (gesture === "pinch") handleGrabbing(landmarks);

        // End stroke if gesture changed away from drawing
        if (gesture !== "index_finger" && state.currentStroke && state.currentStroke.points.length > 1) {
          state.strokes.push({ ...state.currentStroke });
          state.currentStroke = null;
        }
      }

      drawHandSkeleton(uiCtx, landmarks);
      drawCursor(uiCtx, landmarks, gesture);
    } else {
      // No hand detected
      if (state.currentGesture !== "none") {
        onGestureTransition(state.currentGesture, "none");
        state.currentGesture = "none";
      }
      if (state.currentStroke && state.currentStroke.points.length > 1) {
        state.strokes.push({ ...state.currentStroke });
        state.currentStroke = null;
        redrawStrokes();
      }
    }
  }

  // Draw particles on UI canvas
  updateAndDrawParticles(uiCtx);

  requestAnimationFrame(renderLoop);
}

// ===== UI Event Handlers =====

// Color palette
document.querySelectorAll(".color-swatch").forEach((swatch) => {
  swatch.addEventListener("click", () => {
    document.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");
    state.activeColor = swatch.dataset.color;
    playTone(1000, 0.05, "sine", 0.03);
  });
});

// Thickness slider
thicknessSlider.addEventListener("input", () => {
  state.thickness = parseInt(thicknessSlider.value);
  thicknessValue.textContent = `${state.thickness}px`;
});

// Glow slider
glowSlider.addEventListener("input", () => {
  state.glowIntensity = parseInt(glowSlider.value);
  glowValue.textContent = `${state.glowIntensity}%`;
});

// Undo
$("btn-undo").addEventListener("click", () => {
  if (state.strokes.length > 0) {
    state.strokes.pop();
    redrawStrokes();
    playTone(500, 0.08, "sine", 0.03);
  }
});

// Clear
$("btn-clear").addEventListener("click", () => {
  state.strokes = [];
  state.currentStroke = null;
  state.particles = [];
  redrawStrokes();
  playTone(300, 0.15, "triangle", 0.04);
});

// Camera toggle (3 states: ON → DIM → DARK → ON)
$("btn-camera-toggle").addEventListener("click", () => {
  if (state.showCamera && state.cameraOpacity > 0.2) {
    // Camera ON → DIM
    state.cameraOpacity = 0.15;
    cameraModeText.textContent = "Camera DIM";
    cameraModeIndicator.classList.remove("dark-mode");
  } else if (state.showCamera && state.cameraOpacity <= 0.2) {
    // DIM → DARK
    state.showCamera = false;
    state.cameraOpacity = 0;
    cameraModeText.textContent = "Dark Canvas";
    cameraModeIndicator.classList.add("dark-mode");
    $("btn-camera-toggle").classList.remove("active");
  } else {
    // DARK → ON
    state.showCamera = true;
    state.cameraOpacity = 0.35;
    cameraModeText.textContent = "Camera ON";
    cameraModeIndicator.classList.remove("dark-mode");
    $("btn-camera-toggle").classList.add("active");
  }
  soundClick();
});

// Camera indicator click → toggle camera
cameraModeIndicator.addEventListener("click", () => {
  $("btn-camera-toggle").click();
});

// Save
$("btn-save").addEventListener("click", () => {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = state.width;
  exportCanvas.height = state.height;
  const exportCtx = exportCanvas.getContext("2d");
  exportCtx.fillStyle = "#07070d";
  exportCtx.fillRect(0, 0, state.width, state.height);
  exportCtx.drawImage(drawingCanvas, 0, 0);

  const link = document.createElement("a");
  link.download = `gestdraw-${Date.now()}.png`;
  link.href = exportCanvas.toDataURL("image/png");
  link.click();
  playTone(800, 0.1, "sine", 0.04);
});

// Start button
btnStart.addEventListener("click", () => {
  onboardingModal.classList.add("hidden");
  state.isModalOpen = false;
  playTone(800, 0.1, "sine", 0.04);
  updateGestureHUD("idle");
});

// ===== Initialization =====
async function init() {
  resizeCanvases();

  try {
    await Promise.all([initHandTracking(), initWebcam()]);

    state.isReady = true;

    // Complete the loading bar
    const barFill = document.querySelector(".loader-bar-fill");
    barFill.style.animation = "none";
    barFill.style.width = "100%";
    barFill.style.transition = "width 0.4s ease";

    setTimeout(() => {
      loadingScreen.classList.add("fade-out");
      appContainer.classList.remove("hidden");
      onboardingModal.classList.remove("hidden");
    }, 600);

    setTimeout(() => {
      loadingScreen.style.display = "none";
    }, 1200);

    renderLoop();
  } catch (err) {
    console.error("Failed to initialize GestDraw:", err);
    document.querySelector(".loader-subtitle").textContent =
      "Error: Camera access required. Please allow camera permissions and reload.";
    document.querySelector(".loader-subtitle").style.color = "#ff2d6b";
    document.querySelector(".loader-bar").style.display = "none";
  }
}

init();
