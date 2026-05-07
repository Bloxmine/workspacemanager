export function createAnalysisController({
    apiBase,
    cameraFeed,
    cameraStatus,
    analyzeBtn,
    applyActionsBtn,
    analysisText,
    suggestionsList,
    actionsTable,
    captureFrameAsDataUrl,
    speakAnalysis,
    escapeHtml,
    actionIcon,
}) {
    let isAnalyzing = false;
    let isApplyingActions = false;
    let pendingHomeAssistantActions = [];

    function renderAnalysisToBottomCopy(analysis) {
        const assessment = analysis.assessment || "No assessment returned.";
        const suggestions = Array.isArray(analysis.suggestions) ? analysis.suggestions : [];
        const actions = Array.isArray(analysis.homeAssistantActions) ? analysis.homeAssistantActions : [];

        analysisText.textContent = `${assessment}${analysis.reasoning ? ` ${analysis.reasoning}` : ""}`;

        suggestionsList.innerHTML = suggestions.length
            ? suggestions.map(suggestion => `<li>${escapeHtml(suggestion)}</li>`).join("")
            : "<li>No suggestions provided.</li>";

        actionsTable.innerHTML = actions.length
            ? actions.map(action => `
                <div class="action-tile" title="${escapeHtml(action.reason || action.service || "Action")}">
                ${actionIcon(action)}
                </div>
            `).join("")
            : '<div class="action-tile" title="No Home Assistant actions"><span class="action-icon generic">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path></svg>' +
            '</span></div>';

        pendingHomeAssistantActions = actions;
        applyActionsBtn.disabled = actions.length === 0;
    }

    async function applySuggestedActions() {
        if (isApplyingActions || pendingHomeAssistantActions.length === 0) {
            return;
        }

        isApplyingActions = true;
        applyActionsBtn.disabled = true;
        cameraStatus.textContent = "Applying actions...";

        try {
            const calls = pendingHomeAssistantActions.map(action => {
                const entityId = action.entity_id || action.entityId;
                const domain = action.domain || (entityId ? entityId.split(".")[0] : "");

                return fetch(`${apiBase}/api/service`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        domain,
                        service: action.service,
                        entityId,
                        data: action.data || {},
                    }),
                });
            });

            const results = await Promise.allSettled(calls);
            const succeeded = results.filter(result => result.status === "fulfilled" && result.value.ok).length;
            const failed = results.length - succeeded;

            cameraStatus.textContent = failed === 0 ? "Actions applied." : "Some actions failed.";
            analysisText.textContent += ` Applied actions: ${succeeded} succeeded, ${failed} failed.`;
        } finally {
            isApplyingActions = false;
            applyActionsBtn.disabled = pendingHomeAssistantActions.length === 0;
        }
    }

    async function analyzeWorkspace() {
        if (isAnalyzing) {
            return;
        }

        if (!cameraFeed.srcObject) {
            cameraStatus.textContent = "Camera offline.";
            return;
        }

        isAnalyzing = true;
        analyzeBtn.disabled = true;
        cameraStatus.textContent = "analysing";

        try {
            const image = captureFrameAsDataUrl();
            const response = await fetch(`${apiBase}/api/workspace/analyze`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    posture: "unknown",
                    timeInState: 0,
                    sensorData: null,
                    calendarEvents: [],
                    image,
                }),
            });

            const analysis = await response.json();
            renderAnalysisToBottomCopy(analysis);
            void speakAnalysis(analysis);
            cameraStatus.textContent = "Camera online.";
        } finally {
            isAnalyzing = false;
            analyzeBtn.disabled = false;
        }
    }

    return {
        renderAnalysisToBottomCopy,
        applySuggestedActions,
        analyzeWorkspace,
    };
}