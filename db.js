const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Initialize database
const dbPath = path.join(__dirname, 'data', 'smart_home.db');
const dbDir = path.dirname(dbPath);

// Create data directory if it doesn't exist
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
    -- AI Decisions Log
    CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        test_environment TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        input_data TEXT,
        llm_response TEXT,
        actions_taken TEXT,
        reasoning TEXT,
        execution_status TEXT DEFAULT 'pending',
        feedback_rating INTEGER,
        feedback_comment TEXT,
        response_time_ms INTEGER,
        tokens_used INTEGER,
        model_name TEXT,
        simulation_mode BOOLEAN DEFAULT 0
    );

    -- User Preferences
    CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        preference_key TEXT UNIQUE NOT NULL,
        preference_value TEXT NOT NULL,
        learned_from TEXT,
        confidence REAL DEFAULT 0.5,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Greenhouse Plant Profiles
    CREATE TABLE IF NOT EXISTS plant_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_name TEXT UNIQUE NOT NULL,
        plant_species TEXT,
        optimal_soil_moisture REAL,
        optimal_light_level REAL,
        optimal_temperature REAL,
        optimal_humidity REAL,
        watering_frequency_hours INTEGER,
        care_instructions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Living Room Scenarios
    CREATE TABLE IF NOT EXISTS room_scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_name TEXT UNIQUE NOT NULL,
        visual_tags TEXT,
        audio_tags TEXT,
        expected_actions TEXT,
        device_states TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Butler Context History
    CREATE TABLE IF NOT EXISTS butler_contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_context TEXT NOT NULL,
        interruptibility_score INTEGER NOT NULL,
        messages_evaluated INTEGER,
        messages_delivered INTEGER,
        messages_withheld INTEGER,
        avg_response_time_ms REAL
    );

    -- System Events Log
    CREATE TABLE IF NOT EXISTS system_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        event_type TEXT NOT NULL,
        severity TEXT DEFAULT 'info',
        description TEXT,
        source TEXT,
        metadata TEXT
    );

    -- Chaos Tests
    CREATE TABLE IF NOT EXISTS chaos_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        test_type TEXT NOT NULL,
        injected_failure TEXT,
        ai_response TEXT,
        recovery_time_ms INTEGER,
        success BOOLEAN,
        notes TEXT
    );

    -- Energy Usage (if sensors available)
    CREATE TABLE IF NOT EXISTS energy_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        device_entity_id TEXT NOT NULL,
        power_watts REAL,
        cost_estimate REAL,
        ai_recommendation TEXT
    );

    -- Routines
    CREATE TABLE IF NOT EXISTS routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        routine_name TEXT UNIQUE NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_value TEXT,
        actions TEXT NOT NULL,
        enabled BOOLEAN DEFAULT 1,
        last_executed DATETIME,
        execution_count INTEGER DEFAULT 0,
        created_by TEXT DEFAULT 'user'
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_decisions_test_env ON decisions(test_environment);
    CREATE INDEX IF NOT EXISTS idx_decisions_feedback ON decisions(feedback_rating);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON system_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON system_events(severity);
`);

// ============================================
// Decision Logging Functions
// ============================================

function logDecision(data) {
    const stmt = db.prepare(`
        INSERT INTO decisions 
        (test_environment, decision_type, input_data, llm_response, actions_taken, 
         reasoning, response_time_ms, tokens_used, model_name, simulation_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
        data.test_environment,
        data.decision_type,
        JSON.stringify(data.input_data),
        data.llm_response,
        JSON.stringify(data.actions_taken),
        data.reasoning,
        data.response_time_ms || null,
        data.tokens_used || null,
        data.model_name || null,
        data.simulation_mode ? 1 : 0
    );
    
    return result.lastInsertRowid;
}

function updateDecisionFeedback(decisionId, rating, comment) {
    const stmt = db.prepare(`
        UPDATE decisions 
        SET feedback_rating = ?, feedback_comment = ?
        WHERE id = ?
    `);
    return stmt.run(rating, comment, decisionId);
}

function updateDecisionStatus(decisionId, status) {
    const stmt = db.prepare('UPDATE decisions SET execution_status = ? WHERE id = ?');
    return stmt.run(status, decisionId);
}

function getRecentDecisions(testEnvironment = null, limit = 50) {
    let query = 'SELECT * FROM decisions';
    if (testEnvironment) {
        query += ' WHERE test_environment = ?';
    }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    
    const stmt = db.prepare(query);
    return testEnvironment ? stmt.all(testEnvironment, limit) : stmt.all(limit);
}

function getDecisionStats(testEnvironment = null) {
    let whereClause = testEnvironment ? 'WHERE test_environment = ?' : '';
    
    const query = `
        SELECT 
            COUNT(*) as total_decisions,
            AVG(feedback_rating) as avg_rating,
            AVG(response_time_ms) as avg_response_time,
            SUM(CASE WHEN feedback_rating >= 4 THEN 1 ELSE 0 END) as positive_feedback,
            SUM(CASE WHEN feedback_rating <= 2 THEN 1 ELSE 0 END) as negative_feedback,
            COUNT(DISTINCT DATE(timestamp)) as days_active
        FROM decisions
        ${whereClause}
    `;
    
    const stmt = db.prepare(query);
    return testEnvironment ? stmt.get(testEnvironment) : stmt.get();
}

// ============================================
// User Preferences
// ============================================

function setPreference(key, value, learnedFrom = 'user') {
    const stmt = db.prepare(`
        INSERT INTO preferences (preference_key, preference_value, learned_from, last_updated)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(preference_key) 
        DO UPDATE SET 
            preference_value = excluded.preference_value,
            learned_from = excluded.learned_from,
            last_updated = CURRENT_TIMESTAMP
    `);
    return stmt.run(key, value, learnedFrom);
}

function getPreference(key) {
    const stmt = db.prepare('SELECT * FROM preferences WHERE preference_key = ?');
    return stmt.get(key);
}

function getAllPreferences() {
    const stmt = db.prepare('SELECT * FROM preferences ORDER BY last_updated DESC');
    return stmt.all();
}

function updatePreferenceConfidence(key, confidence) {
    const stmt = db.prepare('UPDATE preferences SET confidence = ? WHERE preference_key = ?');
    return stmt.run(confidence, key);
}

// ============================================
// Plant Profiles
// ============================================

function savePlantProfile(profile) {
    const stmt = db.prepare(`
        INSERT INTO plant_profiles 
        (profile_name, plant_species, optimal_soil_moisture, optimal_light_level, 
         optimal_temperature, optimal_humidity, watering_frequency_hours, care_instructions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_name)
        DO UPDATE SET
            plant_species = excluded.plant_species,
            optimal_soil_moisture = excluded.optimal_soil_moisture,
            optimal_light_level = excluded.optimal_light_level,
            optimal_temperature = excluded.optimal_temperature,
            optimal_humidity = excluded.optimal_humidity,
            watering_frequency_hours = excluded.watering_frequency_hours,
            care_instructions = excluded.care_instructions
    `);
    
    return stmt.run(
        profile.profile_name,
        profile.plant_species,
        profile.optimal_soil_moisture,
        profile.optimal_light_level,
        profile.optimal_temperature,
        profile.optimal_humidity,
        profile.watering_frequency_hours,
        profile.care_instructions
    );
}

function getPlantProfile(profileName) {
    const stmt = db.prepare('SELECT * FROM plant_profiles WHERE profile_name = ?');
    return stmt.get(profileName);
}

function getAllPlantProfiles() {
    const stmt = db.prepare('SELECT * FROM plant_profiles ORDER BY created_at DESC');
    return stmt.all();
}

function deletePlantProfile(profileName) {
    const stmt = db.prepare('DELETE FROM plant_profiles WHERE profile_name = ?');
    return stmt.run(profileName);
}

// ============================================
// Room Scenarios
// ============================================

function saveRoomScenario(scenario) {
    const stmt = db.prepare(`
        INSERT INTO room_scenarios 
        (scenario_name, visual_tags, audio_tags, expected_actions, device_states)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scenario_name)
        DO UPDATE SET
            visual_tags = excluded.visual_tags,
            audio_tags = excluded.audio_tags,
            expected_actions = excluded.expected_actions,
            device_states = excluded.device_states
    `);
    
    return stmt.run(
        scenario.scenario_name,
        JSON.stringify(scenario.visual_tags),
        JSON.stringify(scenario.audio_tags),
        JSON.stringify(scenario.expected_actions),
        JSON.stringify(scenario.device_states)
    );
}

function getRoomScenario(scenarioName) {
    const stmt = db.prepare('SELECT * FROM room_scenarios WHERE scenario_name = ?');
    const result = stmt.get(scenarioName);
    if (result) {
        result.visual_tags = JSON.parse(result.visual_tags);
        result.audio_tags = JSON.parse(result.audio_tags);
        result.expected_actions = JSON.parse(result.expected_actions);
        result.device_states = JSON.parse(result.device_states);
    }
    return result;
}

function getAllRoomScenarios() {
    const stmt = db.prepare('SELECT * FROM room_scenarios ORDER BY created_at DESC');
    return stmt.all();
}

function deleteRoomScenario(scenarioName) {
    const stmt = db.prepare('DELETE FROM room_scenarios WHERE scenario_name = ?');
    return stmt.run(scenarioName);
}

// ============================================
// Butler Context Tracking
// ============================================

function logButlerContext(data) {
    const stmt = db.prepare(`
        INSERT INTO butler_contexts 
        (user_context, interruptibility_score, messages_evaluated, 
         messages_delivered, messages_withheld, avg_response_time_ms)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    return stmt.run(
        data.user_context,
        data.interruptibility_score,
        data.messages_evaluated,
        data.messages_delivered,
        data.messages_withheld,
        data.avg_response_time_ms
    );
}

function getButlerStats() {
    const stmt = db.prepare(`
        SELECT 
            COUNT(*) as total_evaluations,
            AVG(interruptibility_score) as avg_score,
            SUM(messages_delivered) as total_delivered,
            SUM(messages_withheld) as total_withheld,
            AVG(avg_response_time_ms) as avg_response_time
        FROM butler_contexts
    `);
    return stmt.get();
}

// ============================================
// System Events
// ============================================

function logEvent(eventType, description, severity = 'info', source = null, metadata = null) {
    const stmt = db.prepare(`
        INSERT INTO system_events (event_type, description, severity, source, metadata)
        VALUES (?, ?, ?, ?, ?)
    `);
    
    return stmt.run(
        eventType,
        description,
        severity,
        source,
        metadata ? JSON.stringify(metadata) : null
    );
}

function getRecentEvents(limit = 100) {
    const stmt = db.prepare(`
        SELECT * FROM system_events 
        ORDER BY timestamp DESC 
        LIMIT ?
    `);
    return stmt.all(limit);
}

function getEventsByType(eventType) {
    const stmt = db.prepare('SELECT * FROM system_events WHERE event_type = ? ORDER BY timestamp DESC');
    return stmt.all(eventType);
}

// ============================================
// Chaos Tests
// ============================================

function logChaosTest(data) {
    const stmt = db.prepare(`
        INSERT INTO chaos_tests 
        (test_type, injected_failure, ai_response, recovery_time_ms, success, notes)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    return stmt.run(
        data.test_type,
        data.injected_failure,
        data.ai_response,
        data.recovery_time_ms,
        data.success ? 1 : 0,
        data.notes
    );
}

function getChaosTests(limit = 50) {
    const stmt = db.prepare('SELECT * FROM chaos_tests ORDER BY timestamp DESC LIMIT ?');
    return stmt.all(limit);
}

function getChaosSuccessRate() {
    const stmt = db.prepare(`
        SELECT 
            COUNT(*) as total_tests,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_tests,
            AVG(recovery_time_ms) as avg_recovery_time
        FROM chaos_tests
    `);
    return stmt.get();
}

// ============================================
// Energy Monitoring
// ============================================

function logEnergyUsage(deviceEntityId, powerWatts, costEstimate, aiRecommendation = null) {
    const stmt = db.prepare(`
        INSERT INTO energy_logs (device_entity_id, power_watts, cost_estimate, ai_recommendation)
        VALUES (?, ?, ?, ?)
    `);
    return stmt.run(deviceEntityId, powerWatts, costEstimate, aiRecommendation);
}

function getEnergyStats(deviceEntityId = null, hoursBack = 24) {
    let whereClause = `WHERE timestamp > datetime('now', '-${hoursBack} hours')`;
    if (deviceEntityId) {
        whereClause += ` AND device_entity_id = '${deviceEntityId}'`;
    }
    
    const stmt = db.prepare(`
        SELECT 
            device_entity_id,
            AVG(power_watts) as avg_power,
            MAX(power_watts) as peak_power,
            COUNT(*) as readings,
            SUM(cost_estimate) as total_cost
        FROM energy_logs
        ${whereClause}
        GROUP BY device_entity_id
    `);
    
    return stmt.all();
}

// ============================================
// Routines
// ============================================

function saveRoutine(routine) {
    const stmt = db.prepare(`
        INSERT INTO routines (routine_name, trigger_type, trigger_value, actions, enabled, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(routine_name)
        DO UPDATE SET
            trigger_type = excluded.trigger_type,
            trigger_value = excluded.trigger_value,
            actions = excluded.actions,
            enabled = excluded.enabled
    `);
    
    return stmt.run(
        routine.routine_name,
        routine.trigger_type,
        routine.trigger_value,
        JSON.stringify(routine.actions),
        routine.enabled ? 1 : 0,
        routine.created_by || 'user'
    );
}

function getRoutine(routineName) {
    const stmt = db.prepare('SELECT * FROM routines WHERE routine_name = ?');
    const result = stmt.get(routineName);
    if (result) {
        result.actions = JSON.parse(result.actions);
        result.enabled = Boolean(result.enabled);
    }
    return result;
}

function getAllRoutines() {
    const stmt = db.prepare('SELECT * FROM routines ORDER BY routine_name');
    const results = stmt.all();
    return results.map(r => ({
        ...r,
        actions: JSON.parse(r.actions),
        enabled: Boolean(r.enabled)
    }));
}

function updateRoutineExecution(routineName) {
    const stmt = db.prepare(`
        UPDATE routines 
        SET last_executed = CURRENT_TIMESTAMP, 
            execution_count = execution_count + 1
        WHERE routine_name = ?
    `);
    return stmt.run(routineName);
}

function toggleRoutine(routineName, enabled) {
    const stmt = db.prepare('UPDATE routines SET enabled = ? WHERE routine_name = ?');
    return stmt.run(enabled ? 1 : 0, routineName);
}

function deleteRoutine(routineName) {
    const stmt = db.prepare('DELETE FROM routines WHERE routine_name = ?');
    return stmt.run(routineName);
}

// ============================================
// Analytics Functions
// ============================================

function getDashboardStats() {
    // Overall stats from last 7 days
    const overallStmt = db.prepare(`
        SELECT 
            COUNT(*) as totalDecisions,
            AVG(feedback_rating) as avgRating,
            AVG(response_time_ms) as avgResponseTime,
            SUM(CASE WHEN feedback_rating >= 4 THEN 1 ELSE 0 END) as positiveDecisions,
            SUM(CASE WHEN feedback_rating <= 2 THEN 1 ELSE 0 END) as negativeDecisions
        FROM decisions
        WHERE timestamp > datetime('now', '-7 days')
    `);
    
    const byEnvironmentStmt = db.prepare(`
        SELECT 
            test_environment as environment,
            COUNT(*) as count
        FROM decisions
        WHERE timestamp > datetime('now', '-7 days')
        GROUP BY test_environment
    `);
    
    const overall = overallStmt.get();
    const byEnvironment = byEnvironmentStmt.all();
    
    return {
        ...overall,
        byEnvironment
    };
}

function getDecisionTimeline(testEnvironment = null, days = 7) {
    let whereClause = `WHERE timestamp > datetime('now', '-${days} days')`;
    if (testEnvironment) {
        whereClause += ` AND test_environment = '${testEnvironment}'`;
    }
    
    const stmt = db.prepare(`
        SELECT 
            DATE(timestamp) as date,
            COUNT(*) as decision_count,
            AVG(feedback_rating) as avg_rating,
            AVG(response_time_ms) as avg_response_time
        FROM decisions
        ${whereClause}
        GROUP BY DATE(timestamp)
        ORDER BY date ASC
    `);
    
    return stmt.all();
}

function getFeedbackDistribution(testEnvironment = null) {
    let whereClause = testEnvironment ? `WHERE test_environment = '${testEnvironment}'` : '';
    
    const stmt = db.prepare(`
        SELECT 
            feedback_rating as rating,
            COUNT(*) as count
        FROM decisions
        ${whereClause}
        AND feedback_rating IS NOT NULL
        GROUP BY feedback_rating
        ORDER BY feedback_rating
    `);
    
    return stmt.all();
}

// ============================================
// Learning Functions
// ============================================

function learnFromFeedback() {
    // Analyze positive feedback to learn preferences
    const stmt = db.prepare(`
        SELECT 
            test_environment,
            decision_type,
            input_data,
            actions_taken,
            COUNT(*) as times_rated_high
        FROM decisions
        WHERE feedback_rating >= 4
        GROUP BY test_environment, decision_type, actions_taken
        HAVING COUNT(*) >= 3
    `);
    
    const patterns = stmt.all();
    
    // Extract learned preferences
    patterns.forEach(pattern => {
        try {
            const inputData = JSON.parse(pattern.input_data);
            const actions = JSON.parse(pattern.actions_taken);
            
            // Example: Learn preferred temperature
            if (pattern.test_environment === 'livingroom' && inputData.temperature) {
                setPreference(
                    'preferred_temperature',
                    inputData.temperature.toString(),
                    `learned from ${pattern.times_rated_high} positive decisions`
                );
                updatePreferenceConfidence('preferred_temperature', pattern.times_rated_high / 10);
            }
        } catch (e) {
            // Skip malformed data
        }
    });
    
    return patterns.length;
}

// ============================================
// Cleanup & Maintenance
// ============================================

function cleanupOldData(daysToKeep = 90) {
    const stmt1 = db.prepare(`DELETE FROM decisions WHERE timestamp < datetime('now', '-${daysToKeep} days')`);
    const stmt2 = db.prepare(`DELETE FROM system_events WHERE timestamp < datetime('now', '-${daysToKeep} days')`);
    const stmt3 = db.prepare(`DELETE FROM energy_logs WHERE timestamp < datetime('now', '-${daysToKeep} days')`);
    
    const deleted1 = stmt1.run();
    const deleted2 = stmt2.run();
    const deleted3 = stmt3.run();
    
    return {
        decisions: deleted1.changes,
        events: deleted2.changes,
        energy_logs: deleted3.changes
    };
}

function getDatabaseSize() {
    const stmt = db.prepare(`
        SELECT 
            (SELECT COUNT(*) FROM decisions) as decisions_count,
            (SELECT COUNT(*) FROM system_events) as events_count,
            (SELECT COUNT(*) FROM preferences) as preferences_count,
            (SELECT COUNT(*) FROM plant_profiles) as profiles_count,
            (SELECT COUNT(*) FROM room_scenarios) as scenarios_count,
            (SELECT COUNT(*) FROM routines) as routines_count
    `);
    return stmt.get();
}

// ============================================
// Exports
// ============================================

module.exports = {
    db,
    // Decisions
    logDecision,
    updateDecisionFeedback,
    updateDecisionStatus,
    getRecentDecisions,
    getDecisionStats,
    // Preferences
    setPreference,
    getPreference,
    getAllPreferences,
    updatePreferenceConfidence,
    // Plant Profiles
    savePlantProfile,
    getPlantProfile,
    getAllPlantProfiles,
    deletePlantProfile,
    // Room Scenarios
    saveRoomScenario,
    getRoomScenario,
    getAllRoomScenarios,
    deleteRoomScenario,
    // Butler
    logButlerContext,
    getButlerStats,
    // Events
    logEvent,
    getRecentEvents,
    getEventsByType,
    // Chaos
    logChaosTest,
    getChaosTests,
    getChaosSuccessRate,
    // Energy
    logEnergyUsage,
    getEnergyStats,
    // Routines
    saveRoutine,
    getRoutine,
    getAllRoutines,
    updateRoutineExecution,
    toggleRoutine,
    deleteRoutine,
    // Analytics
    getDashboardStats,
    getDecisionTimeline,
    getFeedbackDistribution,
    learnFromFeedback,
    // Maintenance
    cleanupOldData,
    getDatabaseSize
};
