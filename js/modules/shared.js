export const apiBase = `${window.location.protocol}//${window.location.hostname}:3000`;

export function escapeHtml(str) {
    return String(str).replace(/[&<>"'`]/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        "`": "&#96;",
    }[character]));
}

function buildIconSvg(pathMarkup) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathMarkup}</svg>`;
}

export function actionIcon(action = {}) {
    const domain = String(action.domain || action.entity_id?.split(".")[0] || action.entityId?.split(".")[0] || "").toLowerCase();
    const service = String(action.service || "").toLowerCase();

    if (domain === "light") {
        const iconClass = service === "turn_off" ? "lamp-off" : "lamp-on";
        const svg = service === "turn_off"
            ? buildIconSvg('<path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M8.5 14.5a6 6 0 1 1 7 0c-.9.7-1.5 1.8-1.5 3.1V18h-4v-.4c0-1.3-.6-2.4-1.5-3.1Z"></path>')
            : buildIconSvg('<path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2v2"></path><path d="M4.9 4.9l1.4 1.4"></path><path d="M2 12h2"></path><path d="M18 12h2"></path><path d="M16.7 6.3l1.4-1.4"></path><path d="M8.5 14.5a6 6 0 1 1 7 0c-.9.7-1.5 1.8-1.5 3.1V18h-4v-.4c0-1.3-.6-2.4-1.5-3.1Z"></path>');
        return `<span class="action-icon ${iconClass}">${svg}</span>`;
    }

    if (domain === "climate") {
        return `<span class="action-icon climate">${buildIconSvg('<path d="M12 3a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4Z"></path><path d="M8 13h8"></path><path d="M10 17h4"></path>')}</span>`;
    }

    if (domain === "switch") {
        return `<span class="action-icon switch">${buildIconSvg('<path d="M7 12h10"></path><path d="M12 7v10"></path><circle cx="12" cy="12" r="7"></circle>')}</span>`;
    }

    if (domain === "cover") {
        return `<span class="action-icon cover">${buildIconSvg('<path d="M7 4h10"></path><path d="M8 4v16"></path><path d="M16 4v16"></path><path d="M8 20h8"></path>')}</span>`;
    }

    if (domain === "media_player") {
        return `<span class="action-icon media">${buildIconSvg('<path d="M8 5v14l11-7-11-7Z"></path>')}</span>`;
    }

    return `<span class="action-icon generic">${buildIconSvg('<circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path>')}</span>`;
}