// Author: Hein Dijstelbloem
// Date: 2026-04-10
// Description: Workspace Manager API for Home Assistant service calls, workspace analysis, and TTS playback.

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = 3000;
// this should not be hardcoded.
// but! it's local and I don't care.
const HA_CONFIG = {
    baseUrl: 'http://homeassistant.local:8123',
    accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjZDE1ZGJlNDdlOTM0NzFlOTdhZjk1OTM2OTNmY2FiYiIsImlhdCI6MTc3MTIzMjE1OCwiZXhwIjoyMDg2NTkyMTU4fQ.D2xpyi2xgDgbzPzi-x45HnA_VS27atOx92-dMWC9-Rk'
};
// connects to LM Studio
const LLM_CONFIG = {
    baseUrl: process.env.LLM_BASE_URL || process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234',
    model: process.env.LLM_MODEL || 'gemma-4-e4b-uncensored-hauhaucs-aggressive'
};
// alibabas mlx tts model - can do voice cloning with reference audio, or use built in voices. runs locally via python package, separate from node server.
const TTS_CONFIG = {
    model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
    voice: 'Chelsie', // fallback voice if no reference audio is available
    pythonPath: process.env.PYTHON_BIN || path.join(__dirname, '.tts-venv', 'bin', 'python'),
    outputDir: path.join(__dirname, 'audio'),
    referenceDir: path.join(__dirname, 'audio/references'),
    maxAudioFiles: 20
};

const POSE_ALERT_PHRASES = [
    { key: 'slouching', text: "You're slouching. Straighten your back." },
    { key: 'very_active', text: "You're very active right now. Keep your movement controlled." },
    { key: 'focused', text: "Great focus. Keep this posture and pace." },
    { key: 'leaning_forward', text: "You're leaning forward. Sit back and relax your shoulders." },
    { key: 'head_down', text: "Your head is too low. Raise your screen or chin slightly." },
    { key: 'break_time', text: "Time for a short posture break. Stand up and stretch." },
    { key: 'too_close_to_screen', text: "You're too close to the screen. Lean back a little." },
    { key: 'shoulders_tense', text: "Your shoulders look tense. Drop them and breathe out slowly." },
    { key: 'tilting_left', text: "You're tilting left. Recenter your posture." },
    { key: 'tilting_right', text: "You're tilting right. Recenter your posture." },
    { key: 'fidgeting', text: "You're fidgeting a lot. Try a slower and steadier rhythm." },
    { key: 'inactive', text: "You've been still for a while. Take a quick movement break." }
];

const SUGGESTION_PHRASES = [
    { key: 'micro_break', text: 'Take a 30 second micro break and reset your posture.' },
    { key: 'hydrate', text: 'Quick reminder: drink some water.' },
    { key: 'eye_rest', text: 'Rest your eyes for twenty seconds and look at a distant object.' },
    { key: 'neck_roll', text: 'Roll your neck gently to release tension.' },
    { key: 'shoulder_reset', text: 'Relax your shoulders and keep your elbows close to your body.' },
    { key: 'sit_back', text: 'Sit back in your chair and support your lower back.' },
    { key: 'stand_and_stretch', text: 'Stand up and stretch for one minute.' },
    { key: 'slow_breath', text: 'Take two slow breaths and reset your focus.' },
    { key: 'maintain_focus', text: 'You are doing great. Keep this steady focus.' },
    { key: 'reduce_speed', text: 'Slow down your movements and work with deliberate control.' }
];
// path to reference audio
const TTS_REFERENCE_AUDIO = path.join(TTS_CONFIG.referenceDir, 'voicesample.wav');
const TTS_REFERENCE_TEXT = 'Please do not adress this unit in that matter';

function resolveTtsPythonPath() {
    const candidates = [
        process.env.PYTHON_BIN,
        TTS_CONFIG.pythonPath,
        'python3',
        'python'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate === 'python3' || candidate === 'python') {
            return candidate;
        }

        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function getLatestWavByPrefix(filePrefix) {
    const matches = fs.readdirSync(TTS_CONFIG.outputDir)
        .filter(file => file.toLowerCase().endsWith('.wav') && file.startsWith(filePrefix))
        .map(file => ({
            name: file,
            path: path.join(TTS_CONFIG.outputDir, file),
            time: fs.statSync(path.join(TTS_CONFIG.outputDir, file)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

    return matches[0] || null;
}

async function generateTtsAudio(text, filePrefix) {
    const pythonPath = resolveTtsPythonPath();

    if (!pythonPath) {
        throw new Error('No Python executable found for TTS generation. Set PYTHON_BIN or install python3/python locally.');
    }

    const existingFileTimes = new Map(
        fs.readdirSync(TTS_CONFIG.outputDir)
            .filter(file => file.toLowerCase().endsWith('.wav'))
            .map(file => {
                const filePath = path.join(TTS_CONFIG.outputDir, file);
                return [file, fs.statSync(filePath).mtime.getTime()];
            })
    );

    const escapedText = text.replace(/"/g, '\\"').replace(/'/g, "\\'");
    let command = `cd "${TTS_CONFIG.outputDir}" && "${pythonPath}" -m mlx_audio.tts.generate --model "${TTS_CONFIG.model}" --text "${escapedText}" --file_prefix "${filePrefix}"`;
    command += ' --max_tokens 4096';

    if (fs.existsSync(TTS_REFERENCE_AUDIO)) {
        const escapedRefText = TTS_REFERENCE_TEXT.replace(/"/g, '\\"').replace(/'/g, "\\'");
        command += ` --ref_audio "${TTS_REFERENCE_AUDIO}" --ref_text "${escapedRefText}"`;
        console.log('Using hardcoded voice cloning reference:', TTS_REFERENCE_AUDIO);
    } else {
        command += ` --voice "${TTS_CONFIG.voice}"`;
        console.log('Using built-in voice preset:', TTS_CONFIG.voice);
    }

    await new Promise((resolve, reject) => {
        exec(command, { timeout: 90000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('TTS generation error:', error);
                console.error('stderr:', stderr);
                reject(new Error(`TTS failed: ${error.message}`));
                return;
            }

            resolve();
        });
    });

    const outputCandidates = fs.readdirSync(TTS_CONFIG.outputDir)
        .filter(file => file.toLowerCase().endsWith('.wav'))
        .map(file => ({
            name: file,
            path: path.join(TTS_CONFIG.outputDir, file),
            time: fs.statSync(path.join(TTS_CONFIG.outputDir, file)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

    const changedCandidates = outputCandidates.filter(file => {
        const previousTime = existingFileTimes.get(file.name);
        return previousTime === undefined || file.time > previousTime;
    });

    const matchingOutput = changedCandidates.find(file =>
        file.name === `${filePrefix}.wav` ||
        file.name === `${filePrefix}_0.wav` ||
        file.name === `${filePrefix}_000.wav` ||
        file.name.startsWith(`${filePrefix}_`)
    );

    const fallbackOutput = outputCandidates.find(file =>
        file.name === `${filePrefix}.wav` ||
        file.name === `${filePrefix}_0.wav` ||
        file.name === `${filePrefix}_000.wav` ||
        file.name.startsWith(`${filePrefix}_`)
    );

    const outputPath = matchingOutput?.path || fallbackOutput?.path || changedCandidates[0]?.path || null;
    if (!outputPath) {
        const files = fs.readdirSync(TTS_CONFIG.outputDir);
        throw new Error(`Audio file not found. Files in audio dir: ${files.join(', ')}`);
    }

    cleanupOldAudioFiles();

    const filename = path.basename(outputPath);
    return {
        filename,
        audioPath: `/audio/${filename}`
    };
}

for (const dir of [TTS_CONFIG.outputDir, TTS_CONFIG.referenceDir]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
// nothing
app.use(express.json({ limit: '20mb' }));
// CORS middleware with dynamic origin checking
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = new Set([
        'http://127.0.0.1:5500',
        'http://localhost:5500',
        'http://127.0.0.1:3000',
        'http://localhost:3000'
    ]);

    if (origin && allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.static(__dirname));
app.post('/api/service', async (req, res) => {
    const { domain, service, entityId, data = {} } = req.body;
    try {
        const response = await fetch(`${HA_CONFIG.baseUrl}/api/services/${domain}/${service}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                entity_id: entityId,
                ...data
            })
        });
        const result = await response.json();
        res.json(result);
        // erorr handling
    } catch (error) {
        console.error('Error calling service:', error);
        res.status(500).json({ error: error.message });
    }
});
// this function retrieves the current states of Home Assistant entities and formats them for workspace analysis.
async function getWorkspaceHomeAssistantContext() {
    try {
        const response = await fetch(`${HA_CONFIG.baseUrl}/api/states`, {
            headers: {
                'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Home Assistant API error: ${response.status}`);
        }

        const entities = await response.json();
        const actionableDomains = new Set(['light', 'switch', 'climate', 'cover', 'fan', 'media_player']);

        const serviceMap = {
            light: ['turn_on', 'turn_off', 'toggle'],
            switch: ['turn_on', 'turn_off', 'toggle'],
            climate: ['set_temperature', 'set_hvac_mode', 'turn_on', 'turn_off'],
            cover: ['open_cover', 'close_cover', 'stop_cover'],
            fan: ['turn_on', 'turn_off', 'set_percentage'],
            media_player: ['turn_on', 'turn_off', 'media_pause', 'media_play']
        };

        return entities
            .filter(entity => actionableDomains.has(entity.entity_id.split('.')[0]))
            .slice(0, 18)
            .map(entity => {
                const domain = entity.entity_id.split('.')[0];
                return {
                    entity_id: entity.entity_id,
                    friendly_name: entity.attributes?.friendly_name || entity.entity_id,
                    state: entity.state,
                    domain,
                    possible_services: serviceMap[domain] || ['turn_on', 'turn_off']
                };
            });
    } catch (error) {
        console.error('Failed to load Home Assistant context for workspace analysis:', error.message);
        return [];
    }
}

app.post('/api/workspace/analyze', async (req, res) => {
    const { posture, timeInState, sensorData, calendarEvents, image } = req.body;

    try {
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const hour = now.getHours();
        let timeOfDay = 'morning';

        if (hour >= 12 && hour < 17) {
            timeOfDay = 'afternoon';
        } else if (hour >= 17 && hour < 21) {
            timeOfDay = 'evening';
        } else if (hour >= 21 || hour < 6) {
            timeOfDay = 'late night';
        }

        const actionableEntities = await getWorkspaceHomeAssistantContext();
        const haContextBlock = actionableEntities.length > 0
            ? actionableEntities
                .map(entity => `- ${entity.friendly_name} (${entity.entity_id}) | state: ${entity.state} | services: ${entity.possible_services.join(', ')}`)
                .join('\n')
            : '- No Home Assistant entities were available during this analysis.';
// now for the magic. this is where the magic happens.
        const prompt = `You are an AI workspace assistant monitoring crew member readiness on a starship bridge. Analyze the current situation and provide recommendations.
CURRENT SITUATION:
- Time: ${timeString} (${timeOfDay})
- Crew Posture: ${posture || 'Unknown'}
- Time in Current State: ${timeInState || 0} minutes
${sensorData ? `
ENVIRONMENTAL SENSORS:
- Light Level: ${sensorData.lightLevel || 'Unknown'} lux
- Noise Level: ${sensorData.noiseLevel || 'Unknown'} dB
- CO2 Level: ${sensorData.co2Level || 'Unknown'} ppm
- Temperature: ${sensorData.temperature || 'Unknown'} °C
` : ''}
${calendarEvents && calendarEvents.length > 0 ? `
UPCOMING SCHEDULE:
${calendarEvents.map(event => `- ${event.time}: ${event.event}`).join('\n')}
` : ''}
${image ? '- Visual image of crew member at workstation is provided' : ''}

POSTURE STATES:
- "focused" = Leaning in, highly engaged
- "neutral" = Standard working posture
- "tired" = Slumping, showing fatigue
- "absent" = No crew member at station

AVAILABLE ACTIONS:
1. Focus Mode (Battle Stations): Dim lights to 40%, enable white noise, set temp to 21°C, block notifications
2. Break Mode (Red Alert): Pulse lights, audio reminder, open blinds, suggest 5-minute walk
3. Maintain Current: No changes needed

HOME ASSISTANT CONTROLLABLE DEVICES:
${haContextBlock}

Use only entities listed above when suggesting Home Assistant actions.

${image ? 'Examine the image to assess the crew member\'s posture, engagement level, and overall alertness. Consider body language, screen proximity, and any visible signs of fatigue.' : ''}

Based on the posture${image ? ', visual assessment,' : ''} environmental conditions, time in state, and upcoming schedule, provide a comprehensive assessment with actionable recommendations.

Respond in JSON format:
{
    "assessment": "Brief assessment of the crew member's current state and needs (2-3 sentences)",
    "recommendation": "Which action to take: 'focus_mode', 'break_mode', or 'maintain'",
    "reasoning": "Why this recommendation is appropriate given the context (2-3 sentences)",
    "urgency": "low/medium/high",
    "suggestions": ["List of 2-4 specific actionable suggestions"],
    "homeAssistantActions": [
        {
            "domain": "light",
            "service": "turn_on",
            "entity_id": "light.example",
            "data": { "brightness_pct": 55 },
            "reason": "Comfort improvement explanation"
        }
    ]
}

Rules for homeAssistantActions:
- Only include actions that make the workspace more pleasant and safe.
- Include 0 to 3 actions maximum.
- Use valid domain/service/entity_id combinations based on listed devices.
- If no action is needed, return an empty homeAssistantActions array.`;

        const messageContent = image && image.startsWith('data:image')
            ? [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: image } }
            ]
            : prompt;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [{ role: 'user', content: messageContent }],
                temperature: 0.7,
                max_tokens: 600
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content || '{}';
        responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        let analysis;
        try {
            analysis = JSON.parse(responseText);
        } catch (parseError) {
            analysis = {
                assessment: responseText,
                recommendation: 'maintain',
                reasoning: 'The model returned non-JSON content. Fallback text used.',
                urgency: 'low',
                suggestions: [],
                homeAssistantActions: []
            };
        }

        if (!Array.isArray(analysis.homeAssistantActions)) {
            analysis.homeAssistantActions = [];
        }

        res.json(analysis);
    } catch (error) {
        console.error('Workspace analysis error:', error);
        res.status(500).json({
            assessment: 'Unable to analyze workspace at this time',
            recommendation: 'maintain',
            reasoning: 'System error occurred',
            urgency: 'low',
            suggestions: []
        });
    }
});
// this is where it speaks.
app.post('/api/tts/speak', async (req, res) => {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: 'Text is required' });
    }

    try {
        const timestamp = Date.now();
        const filePrefix = `tts_${timestamp}`;
        console.log('Generating TTS audio:', text.substring(0, 50) + '...');
        const generated = await generateTtsAudio(text, filePrefix);

        res.json({
            success: true,
            audioPath: generated.audioPath,
            message: 'Audio generated successfully'
        });
    } catch (error) {
        console.error('TTS endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Failed to generate audio'
        });
    }
});

app.post('/api/tts/pregenerate-pose-alerts', async (req, res) => {
    const force = Boolean(req.body?.force);

    try {
        const results = [];

        for (const phrase of POSE_ALERT_PHRASES) {
            const filePrefix = `pose_${phrase.key}`;
            const existing = getLatestWavByPrefix(filePrefix);

            if (existing && !force) {
                results.push({
                    key: phrase.key,
                    text: phrase.text,
                    audioPath: `/audio/${existing.name}`,
                    generated: false
                });
                continue;
            }

            const generated = await generateTtsAudio(phrase.text, filePrefix);
            results.push({
                key: phrase.key,
                text: phrase.text,
                audioPath: generated.audioPath,
                generated: true
            });
        }

        res.json({
            success: true,
            count: results.length,
            results
        });
    } catch (error) {
        console.error('Pose alert pre-generation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/tts/pregenerate-suggestions', async (req, res) => {
    const force = Boolean(req.body?.force);

    try {
        const results = [];

        for (const phrase of SUGGESTION_PHRASES) {
            const filePrefix = `suggestion_${phrase.key}`;
            const existing = getLatestWavByPrefix(filePrefix);

            if (existing && !force) {
                results.push({
                    key: phrase.key,
                    text: phrase.text,
                    audioPath: `/audio/${existing.name}`,
                    generated: false
                });
                continue;
            }

            const generated = await generateTtsAudio(phrase.text, filePrefix);
            results.push({
                key: phrase.key,
                text: phrase.text,
                audioPath: generated.audioPath,
                generated: true
            });
        }

        res.json({
            success: true,
            count: results.length,
            results
        });
    } catch (error) {
        console.error('Suggestion pre-generation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/tts/pregenerate-realtime-pack', async (req, res) => {
    const force = Boolean(req.body?.force);

    try {
        const results = {
            poses: [],
            suggestions: []
        };

        for (const phrase of POSE_ALERT_PHRASES) {
            const filePrefix = `pose_${phrase.key}`;
            const existing = getLatestWavByPrefix(filePrefix);

            if (existing && !force) {
                results.poses.push({
                    key: phrase.key,
                    text: phrase.text,
                    audioPath: `/audio/${existing.name}`,
                    generated: false
                });
                continue;
            }

            const generated = await generateTtsAudio(phrase.text, filePrefix);
            results.poses.push({
                key: phrase.key,
                text: phrase.text,
                audioPath: generated.audioPath,
                generated: true
            });
        }

        for (const phrase of SUGGESTION_PHRASES) {
            const filePrefix = `suggestion_${phrase.key}`;
            const existing = getLatestWavByPrefix(filePrefix);

            if (existing && !force) {
                results.suggestions.push({
                    key: phrase.key,
                    text: phrase.text,
                    audioPath: `/audio/${existing.name}`,
                    generated: false
                });
                continue;
            }

            const generated = await generateTtsAudio(phrase.text, filePrefix);
            results.suggestions.push({
                key: phrase.key,
                text: phrase.text,
                audioPath: generated.audioPath,
                generated: true
            });
        }

        res.json({
            success: true,
            counts: {
                poses: results.poses.length,
                suggestions: results.suggestions.length,
                total: results.poses.length + results.suggestions.length
            },
            results
        });
    } catch (error) {
        console.error('Realtime pack pre-generation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/tts/pregenerated-pose-alerts', (req, res) => {
    try {
        const results = POSE_ALERT_PHRASES.map(phrase => {
            const existing = getLatestWavByPrefix(`pose_${phrase.key}`);
            return {
                key: phrase.key,
                text: phrase.text,
                ready: Boolean(existing),
                audioPath: existing ? `/audio/${existing.name}` : null
            };
        });

        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/tts/pregenerated-suggestions', (req, res) => {
    try {
        const results = SUGGESTION_PHRASES.map(phrase => {
            const existing = getLatestWavByPrefix(`suggestion_${phrase.key}`);
            return {
                key: phrase.key,
                text: phrase.text,
                ready: Boolean(existing),
                audioPath: existing ? `/audio/${existing.name}` : null
            };
        });

        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tts/speak-pose-alert', async (req, res) => {
    const { key } = req.body || {};
    const phrase = POSE_ALERT_PHRASES.find(item => item.key === key);

    if (!phrase) {
        return res.status(400).json({
            success: false,
            error: `Unknown pose alert key: ${key}`
        });
    }

    try {
        const filePrefix = `pose_${phrase.key}`;
        const existing = getLatestWavByPrefix(filePrefix);
        const result = existing
            ? { audioPath: `/audio/${existing.name}`, generated: false }
            : { ...(await generateTtsAudio(phrase.text, filePrefix)), generated: true };

        res.json({
            success: true,
            key: phrase.key,
            text: phrase.text,
            audioPath: result.audioPath,
            generated: result.generated
        });
    } catch (error) {
        console.error('Pose alert speak error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/tts/speak-suggestion', async (req, res) => {
    const { key } = req.body || {};
    const phrase = SUGGESTION_PHRASES.find(item => item.key === key);

    if (!phrase) {
        return res.status(400).json({
            success: false,
            error: `Unknown suggestion key: ${key}`
        });
    }

    try {
        const filePrefix = `suggestion_${phrase.key}`;
        const existing = getLatestWavByPrefix(filePrefix);
        const result = existing
            ? { audioPath: `/audio/${existing.name}`, generated: false }
            : { ...(await generateTtsAudio(phrase.text, filePrefix)), generated: true };

        res.json({
            success: true,
            key: phrase.key,
            text: phrase.text,
            audioPath: result.audioPath,
            generated: result.generated
        });
    } catch (error) {
        console.error('Suggestion speak error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function cleanupOldAudioFiles() {
    try {
        const files = fs.readdirSync(TTS_CONFIG.outputDir)
            .filter(file => file.startsWith('tts_') && file.endsWith('.wav'))
            .map(file => ({
                name: file,
                path: path.join(TTS_CONFIG.outputDir, file),
                time: fs.statSync(path.join(TTS_CONFIG.outputDir, file)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (files.length > TTS_CONFIG.maxAudioFiles) {
            files.slice(TTS_CONFIG.maxAudioFiles).forEach(file => {
                fs.unlinkSync(file.path);
                console.log('Cleaned up old TTS file:', file.name);
            });
        }
    } catch (error) {
        console.error('Error cleaning up audio files:', error);
    }
}

const useHttpsEnv = process.env.USE_HTTPS === '1' || process.env.USE_HTTPS === 'true';
const certDir = path.join(__dirname, 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const hasCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);

if (useHttpsEnv || hasCerts) {
    try {
        const https = require('https');
        const key = fs.readFileSync(keyPath);
        const cert = fs.readFileSync(certPath);
        const server = https.createServer({ key, cert }, app);

        server.listen(PORT, () => {
            console.log(`HTTPS server running at https://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start HTTPS server, falling back to HTTP:', error);
        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
        });
    }
} else {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}
