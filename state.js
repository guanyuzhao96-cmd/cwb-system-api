export const MODULE_NAME = 'cwb_system_api';

export const state = {
    chatId: 'unknown_chat_init',
    messages: [],
    updating: false,
    timelineUpdating: false,
    batchRunning: false,
    batchStopRequested: false,
    operationOwner: null,
    routeCache: null,
    profileArchiveRegistry: null,
};

export function acquireOperationLock(targetState, owner) {
    if (targetState.operationOwner) throw new Error(`当前正在执行“${targetState.operationOwner}”，请完成后再启动新操作。`);
    targetState.operationOwner = owner;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (targetState.operationOwner === owner) targetState.operationOwner = null;
    };
}
