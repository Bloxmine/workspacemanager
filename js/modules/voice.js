export function createVoiceController({
    apiBase,
    speakAudio,
    voiceStatusChip,
    voiceStatusLabel,
    replayVoiceBtn,
    audioUnlockMessage = "Tap once to enable voice alerts",
}) {
    const audioQueue = [];
    let lastSpokenAudioUrl = "";
    let isAudioPlaying = false;
    let voicePlaybackUnlocked = false;

    function setVoiceStatus(state, text) {
        if (!voiceStatusChip || !voiceStatusLabel) {
            return;
        }

        voiceStatusChip.classList.remove("visible", "generating", "playing");
        voiceStatusChip.classList.add("visible", state);
        voiceStatusLabel.textContent = text || (state === "generating" ? "Generating voice" : "Playing voice");
    }

    function markVoicePlaybackUnlocked() {
        voicePlaybackUnlocked = true;
        if (!isAudioPlaying && audioQueue.length > 0) {
            void processAudioQueue();
        }
    }

    document.addEventListener("pointerdown", markVoicePlaybackUnlocked, { once: true });
    document.addEventListener("keydown", markVoicePlaybackUnlocked, { once: true });

    function buildSpeechText(analysis) {
        const assessment = analysis.assessment || "";
        const suggestions = Array.isArray(analysis.suggestions) ? analysis.suggestions : [];
        let text = "";

        if (assessment) {
            text = "Assessment. " + assessment;
        }

        if (suggestions.length > 0) {
            if (text) {
                text += " ... ";
            }
            text += "Suggestions. " + suggestions.join(" ... ");
        }

        return text.trim();
    }

    function playQueuedAudio(url) {
        return new Promise(resolve => {
            if (!voicePlaybackUnlocked) {
                resolve({ blocked: true });
                return;
            }

            let settled = false;
            let timeoutId = null;

            const cleanup = () => {
                speakAudio.onended = null;
                speakAudio.onerror = null;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            };

            const done = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve({ blocked: false });
            };

            speakAudio.onended = done;
            speakAudio.onerror = done;

            timeoutId = setTimeout(done, 20000);

            speakAudio.src = url;
            speakAudio.currentTime = 0;

            try {
                const playback = speakAudio.play();
                if (playback && typeof playback.catch === "function") {
                    playback.catch(done);
                }
            } catch {
                done();
            }
        });
    }

    async function processAudioQueue() {
        if (isAudioPlaying) {
            return;
        }

        isAudioPlaying = true;
        if (replayVoiceBtn) {
            replayVoiceBtn.disabled = true;
        }

        try {
            while (audioQueue.length > 0) {
                const next = audioQueue.shift();
                if (!next?.url) {
                    continue;
                }

                setVoiceStatus("playing", next.statusText || "Playing voice");
                const playback = await playQueuedAudio(next.url);
                if (playback?.blocked) {
                    audioQueue.unshift(next);
                    setVoiceStatus("idle", audioUnlockMessage);
                    break;
                }
            }
        } finally {
            isAudioPlaying = false;
            if (replayVoiceBtn) {
                replayVoiceBtn.disabled = !lastSpokenAudioUrl;
            }
            if (audioQueue.length === 0) {
                setVoiceStatus("idle", "Voice complete");
            }
        }
    }

    async function enqueueAudioPlayback(url, statusText) {
        if (!url) {
            return;
        }

        audioQueue.push({ url, statusText });
        void processAudioQueue();
    }

    async function playAudioFromPath(audioPath, statusText = "Playing voice") {
        if (!audioPath) {
            return;
        }

        lastSpokenAudioUrl = `${apiBase}${audioPath}`;
        if (replayVoiceBtn) {
            replayVoiceBtn.disabled = true;
        }
        await enqueueAudioPlayback(lastSpokenAudioUrl, statusText);
    }

    async function speakAnalysis(analysis) {
        const speechText = buildSpeechText(analysis);

        if (!speechText) {
            return;
        }

        setVoiceStatus("generating", "Generating voice");
        const response = await fetch(`${apiBase}/api/tts/speak`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: speechText }),
        });

        const data = await response.json();
        if (data.audioPath) {
            await playAudioFromPath(data.audioPath);
        }
    }

    async function speakPoseAlertByKey(key) {
        if (!key) {
            return;
        }

        setVoiceStatus("generating", "Loading pose alert");
        const response = await fetch(`${apiBase}/api/tts/speak-pose-alert`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ key }),
        });

        const data = await response.json();
        if (data.audioPath) {
            await playAudioFromPath(data.audioPath, `Pose alert: ${key}`);
        }
    }

    async function speakSuggestionByKey(key) {
        if (!key) {
            return;
        }

        setVoiceStatus("generating", "Loading suggestion");
        const response = await fetch(`${apiBase}/api/tts/speak-suggestion`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ key }),
        });

        const data = await response.json();
        if (data.audioPath) {
            await playAudioFromPath(data.audioPath, `Suggestion: ${key}`);
        }
    }

    async function pregenerateRealtimePack(force = false) {
        const response = await fetch(`${apiBase}/api/tts/pregenerate-realtime-pack`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ force }),
        });

        return response.json();
    }

    async function replayLastVoice() {
        if (!lastSpokenAudioUrl) {
            return;
        }

        await enqueueAudioPlayback(lastSpokenAudioUrl, "Replay voice");
    }

    return {
        setVoiceStatus,
        speakAnalysis,
        speakPoseAlert: speakPoseAlertByKey,
        speakSuggestion: speakSuggestionByKey,
        pregenerateRealtimePack,
        replayLastVoice,
        getLastSpokenAudioUrl: () => lastSpokenAudioUrl,
    };
}