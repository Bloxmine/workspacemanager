const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const multer = require('multer');

let db;
try {
    db = require('./db');
} catch (error) {
    console.warn('db.js not found, running with in-memory no-op database fallback.');
    db = new Proxy({}, {
        get: (_, prop) => {
            if (prop === 'getDatabaseSize') {
                return () => ({ decisions_count: 0, preferences_count: 0 });
            }
            if (prop === 'getPreference') {
                return () => null;
            }
            if (typeof prop === 'string' && prop.startsWith('get')) {
                return () => [];
            }
            return () => true;
        }
    });
}

const app = express();
const PORT = 3000;

// Configuration
const HA_CONFIG = {
    baseUrl: 'http://homeassistant.local:8123',
    accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjZDE1ZGJlNDdlOTM0NzFlOTdhZjk1OTM2OTNmY2FiYiIsImlhdCI6MTc3MTIzMjE1OCwiZXhwIjoyMDg2NTkyMTU4fQ.D2xpyi2xgDgbzPzi-x45HnA_VS27atOx92-dMWC9-Rk'
};

const LLM_CONFIG = {
    baseUrl: process.env.LLM_BASE_URL || process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234',
    model: process.env.LLM_MODEL || 'google/gemma-3-4b'
};

const WEATHER_CONFIG = {
    latitude: 51.4817,
    longitude: 5.6606
};

const TTS_CONFIG = {
    model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',  // Alibaba's multilingual TTS
    voice: 'Chelsie',  // Voice preset
    pythonPath: process.env.PYTHON_BIN || path.join(__dirname, '.tts-venv', 'bin', 'python'),
    outputDir: path.join(__dirname, 'audio'),
    referenceDir: path.join(__dirname, 'audio/references'),  // For voice samples
    maxAudioFiles: 20 // Keep only last 20 audio files
};

const TTS_REFERENCE_AUDIO = path.join(TTS_CONFIG.referenceDir, 'voicesample.wav');
const TTS_REFERENCE_TEXT = 'Please do not adress this unit in that matter';

const WORKSPACE_LOG_CONFIG = {
    outputDir: path.join(__dirname, 'data', 'workspace-logs')
};

// Ensure audio directories exist
if (!fs.existsSync(TTS_CONFIG.outputDir)) {
    fs.mkdirSync(TTS_CONFIG.outputDir, { recursive: true });
}
if (!fs.existsSync(TTS_CONFIG.referenceDir)) {
    fs.mkdirSync(TTS_CONFIG.referenceDir, { recursive: true });
}
if (!fs.existsSync(WORKSPACE_LOG_CONFIG.outputDir)) {
    fs.mkdirSync(WORKSPACE_LOG_CONFIG.outputDir, { recursive: true });
}

// Configure multer for audio file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, TTS_CONFIG.referenceDir);
    },
    filename: (req, file, cb) => {
        // Keep original filename but sanitize it
        const sanitized = file.originalname.replace(/[^a-z0-9._-]/gi, '_');
        cb(null, `ref_${Date.now()}_${sanitized}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        // Accept audio files only
        if (file.mimetype.startsWith('audio/') || file.originalname.match(/\.(wav|mp3|m4a|flac|ogg)$/i)) {
            cb(null, true);
        } else {
            cb(new Error('Only audio files are allowed'));
        }
    }
});

app.use(express.json({ limit: '20mb' }));

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

// Serve static files (HTML, CSS, JS)
app.use(express.static(__dirname));

// Proxy endpoint for Home Assistant API
app.get('/api/sensor/:entityId', async (req, res) => {
    const entityId = req.params.entityId;
    
    try {
        const response = await fetch(`${HA_CONFIG.baseUrl}/api/states/${entityId}`, {
            headers: {
                'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Home Assistant API error: ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching sensor data:', error);
        res.status(500).json({ error: error.message });
    }
});

// List Home Assistant entities for UI auto-discovery helpers.
app.get('/api/ha/entities', async (req, res) => {
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
        res.json(Array.isArray(entities) ? entities : []);
    } catch (error) {
        console.error('Error fetching Home Assistant entities:', error);
        res.status(500).json({ error: error.message });
    }
});

// Service call endpoint for controlling devices
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

        if (!response.ok) {
            throw new Error(`Home Assistant API error: ${response.status}`);
        }

        const result = await response.json();
        res.json(result);
    } catch (error) {
        console.error('Error calling service:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sync Workspace Manager status into Home Assistant helper entities.
app.post('/api/workspace/status-sync', async (req, res) => {
    const {
        posture,
        recommendation,
        urgency,
        entities = {}
    } = req.body || {};

    const targetEntities = {
        posture: entities.posture || 'input_select.workspace_posture_state',
        recommendation: entities.recommendation || 'input_select.workspace_recommendation',
        urgency: entities.urgency || 'input_select.workspace_urgency'
    };

    const allowed = {
        posture: new Set(['focused', 'neutral', 'tired', 'absent', 'unknown']),
        recommendation: new Set(['focus_mode', 'break_mode', 'maintain']),
        urgency: new Set(['low', 'medium', 'high'])
    };

    const updates = [];

    if (typeof posture === 'string' && allowed.posture.has(posture)) {
        updates.push({
            key: 'posture',
            entity_id: targetEntities.posture,
            option: posture
        });
    }

    if (typeof recommendation === 'string' && allowed.recommendation.has(recommendation)) {
        updates.push({
            key: 'recommendation',
            entity_id: targetEntities.recommendation,
            option: recommendation
        });
    }

    if (typeof urgency === 'string' && allowed.urgency.has(urgency)) {
        updates.push({
            key: 'urgency',
            entity_id: targetEntities.urgency,
            option: urgency
        });
    }

    if (updates.length === 0) {
        return res.status(400).json({
            error: 'No valid status fields to sync. Provide posture/recommendation/urgency with allowed values.'
        });
    }

    try {
        const results = await Promise.allSettled(
            updates.map(update =>
                fetch(`${HA_CONFIG.baseUrl}/api/services/input_select/select_option`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        entity_id: update.entity_id,
                        option: update.option
                    })
                })
            )
        );

        const response = {
            success: true,
            updated: [],
            failed: []
        };

        results.forEach((result, index) => {
            const attempted = updates[index];

            if (result.status === 'fulfilled' && result.value.ok) {
                response.updated.push({
                    key: attempted.key,
                    entity_id: attempted.entity_id,
                    option: attempted.option
                });
            } else if (result.status === 'fulfilled') {
                response.failed.push({
                    key: attempted.key,
                    entity_id: attempted.entity_id,
                    option: attempted.option,
                    status: result.value.status
                });
            } else {
                response.failed.push({
                    key: attempted.key,
                    entity_id: attempted.entity_id,
                    option: attempted.option,
                    error: result.reason?.message || String(result.reason)
                });
            }
        });

        if (response.updated.length === 0) {
            return res.status(502).json({
                success: false,
                error: 'Failed to update Home Assistant helper entities',
                details: response.failed
            });
        }

        res.json(response);
    } catch (error) {
        console.error('Error syncing workspace status to HA:', error);
        res.status(500).json({ error: error.message });
    }
});

// Weather endpoint
app.get('/api/weather', async (req, res) => {
    try {
        const response = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_CONFIG.latitude}&longitude=${WEATHER_CONFIG.longitude}&current=temperature_2m,weather_code&timezone=Europe/Amsterdam`
        );

        if (!response.ok) {
            throw new Error(`Weather API error: ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching weather data:', error);
        res.status(500).json({ error: error.message });
    }
});

// LLM advice endpoint
app.post('/api/llm/advice', async (req, res) => {
    const { temperature, humidity, heatingData, weatherData, datetime } = req.body;
    
    try {
        // Build heating status info
        let heatingInfo = '';
        if (heatingData) {
            const hvacMode = heatingData.state || 'unknown';
            const targetTemp = heatingData.attributes?.temperature || 'not set';
            heatingInfo = `\n- Heating/AC Status: ${hvacMode}${targetTemp !== 'not set' ? ` (target: ${targetTemp}°C)` : ''}`;
        }

        // Build weather info
        let weatherInfo = '';
        if (weatherData) {
            weatherInfo = `\n- Outdoor Temperature: ${weatherData.temperature}°C`;
            if (weatherData.description) {
                weatherInfo += `\n- Weather Conditions: ${weatherData.description}`;
            }
        }

        // Build time/date info
        let timeInfo = '';
        if (datetime) {
            const date = new Date(datetime);
            const month = date.toLocaleString('en-US', { month: 'long' });
            const season = ['Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Autumn', 'Autumn', 'Autumn', 'Winter'][date.getMonth()];
            timeInfo = `\n- Current Time: ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}\n- Date: ${date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n- Season: ${season}`;
        }

        const prompt = `Current conditions:\n\nIndoor:
- Temperature: ${temperature}°C
- Humidity: ${humidity}%${heatingInfo}${weatherInfo}${timeInfo}

Based on these conditions, provide brief, practical advice (2-3 sentences max) about the indoor climate. Consider comfort, health, energy efficiency, and outdoor conditions. If heating/cooling is on, factor that into your advice about opening windows or doors.`;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 150
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        
        // Extract the advice from the response
        const advice = data.choices?.[0]?.message?.content || 'No advice available';
        
        res.json({ advice, prompt });
    } catch (error) {
        console.error('Error getting LLM advice:', error);
        res.status(500).json({ error: error.message, advice: 'Unable to get advice at this time.' });
    }
});

// Get AI actions (JSON format)
app.post('/api/llm/actions', async (req, res) => {
    try {
        const { temperature, humidity, heatingData, weatherData, datetime } = req.body;
        
        // Build heating info
        let heatingInfo = '';
        if (heatingData) {
            heatingInfo = `\n- AC Status: ${heatingData.state || 'unknown'}`;
            if (heatingData.currentTemp) {
                heatingInfo += `\n- AC Current Temperature: ${heatingData.currentTemp}°C`;
            }
            if (heatingData.targetTemp) {
                heatingInfo += `\n- AC Target Temperature: ${heatingData.targetTemp}°C`;
            }
            if (heatingData.mode) {
                heatingInfo += `\n- AC Mode: ${heatingData.mode}`;
            }
        }
        
        // Build weather info
        let weatherInfo = '';
        if (weatherData) {
            weatherInfo = `\n\nOutdoor (Helmond):
- Temperature: ${weatherData.temperature}°C`;
            if (weatherData.description) {
                weatherInfo += `\n- Weather Conditions: ${weatherData.description}`;
            }
        }
        
        // Build time info
        let timeInfo = '';
        if (datetime) {
            timeInfo = `\n\nTime Context:
- Current Time: ${datetime.time}
- Date: ${datetime.date}
- Season: ${datetime.season}`;
        }

        const prompt = `Current conditions:\n\nIndoor:
- Temperature: ${temperature}°C
- Humidity: ${humidity}%${heatingInfo}${weatherInfo}${timeInfo}

Based on these conditions, provide ONLY a JSON array of recommended actions. Each action should be a JSON object with: device (entity_id), action (service call), value (if applicable), and reason (brief explanation).

Example format:
{
  "actions": [
    {
      "device": "climate.air_conditioning_woonkamer",
      "action": "set_temperature",
      "value": 22,
      "reason": "Reduce temperature by 2°C to save energy while maintaining comfort"
    },
    {
      "device": "climate.air_conditioning_woonkamer",
      "action": "set_hvac_mode",
      "value": "cool",
      "reason": "Switch to cooling mode due to high indoor temperature"
    }
  ]
}

Return ONLY valid JSON, no other text. If no actions are needed, return empty actions array.`;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.5,
                max_tokens: 300
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        
        // Extract the JSON response
        let actionsText = data.choices?.[0]?.message?.content || '{"actions": []}';
        
        // Try to parse the JSON
        try {
            // Remove markdown code blocks if present
            actionsText = actionsText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const actionsData = JSON.parse(actionsText);
            res.json(actionsData);
        } catch (parseError) {
            console.error('Error parsing LLM JSON response:', parseError);
            res.json({ actions: [], error: 'Unable to parse actions' });
        }
    } catch (error) {
        console.error('Error getting LLM actions:', error);
        res.status(500).json({ actions: [], error: error.message });
    }
});

// Mood-based lighting advice endpoint
app.post('/api/mood/advice', async (req, res) => {
    try {
        const { mood } = req.body;
        
        // Available lights configuration
        const availableLights = [
            { id: 'light.bureaulamp', name: 'Bureau Lamp', dimmable: true, colorTemp: true },
            { id: 'light.leeslamp', name: 'Lees Lamp', dimmable: true, colorTemp: true },
            { id: 'light.tafellamp', name: 'Tafel Lamp', dimmable: true, colorTemp: true },
            { id: 'light.lightbulb', name: 'Light Bulb', dimmable: true, colorTemp: true },
            { id: 'light.nachtlampje', name: 'Nacht Lampje', dimmable: false, colorTemp: false },
            { id: 'light.bureaulampjes', name: 'Bureau Lampjes', dimmable: false, colorTemp: false },
            { id: 'light.tv_lamp', name: 'TV Lamp', dimmable: false, colorTemp: false },
            { id: 'light.banklamp', name: 'Bank Lamp', dimmable: false, colorTemp: false }
        ];

        const lightsInfo = availableLights.map(l => 
            `${l.name} (${l.id})${l.dimmable ? ' - supports brightness (0-100%)' : ''}${l.colorTemp ? ' and color temperature (153-500K)' : ''}`
        ).join('\n');

        const prompt = `The user's detected mood is: ${mood}

Available lights in the home:
${lightsInfo}

Based on the user's ${mood} mood, provide:
1. A brief explanation (2-3 sentences) of how lighting can support this mood
2. Specific recommendations for which lights to turn on/off, what brightness levels, and color temperatures

Guidelines:
- Happy/Excited: Bright, warm lighting (high brightness 80-100%, warmer color temp 300-400K)
- Sad/Down: Gentle, warm lighting (medium brightness 40-60%, warm color temp 350-450K)
- Angry/Stressed: Calming, cool lighting (medium brightness 50-70%, cooler color temp 250-350K)
- Focused/Concentrated: Bright, neutral lighting (high brightness 80-100%, neutral temp 300-350K)
- Surprised: Bright, alert lighting (high brightness 90-100%, cooler temp 250-300K)
- Neutral/Calm: Balanced lighting (medium brightness 60-80%, neutral temp 300-350K)

Return your response in this EXACT JSON format:
{
  "advice": "Brief explanation text here",
  "recommendations": [
    {
      "entityId": "light.bureaulamp",
      "name": "Bureau Lamp",
      "state": "on",
      "brightness": 80,
      "colorTemp": 350
    }
  ]
}

Important:
- Only include "brightness" and "colorTemp" for dimmable lights that support them
- For non-dimmable lights, only include "state" (on/off)
- Recommend 3-5 lights maximum
- Return ONLY valid JSON, no other text`;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content || '{"advice": "Unable to generate recommendations", "recommendations": []}';
        
        // Try to parse the JSON response
        try {
            // Remove markdown code blocks if present
            responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const moodData = JSON.parse(responseText);
            res.json(moodData);
        } catch (parseError) {
            console.error('Error parsing mood advice JSON:', parseError);
            res.json({ 
                advice: 'Unable to parse lighting recommendations at this time.',
                recommendations: []
            });
        }
    } catch (error) {
        console.error('Error getting mood advice:', error);
        res.status(500).json({ 
            advice: 'Unable to get lighting recommendations at this time.',
            recommendations: [],
            error: error.message 
        });
    }
});

// Scene analysis endpoint
app.post('/api/scene/advice', async (req, res) => {
    const { objects, image, room = 'all' } = req.body;
    
    try {
        // Get current time context
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const dateString = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const hour = now.getHours();
        let timeOfDay = 'morning';
        if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
        else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
        else if (hour >= 21 || hour < 6) timeOfDay = 'night';
        
        // Build objects description
        const objectsList = Object.entries(objects)
            .map(([obj, count]) => count > 1 ? `${count} ${obj}s` : `1 ${obj}`)
            .join(', ');
        
        // All available devices with room tags
        const allDevices = [
            { entityId: 'light.bureaulamp', name: 'Desk Lamp', type: 'dimmable_light', room: 'bedroom' },
            { entityId: 'light.leeslamp', name: 'Reading Lamp', type: 'dimmable_light', room: 'bedroom' },
            { entityId: 'light.tafellamp', name: 'Table Lamp', type: 'dimmable_light', room: 'bedroom' },
            { entityId: 'light.lightbulb', name: 'Attic Light', type: 'dimmable_light', room: 'attic' },
            { entityId: 'light.nachtlampje', name: 'Night Light', type: 'simple_light', room: 'bedroom' },
            { entityId: 'light.bureaulampjes', name: 'Small Desk Lights', type: 'simple_light', room: 'bedroom' },
            { entityId: 'light.tv_lamp', name: 'TV Light', type: 'simple_light', room: 'living_room' },
            { entityId: 'light.banklamp', name: 'Couch Light', type: 'simple_light', room: 'living_room' },
            { entityId: 'climate.air_conditioning_woonkamer', name: 'Living Room AC', type: 'climate', room: 'living_room' },
            { entityId: 'switch.outlet', name: 'Coffee Maker', type: 'switch', room: 'kitchen' }
        ];
        
        // Filter devices based on selected room
        const availableDevices = room === 'all' 
            ? allDevices 
            : allDevices.filter(device => device.room === room);
        
        const roomName = room === 'all' ? 'the house' : room.replace('_', ' ');
        
        const prompt = `You are a smart home assistant. Analyze the current scene and suggest appropriate home automation actions.

CURRENT SCENE:
- Location: ${roomName}
- Time: ${timeString} (${timeOfDay})
- Date: ${dateString}
- Detected objects: ${objectsList}
${image ? '- An image of the scene is provided for visual context' : ''}

AVAILABLE DEVICES IN THIS ROOM:
${availableDevices.map(d => `- ${d.name} (${d.entityId})`).join('\n')}

${image ? 'Look at the provided image carefully to understand the context, positioning, and activity happening in the scene.' : ''} Based on the detected objects${image ? ', the visual scene,' : ''} and time of day, determine what activity the person is likely doing and suggest appropriate lighting, climate, and device settings.

ACTIVITY EXAMPLES:
- laptop + person = working (bright task lighting)
- book + person = reading (focused reading light)
- cell phone + couch/chair = relaxing (ambient lighting)
- cup/bottle + person = eating/drinking (moderate lighting)
- tv + person + evening/night = watching TV (dim ambient lighting)
- person + bed = sleeping/resting (minimal/no lighting)

Provide your response in JSON format:
{
    "advice": "Brief description of detected activity and why these settings are recommended (2-3 sentences)",
    "recommendations": [
        {
            "entityId": "light.example",
            "name": "Device Name",
            "state": "on/off",
            "action": "Brief description of action",
            "brightness": 80,
            "colorTemp": 350,
            "temperature": 22,
            "hvac_mode": "cool"
        }
    ]
}

Note: brightness is 0-100%, colorTemp is 153-500K (warm to cool). Only include brightness/colorTemp for dimmable lights. For climate, include temperature and hvac_mode.`;

        // Prepare message content with image if provided
        let messageContent;
        if (image) {
            // Vision-enabled message format with image
            messageContent = [
                {
                    type: 'text',
                    text: prompt
                },
                {
                    type: 'image_url',
                    image_url: {
                        url: image
                    }
                }
            ];
        } else {
            // Text-only fallback
            messageContent = prompt;
        }

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'user',
                        content: messageContent
                    }
                ],
                temperature: 0.7,
                max_tokens: 600
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content || '{"advice": "Unable to analyze scene", "recommendations": []}';
        
        // Try to parse the JSON response
        try {
            // Remove markdown code blocks if present
            responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const sceneData = JSON.parse(responseText);
            res.json(sceneData);
        } catch (parseError) {
            console.error('Error parsing scene advice JSON:', parseError);
            res.json({ 
                advice: 'Unable to parse scene recommendations at this time.',
                recommendations: []
            });
        }
    } catch (error) {
        console.error('Error getting scene advice:', error);
        res.status(500).json({ 
            advice: 'Unable to analyze scene at this time.',
            recommendations: [],
            error: error.message 
        });
    }
});

// ============================================
// TEST ENVIRONMENT ENDPOINTS
// ============================================

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GREENHOUSE TEST ENDPOINTS
app.get('/api/greenhouse/data', async (req, res) => {
    try {
        // Try to fetch from actual Home Assistant sensors first
        // If they don't exist, return dummy data for testing
        
        const sensors = {
            soilMoisture: 'sensor.greenhouse_soil_moisture',
            lightLevel: 'sensor.greenhouse_light_level',
            temperature: 'sensor.greenhouse_temperature',
            humidity: 'sensor.greenhouse_humidity'
        };

        const data = {};
        let useDummyData = false;

        // Try to fetch each sensor
        for (const [key, entityId] of Object.entries(sensors)) {
            try {
                const response = await fetch(`${HA_CONFIG.baseUrl}/api/states/${entityId}`, {
                    headers: {
                        'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (response.ok) {
                    const sensorData = await response.json();
                    data[key] = {
                        value: parseFloat(sensorData.state),
                        status: 'optimal' // You can calculate status based on thresholds
                    };
                } else {
                    useDummyData = true;
                    break;
                }
            } catch (error) {
                useDummyData = true;
                break;
            }
        }

        // Generate dummy data if sensors aren't available
        if (useDummyData) {
            const moistureVal = 35 + Math.random() * 30; // 35-65%
            const lightVal = 400 + Math.random() * 1200; // 400-1600 lux
            
            res.json({
                soilMoisture: {
                    value: moistureVal,
                    status: moistureVal < 45 ? 'low' : moistureVal < 55 ? 'optimal' : 'high'
                },
                lightLevel: {
                    value: Math.floor(lightVal),
                    status: lightVal < 700 ? 'low' : lightVal < 1400 ? 'optimal' : 'high'
                },
                temperature: {
                    value: parseFloat((20 + Math.random() * 5).toFixed(1)),
                    status: 'optimal'
                },
                humidity: {
                    value: parseFloat((50 + Math.random() * 20).toFixed(1)),
                    status: 'optimal'
                },
                healthScore: Math.floor(75 + Math.random() * 20)
            });
        } else {
            // Calculate health score based on actual data
            data.healthScore = 85; // Simple placeholder
            res.json(data);
        }
    } catch (error) {
        console.error('Error getting greenhouse data:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/greenhouse/decision', async (req, res) => {
    try {
        const { plantInfo, currentReadings } = req.body;

        const prompt = `You are a smart greenhouse controller. Analyze the plant's current condition and decide if any actions are needed.

PLANT INFORMATION:
- Species: ${plantInfo.species}
- Nickname: ${plantInfo.name}
- Pot Size: ${plantInfo.potSize}
- Care Instructions:
  * Watering: ${plantInfo.careInstructions.water}
  * Light: ${plantInfo.careInstructions.light}
  * Optimal Moisture: ${plantInfo.careInstructions.optimalMoisture}
  * Optimal Light: ${plantInfo.careInstructions.optimalLight}

CURRENT READINGS:
- Soil Moisture: ${currentReadings.soilMoisture.value}% (Status: ${currentReadings.soilMoisture.status})
- Light Level: ${currentReadings.lightLevel.value} lux (Status: ${currentReadings.lightLevel.status})
- Temperature: ${currentReadings.temperature.value}°C (Status: ${currentReadings.temperature.status})
- Humidity: ${currentReadings.humidity.value}% (Status: ${currentReadings.humidity.status})
- Health Score: ${currentReadings.healthScore}%

AVAILABLE ACTUATORS:
- water_pump: Can water the plant for a specified duration (1-10 seconds)
- grow_light: Can be turned on/off to provide supplemental lighting

Based on the plant's needs and current readings, decide what actions (if any) should be taken. Return your response in this EXACT JSON format:

{
  "actions": [
    {
      "device": "water_pump",
      "command": "activate",
      "duration_seconds": 5,
      "reasoning": "Detailed explanation of why this action is needed",
      "necessarytotake": "yes"
    }
  ]
}

IMPORTANT DECISION CRITERIA:
- Only recommend watering if soil moisture is significantly below optimal range
- Consider the health score - if plant is thriving, minimal intervention is best
- If readings are within acceptable ranges, return empty actions array
- The "necessarytotake" field should be "yes" only if action is truly needed, "no" if it's optional
- Be conservative with watering - overwatering kills more plants than underwatering

Return ONLY valid JSON, no other text.`;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.5,
                max_tokens: 400
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content || '{"actions": []}';
        
        // Parse JSON response
        try {
            responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const decision = JSON.parse(responseText);
            res.json(decision);
        } catch (parseError) {
            console.error('Error parsing greenhouse decision JSON:', parseError);
            res.json({ actions: [] });
        }
    } catch (error) {
        console.error('Error getting greenhouse decision:', error);
        res.status(500).json({ actions: [], error: error.message });
    }
});

app.post('/api/greenhouse/water', async (req, res) => {
    const { duration = 5 } = req.body;
    
    try {
        // Try to call actual water pump switch in Home Assistant
        const response = await fetch(`${HA_CONFIG.baseUrl}/api/services/switch/turn_on`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                entity_id: 'switch.greenhouse_water_pump'
            })
        });

        // Simulate watering delay
        setTimeout(async () => {
            await fetch(`${HA_CONFIG.baseUrl}/api/services/switch/turn_off`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    entity_id: 'switch.greenhouse_water_pump'
                })
            });
        }, duration * 1000);

        res.json({ success: true, duration });
    } catch (error) {
        // If actual device doesn't exist, just simulate success
        console.log('Simulated watering (no actual device)');
        res.json({ success: true, duration, simulated: true });
    }
});

app.post('/api/greenhouse/light', async (req, res) => {
    try {
        // Try to toggle actual grow light
        const response = await fetch(`${HA_CONFIG.baseUrl}/api/services/light/toggle`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                entity_id: 'light.greenhouse_grow_light'
            })
        });

        if (response.ok) {
            const result = await response.json();
            res.json({ success: true });
        } else {
            throw new Error('Device not found');
        }
    } catch (error) {
        // Simulate if device doesn't exist
        console.log('Simulated light toggle (no actual device)');
        res.json({ success: true, simulated: true });
    }
});

// LIVING ROOM TEST ENDPOINTS
app.post('/api/livingroom/analyze', async (req, res) => {
    try {
        const { room_state } = req.body;

        const prompt = `You are a smart home AI analyzing a living room scene. Use sensor fusion to understand the context and recommend appropriate actions.

ROOM STATE:
- Location: ${room_state.location}
- Time: ${room_state.time}
- Occupants: ${room_state.occupants}
- Visual Tags: ${room_state.visual_tags.join(', ')}
- Audio Tags: ${room_state.audio_tags.join(', ')}
- Current Device Status:
  * TV: ${room_state.device_status.tv}
  * Lights: ${room_state.device_status.lights}
  * Thermostat: ${room_state.device_status.thermostat}

ANALYSIS TASK:
Based on the combination of visual and audio cues, infer what activity is happening and determine the appropriate mode.

ACTIVITY INFERENCE EXAMPLES:
- Visual: people_sitting + book + Audio: silence/page_turning → "Reading Mode"
- Visual: people_sitting + tv_active + Audio: dialogue/music/explosions → "Cinema Mode"
- Visual: people_standing + multiple_people + Audio: loud_speech/laughter → "Social/Party Mode"
- Visual: laptop/desk + Audio: keyboard_typing → "Working Mode"

AVAILABLE ACTIONS:
- Adjust lights (brightness, color temperature)
- Adjust thermostat (temperature, mode)
- Control window blinds
- Send notifications

Provide your response in this EXACT JSON format:
{
  "inferredMode": "Cinema Mode",
  "activityLevel": "Low",
  "reasoning": "Brief explanation of how you inferred this mode",
  "actions": [
    {
      "device": "light.banklamp",
      "action": "set brightness to 10%",
      "service": "turn_on",
      "domain": "light",
      "data": {"brightness_pct": 10},
      "reason": "Dim lights for cinema atmosphere"
    }
  ]
}

Return ONLY valid JSON, no other text.`;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.6,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content || '{"inferredMode": "Unknown", "actions": []}';
        
        // Parse JSON response
        try {
            responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const analysis = JSON.parse(responseText);
            res.json(analysis);
        } catch (parseError) {
            console.error('Error parsing living room analysis JSON:', parseError);
            res.json({ inferredMode: 'Unknown', activityLevel: 'Unknown', actions: [] });
        }
    } catch (error) {
        console.error('Error analyzing living room context:', error);
        res.status(500).json({ inferredMode: 'Error', actions: [], error: error.message });
    }
});

// BUTLER TEST ENDPOINTS
app.post('/api/butler/evaluate', async (req, res) => {
    try {
        const { userContext, pendingMessages } = req.body;

        const messagesDescription = pendingMessages.map(msg => 
            `- "${msg.title}": ${msg.body} (Priority: ${msg.priority})`
        ).join('\n');

        const prompt = `You are an intelligent home assistant following "The Alfred Protocol" - knowing when to speak and when to stay silent.

USER CONTEXT:
- Status: ${userContext.status}
- Interruptibility Score: ${userContext.interruptibilityScore}/10
- Heart Rate: ${userContext.heartRate}
- Movement: ${userContext.movement}
- Location: ${userContext.location}

INTERRUPTIBILITY GUIDELINES:
- Score 0: Critical emergencies only (fire, intruder, medical)
- Score 1-3: Silent notifications only (LED pulse, no voice)
- Score 4-6: Low-priority voice allowed if message is brief
- Score 7-9: Full conversational ability
- Score 10: Can deliver full briefing/status update

PENDING MESSAGES:
${messagesDescription}

For each message, decide the appropriate delivery method based on the user's interruptibility score and the message priority.

DELIVERY OPTIONS:
- "withhold": Don't deliver the message right now, save for later
- "silent": LED pulse or visual notification only
- "ambient": Subtle chime or light pattern
- "voice": Spoken delivery
- "critical": Override all settings and deliver immediately

Provide your response in this EXACT JSON format:
{
  "decisions": [
    {
      "message": {message_object},
      "decision": "withhold|silent|ambient|voice|critical",
      "reasoning": "Why this delivery method was chosen",
      "alternativeAction": "What visual cue to use instead (if not voice)"
    }
  ]
}

CRITICAL RULE: Respect the interruptibility score. A low score means the user DOES NOT want to be disturbed unless it's truly critical. High-priority messages can elevate the delivery method, but only to the next level (e.g., from withhold to silent, not from withhold to voice).

Return ONLY valid JSON, no other text.`;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.4,
                max_tokens: 600
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content || '{"decisions": []}';
        
        // Parse JSON response
        try {
            responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const evaluation = JSON.parse(responseText);
            res.json(evaluation);
        } catch (parseError) {
            console.error('Error parsing butler evaluation JSON:', parseError);
            
            // Fallback to rule-based logic
            const fallbackDecisions = pendingMessages.map(msg => {
                let decision = 'withhold';
                let reasoning = 'Score too low for delivery';
                
                if (msg.priority === 'critical' || msg.priority === 'high') {
                    if (userContext.interruptibilityScore >= 3) {
                        decision = 'voice';
                        reasoning = 'High priority message and user is interruptible';
                    } else {
                        decision = 'silent';
                        reasoning = 'High priority but user cannot be vocally interrupted';
                    }
                } else if (userContext.interruptibilityScore >= 7) {
                    decision = 'voice';
                    reasoning = 'User is highly interruptible';
                } else if (userContext.interruptibilityScore >= 4) {
                    decision = 'ambient';
                    reasoning = 'User is moderately interruptible';
                }

                return {
                    message: msg,
                    decision,
                    reasoning,
                    alternativeAction: decision === 'silent' ? 'Pulse kitchen light strip blue' : null
                };
            });

            res.json({ decisions: fallbackDecisions });
        }
    } catch (error) {
        console.error('Error evaluating butler messages:', error);
        res.status(500).json({ decisions: [], error: error.message });
    }
});

// ============================================
// MEMORY & LEARNING ENDPOINTS
// ============================================

// Log a decision (called automatically after AI makes a decision)
app.post('/api/memory/decision', (req, res) => {
    try {
        const decisionId = db.logDecision(req.body);
        db.logEvent('decision_made', `Decision ${decisionId} logged for ${req.body.test_environment}`, 'info', 'memory_system');
        res.json({ success: true, decisionId });
    } catch (error) {
        console.error('Error logging decision:', error);
        res.status(500).json({ error: error.message });
    }
});

// Submit feedback on a decision
app.post('/api/memory/feedback', (req, res) => {
    try {
        const { decisionId, rating, comment } = req.body;
        db.updateDecisionFeedback(decisionId, rating, comment);
        db.logEvent('feedback_received', `Decision ${decisionId} rated ${rating}/5`, 'info', 'user');
        
        // Trigger learning from feedback
        if (rating >= 4) {
            db.learnFromFeedback();
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving feedback:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get recent decisions
app.get('/api/memory/decisions', (req, res) => {
    try {
        const { testEnvironment, limit } = req.query;
        const decisions = db.getRecentDecisions(testEnvironment, parseInt(limit) || 50);
        res.json(decisions);
    } catch (error) {
        console.error('Error fetching decisions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get decision statistics
app.get('/api/memory/stats', (req, res) => {
    try {
        const { testEnvironment } = req.query;
        const stats = db.getDecisionStats(testEnvironment);
        res.json(stats);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// PREFERENCES ENDPOINTS
// ============================================

app.post('/api/preferences', (req, res) => {
    try {
        const { key, value, learnedFrom } = req.body;
        db.setPreference(key, value, learnedFrom);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/preferences', (req, res) => {
    try {
        const preferences = db.getAllPreferences();
        res.json(preferences);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/preferences/:key', (req, res) => {
    try {
        const pref = db.getPreference(req.params.key);
        res.json(pref || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// PLANT PROFILES ENDPOINTS
// ============================================

app.post('/api/greenhouse/profiles', (req, res) => {
    try {
        db.savePlantProfile(req.body);
        db.logEvent('profile_saved', `Plant profile "${req.body.profile_name}" saved`, 'info', 'greenhouse');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/greenhouse/profiles', (req, res) => {
    try {
        const profiles = db.getAllPlantProfiles();
        res.json(profiles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/greenhouse/profiles/:name', (req, res) => {
    try {
        const profile = db.getPlantProfile(req.params.name);
        res.json(profile || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/greenhouse/profiles/:name', (req, res) => {
    try {
        db.deletePlantProfile(req.params.name);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ROOM SCENARIOS ENDPOINTS
// ============================================

app.post('/api/livingroom/scenarios', (req, res) => {
    try {
        db.saveRoomScenario(req.body);
        db.logEvent('scenario_saved', `Room scenario "${req.body.scenario_name}" saved`, 'info', 'livingroom');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/livingroom/scenarios', (req, res) => {
    try {
        const scenarios = db.getAllRoomScenarios();
        res.json(scenarios);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/livingroom/scenarios/:name', (req, res) => {
    try {
        const scenario = db.getRoomScenario(req.params.name);
        res.json(scenario || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/livingroom/scenarios/:name', (req, res) => {
    try {
        db.deleteRoomScenario(req.params.name);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ROUTINES ENDPOINTS
// ============================================

app.post('/api/routines', (req, res) => {
    try {
        db.saveRoutine(req.body);
        db.logEvent('routine_saved', `Routine "${req.body.routine_name}" created`, 'info', 'routines');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/routines', (req, res) => {
    try {
        const routines = db.getAllRoutines();
        res.json(routines);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/routines/:name', (req, res) => {
    try {
        const routine = db.getRoutine(req.params.name);
        res.json(routine || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/routines/:name/execute', async (req, res) => {
    try {
        const routine = db.getRoutine(req.params.name);
        if (!routine || !routine.enabled) {
            return res.status(404).json({ error: 'Routine not found or disabled' });
        }

        const { simulationMode } = req.body;
        const results = [];

        // Execute each action
        for (const action of routine.actions) {
            if (!simulationMode) {
                // Call Home Assistant service
                const response = await fetch(`${HA_CONFIG.baseUrl}/api/services/${action.domain}/${action.service}`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        entity_id: action.entityId,
                        ...action.data
                    })
                });

                results.push({
                    action: action.description,
                    status: response.ok ? 'success' : 'failed'
                });
            } else {
                results.push({
                    action: action.description,
                    status: 'simulated'
                });
            }
        }

        if (!simulationMode) {
            db.updateRoutineExecution(req.params.name);
        }
        
        db.logEvent('routine_executed', `Routine "${req.params.name}" executed (${simulationMode ? 'simulated' : 'live'})`, 'info', 'routines');
        res.json({ success: true, results });
    } catch (error) {
        console.error('Error executing routine:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/routines/:name/toggle', (req, res) => {
    try {
        const { enabled } = req.body;
        db.toggleRoutine(req.params.name, enabled);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/routines/:name', (req, res) => {
    try {
        db.deleteRoutine(req.params.name);
        db.logEvent('routine_deleted', `Routine "${req.params.name}" deleted`, 'warning', 'routines');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ANALYTICS ENDPOINTS
// ============================================

app.get('/api/analytics/dashboard', (req, res) => {
    try {
        const stats = db.getDashboardStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/analytics/timeline', (req, res) => {
    try {
        const testEnvironment = req.query.environment;
        const limit = parseInt(req.query.limit) || 50;
        const timeline = db.getRecentDecisions(testEnvironment, limit);
        res.json(timeline);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/analytics/feedback', (req, res) => {
    try {
        const { testEnvironment } = req.query;
        const distribution = db.getFeedbackDistribution(testEnvironment);
        res.json(distribution);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/analytics/export', (req, res) => {
    try {
        const { testEnvironment, days } = req.query;
        const decisions = db.getRecentDecisions(testEnvironment, parseInt(days) * 100 || 1000);
        
        // Convert to CSV
        const headers = ['timestamp', 'test_environment', 'decision_type', 'reasoning', 'feedback_rating', 'response_time_ms'];
        const csv = [headers.join(',')];
        
        decisions.forEach(d => {
            const row = [
                d.timestamp,
                d.test_environment,
                d.decision_type,
                `"${(d.reasoning || '').replace(/"/g, '""')}"`,
                d.feedback_rating || '',
                d.response_time_ms || ''
            ];
            csv.push(row.join(','));
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=decisions_export.csv');
        res.send(csv.join('\n'));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// CHAOS ENGINEERING ENDPOINTS
// ============================================

app.post('/api/chaos/inject', async (req, res) => {
    try {
        const { testType, failureType, testEnvironment } = req.body;
        const startTime = Date.now();
        
        let injectedData = {};
        let aiResponse = '';
        
        // Inject failure based on type
        switch (failureType) {
            case 'sensor_failure':
                injectedData = { sensor: 'offline', errorCode: 'TIMEOUT' };
                break;
            case 'conflicting_data':
                injectedData = { temperature: 75, humidity: 5, conflict: true }; // Impossible: high temp + very low humidity
                break;
            case 'extreme_values':
                injectedData = { soilMoisture: 100, light: 0, temperature: 95 };
                break;
            case 'network_failure':
                injectedData = { error: 'Network unreachable', retries: 3 };
                break;
            default:
                injectedData = { error: 'Unknown failure type' };
        }
        
        // Send to LLM to see how it responds
        const prompt = `You are a smart home AI. A sensor failure has occurred:
Failure Type: ${failureType}
Test Environment: ${testEnvironment}
Data: ${JSON.stringify(injectedData)}

How should you respond to this failure? What actions (if any) should you take?
Provide your response as JSON with: {safe_mode: boolean, actions: [], reasoning: string}`;

        try {
            const llmResponse = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: LLM_CONFIG.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.4
                })
            });

            if (llmResponse.ok) {
                const llmData = await llmResponse.json();
                aiResponse = llmData.choices[0].message.content;
            }
        } catch (llmError) {
            aiResponse = `LLM Error: ${llmError.message}`;
        }
        
        const recoveryTime = Date.now() - startTime;
        const success = aiResponse.includes('safe_mode') || aiResponse.includes('reasoning');
        
        // Log chaos test
        const chaosId = db.logChaosTest({
            test_type: testType,
            injected_failure: `${failureType}: ${JSON.stringify(injectedData)}`,
            ai_response: aiResponse,
            recovery_time_ms: recoveryTime,
            success,
            notes: req.body.notes || null
        });
        
        db.logEvent('chaos_test', `Chaos test ${chaosId}: ${failureType}`, 'warning', 'chaos_simulator');
        
        res.json({
            success: true,
            chaosId,
            injectedData,
            aiResponse,
            recoveryTime,
            handled: success
        });
    } catch (error) {
        console.error('Error in chaos test:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/chaos/tests', (req, res) => {
    try {
        const tests = db.getChaosTests(parseInt(req.query.limit) || 50);
        const successRate = db.getChaosSuccessRate();
        res.json({ tests, successRate });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// KILL SWITCH ENDPOINT
// ============================================

let aiControlEnabled = true;
let lastDisabledBy = null;
let lastDisabledAt = null;

app.post('/api/killswitch', (req, res) => {
    try {
        const { enabled, reason } = req.body;
        aiControlEnabled = enabled;
        
        if (!enabled) {
            lastDisabledBy = reason || 'manual';
            lastDisabledAt = new Date().toISOString();
            db.logEvent('killswitch_activated', `AI control disabled: ${reason}`, 'critical', 'killswitch');
        } else {
            db.logEvent('killswitch_deactivated', 'AI control re-enabled', 'warning', 'killswitch');
        }
        
        res.json({ 
            success: true, 
            aiControlEnabled,
            lastDisabledBy,
            lastDisabledAt
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/killswitch/status', (req, res) => {
    res.json({ 
        aiControlEnabled,
        lastDisabledBy,
        lastDisabledAt
    });
});

// Middleware to check kill switch before AI actions
function checkKillSwitch(req, res, next) {
    if (!aiControlEnabled && !req.body.simulationMode) {
        return res.status(403).json({ 
            error: 'AI control is disabled',
            reason: lastDisabledBy,
            disabledAt: lastDisabledAt
        });
    }
    next();
}

// ============================================
// SYSTEM EVENTS ENDPOINTS
// ============================================

app.get('/api/events', (req, res) => {
    try {
        const { type, limit } = req.query;
        const events = type ? db.getEventsByType(type) : db.getRecentEvents(parseInt(limit) || 100);
        res.json(events);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/events', (req, res) => {
    try {
        const { eventType, description, severity, source, metadata } = req.body;
        db.logEvent(eventType, description, severity, source, metadata);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENTITY AUTO-DISCOVERY
// ============================================

app.get('/api/ha/discover', async (req, res) => {
    try {
        const response = await fetch(`${HA_CONFIG.baseUrl}/api/states`, {
            headers: {
                'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch entities from Home Assistant');
        }

        const entities = await response.json();
        
        // Categorize entities by domain
        const categorized = {
            sensors: entities.filter(e => e.entity_id.startsWith('sensor.')),
            lights: entities.filter(e => e.entity_id.startsWith('light.')),
            switches: entities.filter(e => e.entity_id.startsWith('switch.')),
            climate: entities.filter(e => e.entity_id.startsWith('climate.')),
            binary_sensors: entities.filter(e => e.entity_id.startsWith('binary_sensor.')),
            cameras: entities.filter(e => e.entity_id.startsWith('camera.')),
            media_players: entities.filter(e => e.entity_id.startsWith('media_player.')),
            covers: entities.filter(e => e.entity_id.startsWith('cover.')),
            locks: entities.filter(e => e.entity_id.startsWith('lock.'))
        };
        
        db.logEvent('entity_discovery', `Discovered ${entities.length} entities`, 'info', 'ha_api');
        
        res.json({
            total: entities.length,
            categorized,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error discovering entities:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SCENE CAPTURE & RESTORE
// ============================================

app.post('/api/scenes/capture', async (req, res) => {
    try {
        const { sceneName, entities } = req.body;
        
        // Fetch current state of all specified entities
        const states = [];
        for (const entityId of entities) {
            try {
                const response = await fetch(`${HA_CONFIG.baseUrl}/api/states/${entityId}`, {
                    headers: {
                        'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (response.ok) {
                    const state = await response.json();
                    states.push({
                        entity_id: entityId,
                        state: state.state,
                        attributes: state.attributes
                    });
                }
            } catch (err) {
                console.error(`Failed to get state for ${entityId}:`, err);
            }
        }
        
        // Save as room scenario
        db.saveRoomScenario({
            scenario_name: sceneName,
            visual_tags: [],
            audio_tags: [],
            expected_actions: states.map(s => ({ entity: s.entity_id, state: s.state })),
            device_states: states
        });
        
        db.logEvent('scene_captured', `Scene "${sceneName}" captured with ${states.length} entities`, 'info', 'scenes');
        
        res.json({ success: true, entitiesCaptured: states.length, states });
    } catch (error) {
        console.error('Error capturing scene:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/scenes/restore/:name', async (req, res) => {
    try {
        const scenario = db.getRoomScenario(req.params.name);
        if (!scenario) {
            return res.status(404).json({ error: 'Scene not found' });
        }
        
        const { simulationMode } = req.body;
        const results = [];
        
        // Restore each device state
        for (const state of scenario.device_states) {
            if (!simulationMode) {
                // Determine service based on entity domain
                const [domain, ] = state.entity_id.split('.');
                let service = 'turn_on';
                let serviceData = { entity_id: state.entity_id };
                
                if (state.state === 'off') {
                    service = 'turn_off';
                } else if (domain === 'light' && state.attributes) {
                    serviceData.brightness = state.attributes.brightness;
                    serviceData.color_temp = state.attributes.color_temp;
                }
                
                try {
                    const response = await fetch(`${HA_CONFIG.baseUrl}/api/services/${domain}/${service}`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${HA_CONFIG.accessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(serviceData)
                    });
                    
                    results.push({
                        entity: state.entity_id,
                        status: response.ok ? 'restored' : 'failed'
                    });
                } catch (err) {
                    results.push({ entity: state.entity_id, status: 'error', error: err.message });
                }
            } else {
                results.push({ entity: state.entity_id, status: 'simulated' });
            }
        }
        
        db.logEvent('scene_restored', `Scene "${req.params.name}" restored (${simulationMode ? 'simulated' : 'live'})`, 'info', 'scenes');
        
        res.json({ success: true, results });
    } catch (error) {
        console.error('Error restoring scene:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// NOTIFICATION MANAGEMENT
// ============================================

const activeNotifications = [];

app.post('/api/notifications/send', (req, res) => {
    try {
        const { title, message, priority, testEnvironment } = req.body;
        
        const notification = {
            id: Date.now(),
            title,
            message,
            priority: priority || 'normal',
            testEnvironment,
            timestamp: new Date().toISOString(),
            read: false
        };
        
        activeNotifications.push(notification);
        
        // Keep only last 50 notifications
        if (activeNotifications.length > 50) {
            activeNotifications.shift();
        }
        
        db.logEvent('notification_sent', `${title}: ${message}`, priority === 'critical' ? 'error' : 'info', testEnvironment);
        
        res.json({ success: true, notification });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/notifications', (req, res) => {
    res.json(activeNotifications);
});

app.post('/api/notifications/:id/mark-read', (req, res) => {
    const notification = activeNotifications.find(n => n.id === parseInt(req.params.id));
    if (notification) {
        notification.read = true;
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Notification not found' });
    }
});

app.delete('/api/notifications/:id', (req, res) => {
    const index = activeNotifications.findIndex(n => n.id === parseInt(req.params.id));
    if (index !== -1) {
        activeNotifications.splice(index, 1);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Notification not found' });
    }
});

// ============================================
// SAFETY GUARDRAILS
// ============================================

const SAFETY_LIMITS = {
    temperature: { min: 60, max: 80 },
    humidity: { min: 20, max: 80 },
    brightness: { min: 0, max: 100 },
    maxActionsPerMinute: 10,
    requiresConfirmation: ['lock', 'unlock', 'garage', 'alarm']
};

const recentActions = [];

function checkSafetyLimits(action) {
    const errors = [];
    
    // Check temperature limits
    if (action.type === 'set_temperature' && action.value) {
        if (action.value < SAFETY_LIMITS.temperature.min) {
            errors.push(`Temperature ${action.value}°F is below minimum ${SAFETY_LIMITS.temperature.min}°F`);
        }
        if (action.value > SAFETY_LIMITS.temperature.max) {
            errors.push(`Temperature ${action.value}°F exceeds maximum ${SAFETY_LIMITS.temperature.max}°F`);
        }
    }
    
    // Check rate limiting
    const oneMinuteAgo = Date.now() - 60000;
    const recentCount = recentActions.filter(a => a.timestamp > oneMinuteAgo).length;
    if (recentCount >= SAFETY_LIMITS.maxActionsPerMinute) {
        errors.push(`Rate limit exceeded: ${recentCount} actions in last minute (max ${SAFETY_LIMITS.maxActionsPerMinute})`);
    }
    
    // Check if confirmation required
    const requiresConfirmation = SAFETY_LIMITS.requiresConfirmation.some(keyword => 
        action.entity_id?.includes(keyword) || action.service?.includes(keyword)
    );
    
    return { safe: errors.length === 0, errors, requiresConfirmation };
}

app.post('/api/safety/check', (req, res) => {
    try {
        const action = req.body;
        const result = checkSafetyLimits(action);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/safety/limits', (req, res) => {
    res.json(SAFETY_LIMITS);
});

app.post('/api/safety/limits', (req, res) => {
    try {
        // Allow updating safety limits (with authentication in production!)
        Object.assign(SAFETY_LIMITS, req.body);
        db.logEvent('safety_limits_updated', 'Safety limits modified', 'warning', 'admin');
        res.json({ success: true, limits: SAFETY_LIMITS });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Track action for rate limiting
function trackAction(action) {
    recentActions.push({ ...action, timestamp: Date.now() });
    // Clean up old actions
    const oneMinuteAgo = Date.now() - 60000;
    while (recentActions.length > 0 && recentActions[0].timestamp < oneMinuteAgo) {
        recentActions.shift();
    }
}

// ============================================
// ENERGY MONITORING
// ============================================

app.post('/api/energy/log', (req, res) => {
    try {
        const { deviceEntityId, powerWatts, costEstimate, aiRecommendation } = req.body;
        db.logEnergyUsage(deviceEntityId, powerWatts, costEstimate, aiRecommendation);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/energy/stats', (req, res) => {
    try {
        const { deviceEntityId, hoursBack } = req.query;
        const stats = db.getEnergyStats(deviceEntityId, parseInt(hoursBack) || 24);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// DATABASE MAINTENANCE
// ============================================

app.get('/api/database/info', (req, res) => {
    try {
        const size = db.getDatabaseSize();
        res.json(size);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/database/cleanup', (req, res) => {
    try {
        const { daysToKeep } = req.body;
        const deleted = db.cleanupOldData(parseInt(daysToKeep) || 90);
        db.logEvent('database_cleanup', `Cleaned up old data: ${JSON.stringify(deleted)}`, 'info', 'maintenance');
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Model testing endpoint
app.post('/api/llm/test', async (req, res) => {
    try {
        const { model, prompt } = req.body;
        
        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt required' });
        }

        // Map model names to actual LM Studio model identifiers
        const modelMap = {
            'google/gemma-3-4b': 'google/gemma-3-4b',
            'microsoft/phi-3-mini': 'microsoft/phi-3-mini',
            'meta/llama-2-7b': 'meta/llama-2-7b',
            'mistralai/mistral-7b': 'mistralai/mistral-7b'
        };

        const actualModel = modelMap[model] || model;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: actualModel,
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.choices?.[0]?.message?.content || 'No response';
        
        // Try to count tokens if available
        const usage = data.usage || {};
        
        res.json({
            success: true,
            model: actualModel,
            response: responseText,
            tokens: usage.completion_tokens || 0,
            promptTokens: usage.prompt_tokens || 0
        });

    } catch (error) {
        console.error('Model test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

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

        const actionableEntities = entities
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

        return actionableEntities;
    } catch (error) {
        console.error('Failed to load Home Assistant context for workspace analysis:', error.message);
        return [];
    }
}

// Workspace Manager analysis endpoint
app.post('/api/workspace/analyze', async (req, res) => {
    const { posture, timeInState, sensorData, calendarEvents, image } = req.body;
    
    try {
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const hour = now.getHours();
        let timeOfDay = 'morning';
        if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
        else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
        else if (hour >= 21 || hour < 6) timeOfDay = 'late night';

        const actionableEntities = await getWorkspaceHomeAssistantContext();
        const haContextBlock = actionableEntities.length > 0
            ? actionableEntities
                .map(entity => `- ${entity.friendly_name} (${entity.entity_id}) | state: ${entity.state} | services: ${entity.possible_services.join(', ')}`)
                .join('\n')
            : '- No Home Assistant entities were available during this analysis.';

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
${calendarEvents.map(e => `- ${e.time}: ${e.event}`).join('\n')}
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

        // Prepare message with optional image
        let messageContent;
        if (image && image.startsWith('data:image')) {
            messageContent = [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: image } }
            ];
        } else {
            messageContent = prompt;
        }

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
        
        // Clean and parse JSON
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

// Save workspace manager log recordings to file
app.post('/api/workspace/log-recording', (req, res) => {
    try {
        const { startedAt, stoppedAt, logs } = req.body;

        if (!Array.isArray(logs)) {
            return res.status(400).json({ error: 'logs must be an array' });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFilename = `workspace-log-${timestamp}`;
        const jsonFilename = `${baseFilename}.json`;
        const textFilename = `${baseFilename}.log`;
        const jsonPath = path.join(WORKSPACE_LOG_CONFIG.outputDir, jsonFilename);
        const textPath = path.join(WORKSPACE_LOG_CONFIG.outputDir, textFilename);

        const payload = {
            source: 'workspace-manager',
            startedAt: startedAt || null,
            stoppedAt: stoppedAt || new Date().toISOString(),
            entries: logs,
            entryCount: logs.length,
            savedAt: new Date().toISOString()
        };

        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

        const textLines = [
            'Workspace Manager Log Recording',
            `Started: ${payload.startedAt || 'unknown'}`,
            `Stopped: ${payload.stoppedAt}`,
            `Entries: ${payload.entryCount}`,
            '',
            '---'
        ];

        for (const entry of logs) {
            const time = entry.timestamp || entry.isoTimestamp || 'unknown-time';
            const msg = entry.message || '';
            textLines.push(`[${time}] ${msg}`);
        }

        fs.writeFileSync(textPath, textLines.join('\n'), 'utf8');

        db.logEvent(
            'workspace_log_saved',
            `Saved workspace recording with ${logs.length} entries to ${jsonFilename} and ${textFilename}`,
            'info',
            'workspace_manager'
        );

        res.json({
            success: true,
            filename: jsonFilename,
            jsonFilename,
            textFilename,
            jsonPath: `data/workspace-logs/${jsonFilename}`,
            textPath: `data/workspace-logs/${textFilename}`,
            entryCount: logs.length
        });
    } catch (error) {
        console.error('Error saving workspace log recording:', error);
        res.status(500).json({ error: error.message });
    }
});

// List saved workspace recordings
app.get('/api/workspace/log-recordings', (req, res) => {
    try {
        const recordings = fs.readdirSync(WORKSPACE_LOG_CONFIG.outputDir)
            .filter(file => file.startsWith('workspace-log-') && file.endsWith('.json'))
            .map(jsonFilename => {
                const baseName = jsonFilename.slice(0, -5);
                const textFilename = `${baseName}.log`;
                const jsonPath = path.join(WORKSPACE_LOG_CONFIG.outputDir, jsonFilename);
                const textPath = path.join(WORKSPACE_LOG_CONFIG.outputDir, textFilename);
                const jsonStats = fs.statSync(jsonPath);
                const hasTextFile = fs.existsSync(textPath);

                let startedAt = null;
                let stoppedAt = null;
                let entryCount = 0;

                try {
                    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                    startedAt = parsed.startedAt || null;
                    stoppedAt = parsed.stoppedAt || null;
                    entryCount = parsed.entryCount || 0;
                } catch (parseError) {
                    // Skip metadata extraction for malformed files; still list file.
                }

                return {
                    baseName,
                    jsonFilename,
                    textFilename: hasTextFile ? textFilename : null,
                    jsonPath: `data/workspace-logs/${jsonFilename}`,
                    textPath: hasTextFile ? `data/workspace-logs/${textFilename}` : null,
                    startedAt,
                    stoppedAt,
                    entryCount,
                    createdAt: jsonStats.birthtime,
                    createdAtMs: jsonStats.birthtimeMs
                };
            })
            .sort((a, b) => b.createdAtMs - a.createdAtMs);

        res.json({ recordings });
    } catch (error) {
        console.error('Error listing workspace log recordings:', error);
        res.status(500).json({ error: error.message, recordings: [] });
    }
});

// Smart Pantry analysis endpoint
app.post('/api/pantry/analyze', async (req, res) => {
    const { weightData, detectedObjects, machineStatus, timeOfDay, userPattern, image } = req.body;
    
    try {
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const hour = now.getHours();

        // Build inventory status
        let inventoryStatus = '';
        if (weightData) {
            inventoryStatus = `
REPLICATOR INVENTORY:
- Coffee Beans: ${weightData.coffeeBeans?.current || 0}g (${weightData.coffeeBeans?.percentage || 0}%)
- Tea Supply: ${weightData.tea?.current || 0}g (${weightData.tea?.percentage || 0}%)
- Fruit Bowl: ${weightData.fruit?.current || 0}g (${weightData.fruit?.percentage || 0}%)
`;
        }

        // Build machine status
        let machineInfo = '';
        if (machineStatus) {
            machineInfo = `
REPLICATOR STATUS:
- Boiler Temperature: ${machineStatus.boilerTemp || 'Unknown'}°C
- Water Level: ${machineStatus.waterLevel || 'Unknown'}%
- Grinder Setting: ${machineStatus.grinderSetting || 'Unknown'}
`;
        }

        // Build detected objects
        let objectsDetected = 'None detected';
        if (detectedObjects && detectedObjects.length > 0) {
            objectsDetected = detectedObjects.map(o => `${o.label} (${(o.confidence * 100).toFixed(0)}% confidence)`).join(', ');
        }

        const prompt = `You are a Star Trek replicator AI assistant managing a smart kitchen station. Analyze the current situation and provide beverage/food recommendations.

CURRENT SITUATION:
- Time: ${timeString}
- User Context: ${userPattern || 'Unknown'}
- Detected Objects: ${objectsDetected}
${inventoryStatus}
${machineInfo}
${image ? '- Visual image of the counter/pantry is provided' : ''}

KNOWN USER PREFERENCES:
- After gym/exercise: Strong espresso
- Morning: Medium roast coffee
- Evening: Earl Grey tea
- Default grind: Medium-fine

FAMOUS REPLICATED ORDERS:
- "Earl Grey, Hot" (Picard's choice) - Black tea, 96°C
- "Coffee, Black" (Janeway's fuel) - Strong coffee, 93°C
- "Raktajino" (Sisko's morning) - Extra strong coffee, 95°C

REPLICATOR CAPABILITIES:
1. Preheat machine
2. Adjust grinder (fine for espresso, medium for drip, coarse for french-press)
3. Auto-add items to shopping list when below 15%
4. Send preparation notifications

${image ? 'Examine the image to identify any items on the counter, user activity, or context clues about what they might want. Look for gym bags, workout clothes, mugs, or other indicators of intent.' : ''}

Based on the detected objects${image ? ', visual scene,' : ''} time of day, user patterns, and inventory levels, determine what the user likely wants and suggest appropriate actions.

Respond in JSON format:
{
    "situation": "Brief description of what you detect the user is doing or planning (2 sentences)",
    "recommendation": "What beverage/food item to prepare",
    "reasoning": "Why this recommendation fits the context (2-3 sentences)",
    "actions": ["List of 2-4 specific actions to take (e.g., 'Preheat machine to 94°C', 'Adjust grinder to fine')"],
    "shoppingNeeded": ["List any items below 15% that need restocking"],
    "notification": "A Star Trek style notification message to send the user (e.g., 'I've prepared the station for your pre-workout brew; shall I start?')"
}`;

        // Prepare message with optional image
        let messageContent;
        if (image && image.startsWith('data:image')) {
            messageContent = [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: image } }
            ];
        } else {
            messageContent = prompt;
        }

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [{ role: 'user', content: messageContent }],
                temperature: 0.7,
                max_tokens: 700
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        let responseText = data.choices?.[0]?.message?.content || '{}';
        
        // Clean and parse JSON
        responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const analysis = JSON.parse(responseText);
        
        res.json(analysis);
    } catch (error) {
        console.error('Pantry analysis error:', error);
        res.status(500).json({ 
            situation: 'Unable to analyze pantry situation at this time',
            recommendation: 'No recommendation available',
            reasoning: 'System error occurred',
            actions: [],
            shoppingNeeded: [],
            notification: 'Replicator analysis temporarily unavailable'
        });
    }
});

// ============================================
// TEXT-TO-SPEECH ENDPOINT
// ============================================

app.post('/api/tts/speak', async (req, res) => {
    const { text } = req.body;
    
    if (!text || text.trim().length === 0) {
        return res.status(400).json({ error: 'Text is required' });
    }
    
    try {
        // Generate unique filename
        const timestamp = Date.now();
        const filePrefix = `tts_${timestamp}`;
        
        // Prepare the mlx-audio command using venv Python 3.12
        const escapedText = text.replace(/"/g, '\\"').replace(/'/g, "\\'");
        let command = `cd "${TTS_CONFIG.outputDir}" && "${TTS_CONFIG.pythonPath}" -m mlx_audio.tts.generate --model "${TTS_CONFIG.model}" --text "${escapedText}" --file_prefix "${filePrefix}"`;
        // Allow larger token budgets for longer analysis/suggestion outputs
        command += ` --max_tokens 4096`;
        
        // Always use the hardcoded voice reference if it exists.
        if (fs.existsSync(TTS_REFERENCE_AUDIO)) {
            const escapedRefText = TTS_REFERENCE_TEXT.replace(/"/g, '\\"').replace(/'/g, "\\'");
            command += ` --ref_audio "${TTS_REFERENCE_AUDIO}" --ref_text "${escapedRefText}"`;
            console.log('Using hardcoded voice cloning reference:', TTS_REFERENCE_AUDIO);
        } else {
            command += ` --voice "${TTS_CONFIG.voice}"`;
        }
        
        command += ' 2>&1';
        
        console.log('Generating TTS audio:', text.substring(0, 50) + '...');
        
        // Execute TTS generation
        await new Promise((resolve, reject) => {
            exec(command, { timeout: 90000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('TTS generation error:', error);
                    console.error('stderr:', stderr);
                    reject(new Error(`TTS failed: ${error.message}`));
                    return;
                }
                console.log('TTS generated successfully');
                resolve();
            });
        });
        
        // Find the generated file (Qwen3-TTS creates _000.wav suffix)
        const possibleFiles = [
            path.join(TTS_CONFIG.outputDir, `${filePrefix}_000.wav`),
            path.join(TTS_CONFIG.outputDir, `${filePrefix}.wav`),
            path.join(TTS_CONFIG.outputDir, `${filePrefix}_0.wav`)
        ];
        
        let outputPath = null;
        for (const file of possibleFiles) {
            if (fs.existsSync(file)) {
                outputPath = file;
                break;
            }
        }
        
        if (!outputPath) {
            // List files in audio dir for debugging
            const files = fs.readdirSync(TTS_CONFIG.outputDir);
            throw new Error(`Audio file not found. Files in audio dir: ${files.join(', ')}`);
        }
        
        // Clean up old audio files
        cleanupOldAudioFiles();
        
        // Return the audio file path (relative to static serving)
        const filename = path.basename(outputPath);
        const relativePath = `/audio/${filename}`;
        res.json({ 
            success: true, 
            audioPath: relativePath,
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

// Helper function to clean up old audio files
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
        
        // Remove files beyond the max limit
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

// Check TTS availability endpoint
app.get('/api/tts/status', (req, res) => {
    const checkCommand = `"${TTS_CONFIG.pythonPath}" -m mlx_audio.tts.generate --help`;
    exec(checkCommand, { timeout: 5000 }, (error) => {
        if (error) {
            res.json({ 
                available: false, 
                message: 'mlx-audio not installed in venv'
            });
        } else {
            res.json({ 
                available: true, 
                message: 'TTS is ready (Qwen3-TTS)',
                model: TTS_CONFIG.model,
                voice: TTS_CONFIG.voice
            });
        }
    });
});

// Upload reference audio for voice cloning
app.post('/api/tts/upload-reference', upload.single('audio'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file uploaded' });
        }

        res.json({
            success: true,
            message: 'Voice reference uploaded successfully',
            filename: req.file.filename,
            path: req.file.path,
            size: req.file.size
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// List available reference audio files
app.get('/api/tts/references', (req, res) => {
    try {
        const files = fs.readdirSync(TTS_CONFIG.referenceDir)
            .filter(file => file.match(/\.(wav|mp3|m4a|flac|ogg)$/i))
            .map(file => {
                const filePath = path.join(TTS_CONFIG.referenceDir, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    path: filePath,
                    size: stats.size,
                    created: stats.birthtime
                };
            })
            .sort((a, b) => b.created - a.created);

        res.json({ references: files });
    } catch (error) {
        console.error('Error listing references:', error);
        res.status(500).json({ error: error.message, references: [] });
    }
});

// Delete a reference audio file
app.delete('/api/tts/references/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(TTS_CONFIG.referenceDir, filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        fs.unlinkSync(filePath);
        res.json({ success: true, message: 'Reference audio deleted' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Medical Tricorder Analysis API
app.post('/api/tricorder/analyze', async (req, res) => {
    try {
        const { stats, timestamp } = req.body;

        if (!stats) {
            return res.status(400).json({ error: 'Missing patient stats' });
        }

        // Build the medical analysis prompt
        const prompt = `You are a medical diagnostic AI assistant. Analyze the following patient vitals and provide clinical findings and recommended actions.

Patient Vitals:
- Heart Rate: ${stats.heartRate} bpm
- Temperature: ${stats.temperature}°C
- O2 Saturation: ${stats.o2Sat}%
- Blood Pressure: ${stats.bloodPressure} mmHg
- Timestamp: ${timestamp}

Provide a response in JSON format with the following structure:
{
  "findings": [
    {
      "title": "Finding title",
      "description": "Brief clinical finding description"
    }
  ],
  "recommendations": [
    {
      "action": "ACTION NAME",
      "description": "Specific recommended action"
    }
  ]
}

Base your analysis on clinical thresholds:
- Normal HR: 60-100 bpm
- Normal Temp: 36.5-37.5°C
- Normal O2: >95%
- Normal BP: <120/80 mmHg

Return ONLY valid JSON, no additional text.`;

        const response = await fetch(`${LLM_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a medical tricorder diagnostic system. Respond only with valid JSON.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.3,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '{}';

        // Parse and validate the JSON response
        let analysis = {};
        try {
            analysis = JSON.parse(content);
        } catch (parseError) {
            // If JSON parsing fails, provide default analysis
            console.warn('Failed to parse LLM response as JSON, using defaults');
            analysis = {
                findings: [
                    {
                        title: 'Analysis Complete',
                        description: 'Patient vitals have been recorded and assessed.'
                    }
                ],
                recommendations: [
                    {
                        action: 'CONTINUE MONITORING',
                        description: 'Continue standard patient observation protocols.'
                    }
                ]
            };
        }

        // Ensure findings and recommendations arrays exist
        if (!analysis.findings) analysis.findings = [];
        if (!analysis.recommendations) analysis.recommendations = [];

        res.json(analysis);
    } catch (error) {
        console.error('Tricorder analysis error:', error);
        res.status(500).json({
            error: error.message,
            findings: [
                {
                    title: 'System Error',
                    description: 'Unable to complete analysis at this time.'
                }
            ],
            recommendations: [
                {
                    action: 'CHECK SYSTEM',
                    description: 'Verify tricorder system connectivity and LLM service status.'
                }
            ]
        });
    }
});

// Start server (HTTP or HTTPS if certs present / USE_HTTPS=1)
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
            console.log(`HTTPS Server running at https://localhost:${PORT}`);
            console.log(`Open https://localhost:${PORT} in your browser (accept the self-signed certificate)`);
            console.log(`\nTest Environments:`);
            console.log(`- Hub: https://localhost:${PORT}/hub.html`);
            console.log(`- Greenhouse: https://localhost:${PORT}/greenhouse.html`);
            console.log(`- Living Room: https://localhost:${PORT}/livingroom.html`);
            console.log(`- Butler Test: https://localhost:${PORT}/butler.html`);

            db.logEvent('server_started', 'HTTPS Server initialized successfully', 'info', 'system');
            const dbSize = db.getDatabaseSize();
            console.log(`\nDatabase: ${dbSize.decisions_count} decisions, ${dbSize.preferences_count} preferences learned`);
        });
    } catch (err) {
        console.error('Failed to start HTTPS server, falling back to HTTP:', err);
        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
            console.log(`Open http://localhost:${PORT} in your browser`);
        });
    }
} else {
    // HTTP fallback
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`Open http://localhost:${PORT} in your browser`);
        console.log(`\nTest Environments:`);
        console.log(`- Hub: http://localhost:${PORT}/hub.html`);
        console.log(`- Greenhouse: http://localhost:${PORT}/greenhouse.html`);
        console.log(`- Living Room: http://localhost:${PORT}/livingroom.html`);
        console.log(`- Butler Test: http://localhost:${PORT}/butler.html`);
        
        // Log server start
        db.logEvent('server_started', 'Server initialized successfully', 'info', 'system');
        
        // Display database stats
        const dbSize = db.getDatabaseSize();
        console.log(`\nDatabase: ${dbSize.decisions_count} decisions, ${dbSize.preferences_count} preferences learned`);
    });
}
