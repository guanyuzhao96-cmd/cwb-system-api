const REPORT_VERSION = '0.12.23';
let latestReportJson = null;
let latestReportName = null;

function errorDetails(error) {
    const cause = error?.cause;
    return {
        name: String(error?.name || 'Error'),
        message: String(error?.message || error || '未知错误').slice(0, 2000),
        historyGuard: error?.cwbHistoryGuard ?? undefined,
        causeName: cause?.name ? String(cause.name).slice(0, 120) : undefined,
        causeMessage: cause?.message ? String(cause.message).slice(0, 2000) : undefined,
        stack: error?.stack ? String(error.stack).slice(0, 5000) : undefined,
    };
}

export function createErrorReport(error, details = {}) {
    const report = {
        reportType: 'CWB 插件错误诊断报告',
        reportVersion: 1,
        generatedAt: new Date().toISOString(),
        pluginVersion: REPORT_VERSION,
        environment: {
            userAgent: globalThis.navigator?.userAgent || 'unknown',
            language: globalThis.navigator?.language || 'unknown',
            online: globalThis.navigator?.onLine ?? null,
        },
        operation: {
            stage: details.stage || 'unknown',
            modules: Array.isArray(details.modules) ? details.modules : [],
            startFloor: Number.isFinite(details.startFloor) ? details.startFloor : null,
            endFloor: Number.isFinite(details.endFloor) ? details.endFloor : null,
            batchFloors: Number.isFinite(details.batchFloors) ? details.batchFloors : null,
            totalChatFloors: Number.isFinite(details.totalChatFloors) ? details.totalChatFloors : null,
            requestCharacters: Number.isFinite(details.requestCharacters) ? details.requestCharacters : null,
            requestDurationMs: Number.isFinite(details.requestDurationMs) ? details.requestDurationMs : null,
        },
        error: errorDetails(error),
        privacy: '报告不包含聊天正文、完整提示词、世界书条目内容或聊天标识。',
    };
    latestReportName = `cwb-error-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    latestReportJson = JSON.stringify(report, null, 2);
    const button = document.getElementById('cwb-download-error-report');
    if (button) button.hidden = false;
    return report;
}

export function downloadLatestErrorReport() {
    if (!latestReportJson || !latestReportName) return false;
    const url = URL.createObjectURL(new Blob([latestReportJson], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = latestReportName;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}
