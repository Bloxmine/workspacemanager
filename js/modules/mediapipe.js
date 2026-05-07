export function createMediaPipeController({
    cameraFeed,
    detectorOverlay,
    detectorDebugChip,
    speakPoseAlert,
}) {
    let poseLandmarker = null;
    let faceDetector = null;
    let mediaPipeReady = false;
    let mediaPipeDetecting = false;
    let detectionTimer = null;
    let previousLandmarks = null;
    let lastMovementAtMs = Date.now();
    let tooCloseStreak = 0;
    let lastPoseAlertAt = 0;
    const voiceCooldownMs = 30000;
    const detectorOverlayCtx = detectorOverlay.getContext("2d");

    function maybeSpeakPoseKey(key) {
        if (!key || typeof speakPoseAlert !== "function") {
            return;
        }

        const now = Date.now();
        if (now - lastPoseAlertAt < voiceCooldownMs) {
            return;
        }

        lastPoseAlertAt = now;
        void speakPoseAlert(key);
    }
    function pickPoseAlerts(landmarks, timestampMs) {
        if (!Array.isArray(landmarks) || landmarks.length < 25) {
            return { alerts: ["inactive"], metrics: { noseDepth: null } };
        }

        const nose = landmarks[0];
        const leftShoulder = landmarks[11];
        const rightShoulder = landmarks[12];
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];

        if (!nose || !leftShoulder || !rightShoulder || !leftHip || !rightHip) {
            return { alerts: [], metrics: { noseDepth: null } };
        }

        const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
        const shoulderZ = (leftShoulder.z + rightShoulder.z) / 2;
        const hipY = (leftHip.y + rightHip.y) / 2;
        const torsoHeight = Math.abs(hipY - shoulderY) || 0.001;
        const alerts = [];

        if (nose.y > shoulderY + torsoHeight * 0.2) {
            alerts.push("head_down");
        }

        if (nose.z < shoulderZ - 1.2) {
            alerts.push("too_close_to_screen");
        }

        if (leftShoulder.y - rightShoulder.y > 0.05) {
            alerts.push("tilting_left");
        } else if (rightShoulder.y - leftShoulder.y > 0.05) {
            alerts.push("tilting_right");
        }

        if (nose.y > shoulderY + torsoHeight * 0.08 && shoulderY > 0.45) {
            alerts.push("slouching");
        }

        if (previousLandmarks && previousLandmarks[0]) {
            const indexes = [0, 11, 12, 15, 16, 23, 24];
            let movement = 0;

            for (const index of indexes) {
                const prev = previousLandmarks[index];
                const cur = landmarks[index];
                if (prev && cur) {
                    movement += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
                }
            }

            movement = movement / indexes.length;
            if (movement > 0.02) {
                lastMovementAtMs = timestampMs;
                alerts.push(movement > 0.05 ? "very_active" : "fidgeting");
            }
        }

        if (timestampMs - lastMovementAtMs > 12000) {
            alerts.push("inactive");
        }

        previousLandmarks = landmarks;

        return {
            alerts,
            metrics: {
                noseDepth: Number((nose.z - shoulderZ).toFixed(3)),
            },
        };
    }

    function pickFaceAlerts(faceResult) {
        const detections = faceResult?.detections || [];
        if (detections.length === 0 || !cameraFeed.videoWidth) {
            return { alerts: [], faceRatio: 0 };
        }

        const face = detections[0];
        const box = face.boundingBox || {};
        const width = box.width || box.width_px || 0;
        const faceRatio = width / cameraFeed.videoWidth;
        const alerts = [];

        if (faceRatio > 0.56) {
            alerts.push("too_close_to_screen");
        }

        return { alerts, faceRatio };
    }

    function drawDetectorOverlay(poseLandmarks, faceResult) {
        if (!detectorOverlayCtx || !cameraFeed.videoWidth || !cameraFeed.videoHeight) {
            return;
        }

        const w = cameraFeed.videoWidth;
        const h = cameraFeed.videoHeight;
        detectorOverlay.width = w;
        detectorOverlay.height = h;
        detectorOverlayCtx.clearRect(0, 0, w, h);

        if (Array.isArray(poseLandmarks)) {
            detectorOverlayCtx.fillStyle = "rgba(126, 247, 184, 0.9)";
            for (const point of poseLandmarks) {
                if (!point) {
                    continue;
                }
                const x = point.x * w;
                const y = point.y * h;
                detectorOverlayCtx.beginPath();
                detectorOverlayCtx.arc(x, y, 3, 0, Math.PI * 2);
                detectorOverlayCtx.fill();
            }
        }

        const face = faceResult?.detections?.[0];
        if (face?.boundingBox) {
            const box = face.boundingBox;
            const bx = box.originX ?? box.origin_x ?? 0;
            const by = box.originY ?? box.origin_y ?? 0;
            const bw = box.width ?? 0;
            const bh = box.height ?? 0;

            void bx;
            void by;
            void bw;
            void bh;

            const keypoints = face.keypoints || [];
            detectorOverlayCtx.fillStyle = "rgba(255, 216, 74, 0.95)";
            for (const point of keypoints) {
                const x = (point.x || 0) * w;
                const y = (point.y || 0) * h;
                detectorOverlayCtx.beginPath();
                detectorOverlayCtx.arc(x, y, 2.5, 0, Math.PI * 2);
                detectorOverlayCtx.fill();
            }
        }
    }

    async function detectRealtimePoseAndFace() {
        if (!mediaPipeReady || mediaPipeDetecting || !cameraFeed.srcObject || cameraFeed.readyState < 2) {
            return;
        }

        mediaPipeDetecting = true;

        try {
            const timestampMs = performance.now();
            const poseResult = poseLandmarker.detectForVideo(cameraFeed, timestampMs);
            const faceResult = faceDetector.detectForVideo(cameraFeed, timestampMs);

            const poseLandmarks = poseResult?.landmarks?.[0] || null;
            const poseOutput = pickPoseAlerts(poseLandmarks, Date.now());
            const faceOutput = pickFaceAlerts(faceResult);
            const uniqueAlerts = [...new Set([...(poseOutput.alerts || []), ...(faceOutput.alerts || [])])];

            drawDetectorOverlay(poseLandmarks, faceResult);

            if (detectorDebugChip) {
                const ratioText = faceOutput.faceRatio ? faceOutput.faceRatio.toFixed(2) : "0.00";
                const depthText = poseOutput.metrics?.noseDepth != null ? poseOutput.metrics.noseDepth.toFixed(3) : "n/a";
                detectorDebugChip.textContent = `face:${ratioText} depth:${depthText} alerts:${uniqueAlerts.join("|") || "none"}`;
            }

            if (uniqueAlerts.includes("too_close_to_screen")) {
                tooCloseStreak += 1;
            } else {
                tooCloseStreak = Math.max(0, tooCloseStreak - 1);
            }

            if (uniqueAlerts.includes("slouching")) {
                maybeSpeakPoseKey("slouching");
            } else if (tooCloseStreak >= 3 && uniqueAlerts.includes("too_close_to_screen")) {
                maybeSpeakPoseKey("too_close_to_screen");
            } else if (uniqueAlerts.includes("head_down")) {
                maybeSpeakPoseKey("head_down");
            } else if (uniqueAlerts.includes("very_active")) {
                maybeSpeakPoseKey("very_active");
            } else if (uniqueAlerts.includes("fidgeting")) {
                maybeSpeakPoseKey("fidgeting");
            } else if (uniqueAlerts.includes("inactive")) {
                maybeSpeakPoseKey("inactive");
            }
        } finally {
            mediaPipeDetecting = false;
        }
    }

    async function initMediaPipeDetectors() {
        if (mediaPipeReady) {
            return;
        }

        const visionTasks = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/+esm");
        const vision = await visionTasks.FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );

        poseLandmarker = await visionTasks.PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
            },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.55,
            minPosePresenceConfidence: 0.55,
            minTrackingConfidence: 0.55,
        });

        faceDetector = await visionTasks.FaceDetector.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
            },
            runningMode: "VIDEO",
            minDetectionConfidence: 0.55,
        });

        mediaPipeReady = true;
        if (!detectionTimer) {
            detectionTimer = setInterval(detectRealtimePoseAndFace, 350);
        }
    }

    return {
        initMediaPipeDetectors,
    };
}