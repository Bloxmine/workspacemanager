// Author: Hein Dijstelbloem
// Date: 2026-05-06
// Description: Main JavaScript for the Workspace Manager application. Handles camera access, MediaPipe pose and face detection, communication with the backend API for analysis and TTS, and user interactions.
import { actionIcon, apiBase, escapeHtml } from "./modules/shared.js";
import { createAnalysisController } from "./modules/analysis.js";
import { createMediaPipeController } from "./modules/mediapipe.js";
import { createVoiceController } from "./modules/voice.js";

const cameraFeed = document.getElementById("cameraFeed");
const cameraStatus = document.getElementById("cameraStatus");
const analyzeBtn = document.getElementById("analyzeBtn");
const applyActionsBtn = document.getElementById("applyActionsBtn");
const analysisText = document.getElementById("analysisText");
const suggestionsList = document.getElementById("suggestionsList");
const actionsTable = document.getElementById("actionsTable");
const voiceStatusChip = document.getElementById("voiceStatusChip");
const voiceStatusLabel = voiceStatusChip.querySelector(".voice-label");
const replayVoiceBtn = document.getElementById("replayVoiceBtn");
const detectorOverlay = document.getElementById("detectorOverlay");
const detectorDebugChip = document.getElementById("detectorDebugChip");
const captureCanvas = document.createElement("canvas");
const speakAudio = new Audio();

const voiceController = createVoiceController({
    apiBase,
    speakAudio,
    voiceStatusChip,
    voiceStatusLabel,
    replayVoiceBtn,
});

const mediaPipeController = createMediaPipeController({
    cameraFeed,
    detectorOverlay,
    detectorDebugChip,
    speakPoseAlert: voiceController.speakPoseAlert,
});

const analysisController = createAnalysisController({
    apiBase,
    cameraFeed,
    cameraStatus,
    analyzeBtn,
    applyActionsBtn,
    analysisText,
    suggestionsList,
    actionsTable,
    captureFrameAsDataUrl,
    speakAnalysis: voiceController.speakAnalysis,
    escapeHtml,
    actionIcon,
});

function captureFrameAsDataUrl() {
    const width = cameraFeed.videoWidth || 640;
    const height = cameraFeed.videoHeight || 360;
    captureCanvas.width = width;
    captureCanvas.height = height;
    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(cameraFeed, 0, 0, width, height);
    return captureCanvas.toDataURL("image/jpeg", 0.8);
}

async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        cameraStatus.textContent = "Camera API not supported in this browser.";
        return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
    });

    cameraFeed.srcObject = stream;
    cameraStatus.textContent = "Camera online.";
    void mediaPipeController.initMediaPipeDetectors();
}

analyzeBtn.addEventListener("click", analysisController.analyzeWorkspace);
applyActionsBtn.addEventListener("click", analysisController.applySuggestedActions);
replayVoiceBtn.addEventListener("click", voiceController.replayLastVoice);

window.workspaceVoice = {
    speakPoseAlert: voiceController.speakPoseAlert,
    speakSuggestion: voiceController.speakSuggestion,
    pregenerateRealtimePack: voiceController.pregenerateRealtimePack,
    replayLastVoice: voiceController.replayLastVoice,
};

void startCamera();