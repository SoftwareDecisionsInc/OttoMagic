

var dispatchResults;
async function init() {
    BROWSER.runtime.onMessage.addListener(Messaging.handleMessagesToContent);

    //Get the default persistence object
    Persistence.reloadPersistence();

    // On service-worker warmup the first message's sender.tab.id is undefined, so
    // if tab id comes back null we ask once more (the SW is warm by then). The
    // retry is driven from the callback, not a promise/.then.
    Messaging.sendMessageToBackground(REQUEST.GET_MY_TAB_ID, onGotTabId);
}

function onGotTabId(tabId) {
    Globals.currentTabID = tabId;
    if (null != tabId) {
        Messaging.sendMessageToBackground(REQUEST.GET_MY_FRAME_ID, onGotFrameId);
    } else {
        // warmup: first call had no tab id, retry once
        Messaging.sendMessageToBackground(REQUEST.GET_MY_TAB_ID, (retryTabId) => {
            Globals.currentTabID = retryTabId;
            if (null != retryTabId) {
                Messaging.sendMessageToBackground(REQUEST.GET_MY_FRAME_ID, onGotFrameId);
            }
        });
    }
}

function onGotFrameId(frameId) {
    Globals.currentContentID = frameId;
    if (0 === Globals.currentContentID) {   // top document
        window.networkIdleObserver = initNetworkIdleObserver();
    }
    if (persistence?.settings?.debugMessages) {
        console.log("content starting up @", window.location.href,
            "contentId:" + Globals.currentContentID, "currentTabId:" + Globals.currentTabID);
    }
    secondInit();
}

function secondInit() {
    // tab switched and we are visible again, test if somehow ottomagic was reloaded.
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") {
        } else {
            try {
                Persistence.reloadPersistence().then(() => { let tabDisplayedDosomething = true; });
            } catch (error) {
                // Globals.LogMessage(LOG_TYPE.NOTICE, `OttoMagic Reloaded?\n${toastStrong('PLEASE REFRESH PAGE.')}`); // handled in persistence if objResult is not defined - shows alert
            }
        }
    });

    // Add an event listener to the `window` object of the page
    // The unhandledrejection event is fired when a Promise is rejected (i.e., fails with an error), and no .catch() handler is attached to handle that rejection.
    window.addEventListener("unhandledrejection", (event) => {
        reportError({
            type: "unhandledrejection",
            message: event.reason?.message || String(event.reason),
            stack: event.reason?.stack,
        });
    });

    window.addEventListener("error", (event) => {
        reportError({
            type: "error",
            message: event.message,
            stack: event.error?.stack,
            file: event.filename,
            //line: event.lineno,
            column: event.colno,
        });
    });
}

let lastActivity = performance.now();
init();