/* GLOBAL STORAGE KEYS */
const GLOBAL_QUERY_MISS_KEY = 'GPAL_QUERY_MISS_ARRAY';
const GLOBAL_FRAME_COUNT_KEY = 'GPAL_FRAME_COUNT';
const queryResponseTrackers = new Map(); // messageId > tracker

/* DOWNLOAD FILENAME INTERCEPT
   One listener at a time, held here rather than in the case that made it.
   It comes off when it fires, when another arming replaces it, when the caller navigates, and failing all of
   those when it has waited longer than any download would take to start. */
const DOWNLOAD_ARM_TIMEOUT_MS = 120000;
let downloadFilenameListener = null;
let downloadArmTimer = null;

function disarmDownloadFilename(why) {
    if (!canNameDownloads())
        return;

    if (downloadArmTimer) {
        clearTimeout(downloadArmTimer);
        downloadArmTimer = null;
    }

    if (!downloadFilenameListener)
        return;

    BROWSER.downloads.onDeterminingFilename.removeListener(downloadFilenameListener);
    downloadFilenameListener = null;

    Globals.LogMessage("Filename listener removed:", why);
}

function canNameDownloads() {
    // chromium only. firefox has never shipped onDeterminingFilename, so a download cannot be named before it
    // lands there - it saves under the browser's own name and gpal's file watcher renames it afterwards
    return !!BROWSER?.downloads?.onDeterminingFilename;
}

/* What onDeterminingFilename will accept, worked out from what the caller asked for.
   The name is relative to the browser's own download directory. An absolute path, a drive letter, a UNC share or
   a ".." segment is rejected outright and the suggestion is dropped, taking the filename with it - so a caller
   that hands over "c:\sdi\sample.pdf" ends up with neither the directory it wanted nor the name.
   A relative subdirectory is allowed and kept, which is what "GPALtemp/file123.pdf" relies on. Anything the API
   will not take is reduced to its leaf, so the name survives even though the directory cannot. */
function downloadNameFor(downloadPath) {
    const asked = String(downloadPath ?? "").trim();
    const separators = /[\\/]/;
    const leaf = asked.replace(/^[a-zA-Z]:/, "").split(separators).pop();   // drive taken off first, "c:sample.pdf" has no separator to split on

    if (!asked)
        return asked;

    const rooted = /^[a-zA-Z]:[\\/]?/.test(asked)   // c:\sdi\sample.pdf, c:sample.pdf
                || /^[\\/]/.test(asked)             // \sdi\sample.pdf, /sdi/sample.pdf, \\server\share
                || asked.split(separators).includes("..");

    return rooted ? leaf : asked.replace(/\\/g, "/");   // chrome names its subdirectories with forward slashes
}

function armDownloadFilename(downloadPath) {
    if (!canNameDownloads()) {
            Globals.LogMessage("This browser cannot name a download, letting it save under its own name");

        return;
    }

    // whatever was waiting is stale the moment a new destination is named
    disarmDownloadFilename("replaced by a new destination");

    const downloadName = downloadNameFor(downloadPath);

    if (downloadName !== downloadPath)
        Globals.LogMessage("Download destination reduced to what onDeterminingFilename accepts:", downloadPath, "->", downloadName);

    downloadFilenameListener = function (downloadItem, suggest) {
            Globals.LogMessage("Intercepting download, assigning filename:", downloadName);

        suggest({
            filename: downloadName,
            conflictAction: "overwrite"
        });

        disarmDownloadFilename("named the download it was armed for");
    };

    BROWSER.downloads.onDeterminingFilename.addListener(downloadFilenameListener);
    downloadArmTimer = setTimeout(() => disarmDownloadFilename("no download started"), DOWNLOAD_ARM_TIMEOUT_MS);
}

// First selector the payload actually carries, in GPAL's order of preference.
// ?? would let an empty elementId win over a supplied css/xpath.
function pickSelector(data) {
    if (!data) { return undefined; }
    for (const selector of [data.elementId, data.css, data.xpath]) {
        if (typeof selector === 'string') {
            if (selector.trim() !== '') { return selector; }
        } else if (selector != null) {
            return selector;
        }
    }
    return undefined;
}

// Window/document-level requests concern the top window, not the active iframe --
// with frame-targeting on, these must go to the main frame (0) regardless of the
// current InIframe context, or the iframe's content script bails (it's not frame 0)
// and we get null back.
//
// Built lazily: REQUEST (Constants.js) loads BEFORE Messaging.js in the background
// but AFTER it in content, so referencing REQUEST at module-eval time throws in
// content and breaks the whole file. readFromNativeApp is background-only, where
// REQUEST is defined by the time this runs.
let _topFrameMessages = null;
function isTopFrameMessage(message) {
    if (!_topFrameMessages) {
        _topFrameMessages = new Set([
            REQUEST.GET_WINDOW_RECTANGLE,
            REQUEST.GET_PAGE_SOURCE,
            REQUEST.IS_END_OF_PAGE,
            REQUEST.WINDOW_INNER_HEIGHT, REQUEST.WINDOW_INNER_WIDTH,
            REQUEST.WINDOW_OUTER_HEIGHT, REQUEST.WINDOW_OUTER_WIDTH,
            REQUEST.WINDOW_PAGE_XOFFSET, REQUEST.WINDOW_PAGE_YOFFSET,
            REQUEST.WINDOW_SCREEN_LEFT, REQUEST.WINDOW_SCREEN_TOP,
        ]);
    }
    return _topFrameMessages.has(message);
}

class Messaging {
    static port;
    ///////////////////////
    // Message Helpers
    ///////////////////////
    /**
         * Processes a message received from the native messaging host and forwards
         * it to the appropriate extension components (such as the popup UI).
         *
         * @async
         * @static
         * @param {*} request - The message received from the native messaging host.
         * @param {Object} sender - Information about the sender of the message.
         * @param {Function} sendResponse - Callback that can be used to send a
         * response to the sender if applicable.
         * @returns {Promise<void>} A promise that resolves after the message has been
         * processed.
         */
    static async readFromNativeApp(request, sender, sendResponse) {
        
        var retval = true;
        await Persistence.reloadPersistence();

        Globals.LogMessage("readfromnativeapp: " + request.message);

        // Target the active frame (framework model) instead of broadcasting to all
        // frames. InIframe moves this to a child; InMainDom resets it to 0.
        var contentFrameId = Globals.activeFrameId ?? 0;
        // Window/document-level requests always concern the top window, never the
        // active iframe -- pin them to the main frame.
        if (isTopFrameMessage(request.message)) contentFrameId = 0;
        var activeTabId = await getActiveTabId();
        if (!["die", "set-port"].includes(request.message)) {
            updateWorkflowState();
        }

        if (persistence?.settings?.debugMessages || !["die", "set-port"].includes(request.message)) {
            logAuditTrail(
                "native-app",
                `tabId [${activeTabId}]`,
                request.message + (request.data ? ' [' + Object.values(request.data)[0] + ']' : '')
            );
        }

        // nothing a handler does may leave the client waiting: an option the browser does not support, an
        // empty tab list, a rejected promise. any of those threw out of here and answered nothing at all, so
        // the call sat until its timeout with no reason anywhere. the body is left at its own indent
        requestAnswered = false;
        try {
        switch (request.message) {
            case REQUEST.UPLOAD:    // NOTE: attach a file to the upload button, sends the real file stored in browser, could cause memory issues?
                var elementId = pickSelector(request.data);
                var fileName = request.data.fileName;
                var uploadPath = request.data.uploadPath;  // optional, for logging
                var mimeType = request.data.mimeType || "application/octet-stream";
                var base64Data = request.data.base64Data;

                if (!base64Data) {
                    sendToNativeAppFromBackground("missing base64Data");
                    break;
                }

                // Pass the raw data to content script instead of a File object
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: elementId,
                    fileName: fileName,
                    mimeType: mimeType,
                    base64Data: base64Data   // send the string, it's serializable
                }, function (response) {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SET_PORT:
                // The native app reporting which port its REST server landed on. Deliberately answered with
                // nothing: the pipe pairs one response to one request with no correlation id, so an ack here would
                // be read as the answer to whatever GPAL has in flight and put every later call one slot behind.
                // Outbound-with-no-reply is what lets the native side send this whenever a listener comes up.
                persistence.serverPort = request.data?.port ?? null;
                Persistence.savePersistence();
                break;
            case REQUEST.BACK:
                navigateHistory(activeTabId, 'back').then((url) => {
                    sendToNativeApp(url ? { tabId: activeTabId, Url: url } : 'NOTOK');
                });
                break;
            case REQUEST.CAPTURE_VISIBLE_TAB: //TEST: windowId version
                var tempWindow = null;
                if (request.data && request.data.windowId) {
                    tempWindow = request.data.windowId;
                }
                if (tempWindow == null) {
                    BROWSER.tabs.captureVisibleTab(
                        { format: 'png' },
                        (dataUrl) => {
                            if (BROWSER.runtime.lastError) {
                                sendToNativeAppFromBackground('NOTOK');
                            } else {
                                sendToNativeAppFromBackground(dataUrl);
                            }
                        }
                    );
                }
                else {
                    BROWSER.tabs.captureVisibleTab(
                        tempWindow,
                        { format: 'png' },
                        (dataUrl) => {
                            if (BROWSER.runtime.lastError) {
                                sendToNativeAppFromBackground('NOTOK');
                            } else {
                                sendToNativeAppFromBackground(dataUrl);
                            }
                        }
                    );
                }
                break;
            case REQUEST.CHECK_NETWORK_IDLE:
                // GPAL sends maxConnections and pruneMs in request.data. This answers at once; GPAL asks again until
                // it gets idle or its own timeout ends. The quiet time a page needs stays this check's own.
                checkTabIdleStatus(activeTabId, undefined, request.data?.maxConnections, request.data?.pruneMs)
                    .then(result => {
                        sendToNativeAppFromBackground(result);
                    });
                break;
            case REQUEST.CLEAR_REFERRER:
                // drops a referrer set for the next navigation; nothing else in the browser carries one
                await endOneNavigationReferrer();
                sendToNativeAppFromBackground('OK');
                retval = false;
                break;
            case REQUEST.CLOSE_TAB:
                if (request.data) {
                    if (request.data.tabId) {
                        BROWSER.tabs.get(request.data.tabId, (tab) => {
                            if (BROWSER.runtime.lastError) {
                                // Fallback: treat as no tab found, send blank state
                                sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank" });
                                return;
                            }
                            // Use callback to query after removal completes
                            BROWSER.tabs.remove(tab.id, () => {
                                if (BROWSER.runtime.lastError) {
                                    sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank", error: BROWSER.runtime.lastError.message });
                                    return;
                                }
                                BROWSER.tabs.query({ active: true, lastFocusedWindow: true }, function (activeTabs) {
                                    if (BROWSER.runtime.lastError) {
                                        sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank", error: BROWSER.runtime.lastError.message });
                                        return;
                                    }
                                    if (activeTabs.length > 0) {
                                        sendToNativeAppFromBackground({ tabId: activeTabs[0].id, Url: activeTabs[0].url });
                                    } else {
                                        // No active tabs left (e.g., closed last tab)
                                        sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank" });
                                    }
                                });
                            });
                        });
                    } else if (request.data.url) {
                        BROWSER.tabs.query({}, function (tabs) {
                            if (BROWSER.runtime.lastError) {
                                sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank", error: BROWSER.runtime.lastError.message });
                                return;
                            }
                            let found = false;
                            for (let tab of tabs) {
                                if (stripUrlPrefix(tab.url).startsWith(stripUrlPrefix(request.data.url))) {
                                    found = true;
                                    // Use callback to query after removal
                                    BROWSER.tabs.remove(tab.id, () => {
                                        if (BROWSER.runtime.lastError) {
                                            sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank", error: BROWSER.runtime.lastError.message });
                                            return;
                                        }
                                        BROWSER.tabs.query({ active: true, lastFocusedWindow: true }, function (activeTabs) {
                                            if (BROWSER.runtime.lastError) {
                                                sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank", error: BROWSER.runtime.lastError.message });
                                                return;
                                            }
                                            if (activeTabs.length > 0) {
                                                sendToNativeAppFromBackground({ tabId: activeTabs[0].id, Url: activeTabs[0].url });
                                            } else {
                                                sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank" });
                                            }
                                        });
                                    });
                                    break;
                                }
                            }
                            // If no matching tab found
                            if (!found) {
                                if (tabs.length > 0) {
                                    // Reuse existing tabs array: find active one or fallback to first
                                    let activeTab = tabs.find(t => t.active);
                                    if (activeTab) {
                                        sendToNativeAppFromBackground({ tabId: activeTab.id, Url: activeTab.url });
                                    } else {
                                        sendToNativeAppFromBackground({ tabId: tabs[0].id, Url: tabs[0].url });
                                    }
                                } else {
                                    sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank" });
                                }
                            }
                        });
                    }
                } else {
                    // No data: close active tab
                    BROWSER.tabs.query({ active: true, lastFocusedWindow: true }, function (activeTabs) {
                        if (BROWSER.runtime.lastError || activeTabs.length === 0) {
                            sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank" });
                            return;
                        }
                        BROWSER.tabs.remove(activeTabs[0].id, () => {
                            if (BROWSER.runtime.lastError) {
                                sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank", error: BROWSER.runtime.lastError.message });
                                return;
                            }
                            BROWSER.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
                                if (BROWSER.runtime.lastError) {
                                    sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank", error: BROWSER.runtime.lastError.message });
                                    return;
                                }
                                if (tabs.length > 0) {
                                    sendToNativeAppFromBackground({ tabId: tabs[0].id, Url: tabs[0].url });
                                } else {
                                    sendToNativeAppFromBackground({ tabId: 0, Url: "about:blank" });
                                }
                            });
                        });
                    });
                }
                break;
            case REQUEST.CLOSE_BROWSER:
                // every window the browser has, not only the ones GPAL opened: a page can open one, and so can
                // whoever is driving, and the browser only quits when the last of them goes. an extension cannot
                // quit its own browser, but closing them all is an ordinary quit, so the profile is written and
                // the exit is recorded clean rather than as a crash.
                // answered before any of them close, because the last one takes this extension down with it and
                // there would be nothing left to reply with
                BROWSER.windows.getAll({}, (windows) => {
                    sendToNativeAppFromBackground('OK');

                    for (const win of windows) {
                        BROWSER.windows.remove(win.id);
                    }
                });
                retval = false;
                break;
            case REQUEST.CLOSE_WINDOW: { // TEST: no parameter version
                // Answers the window left active as { windowId, url }, as open-window and get-current-window do.
                // Closing the last window takes this extension down with it, so then the answer goes first and
                // names no window.
                const closeAndAnswer = (windowId) => {
                    BROWSER.windows.getAll({}, (windows) => {
                        if (windows.length <= 1) {
                            sendToNativeAppFromBackground({ windowId: null, url: null });
                            BROWSER.windows.remove(windowId);
                            return;
                        }
                        BROWSER.windows.remove(windowId, () => {
                            BROWSER.windows.getLastFocused({ populate: true }, (win) => {
                                const tab = win.tabs.find(t => t.active);
                                sendToNativeAppFromBackground({ windowId: win.id, url: tab ? tab.url : null });
                            });
                        });
                    });
                };

                if (!request.data) {
                    BROWSER.windows.getCurrent({}, (win) => {
                        closeAndAnswer(win.id);
                    });
                }
                else if (request.data.windowId) {
                    closeAndAnswer(request.data.windowId);
                }
                else if (request.data.url) {
                    BROWSER.windows.getAll({ populate: true }, (windows) => {
                        for (const window of windows) {
                            for (const tab of window.tabs) {
                                if (tab.url && stripUrlPrefix(tab.url).startsWith(stripUrlPrefix(request.data.url))) {
                                    closeAndAnswer(window.id);
                                    return;
                                }
                            }
                        }
                        sendToNativeAppFromBackground('NOTOK');
                    });
                }
                break;
            }
            case REQUEST.DELETE_STORAGE:
                if (!request.data.storageType) {
                    BROWSER.browsingData.remove({}, {
                        cache: true,
                        cookies: true,
                        localStorage: true,
                        serviceWorkers: true
                    });
                } else {
                    const tabs = await BROWSER.tabs.query({});
                    const domain = request.data.domain;
                    const key = request.data.key;
                    const path = request.data.path;
                    const storeName = request.data.storeName;
                        Globals.LogMessage(domain);
                        Globals.LogMessage(key);
                        Globals.LogMessage(path);
                    switch (request.data.storageType) {
                        case "cookie":
                            if (domain) {
                                const cookies = await BROWSER.cookies.getAll({ partitionKey: {} });
                                Globals.LogMessage(cookies.map(c => c.domain));

                                const filtered = cookies.filter(cookie => {
                                    if (!cookieDomainMatches(cookie.domain, domain)) return false;
                                    if (path && cookie.path !== path) return false;
                                    if (key && cookie.name !== key) return false;

                                    return true;
                                });

                                for (const cookie of filtered) {
                                    let cleanDomain = cookie.domain;
                                    if (cleanDomain.startsWith(".")) {
                                        cleanDomain = cleanDomain.substring(1);
                                    }

                                    const url = `https://${cleanDomain}${cookie.path}`;

                                    const result = await BROWSER.cookies.remove({
                                        url,
                                        name: cookie.name,
                                        storeId: cookie.storeId,
                                        partitionKey: cookie.partitionKey
                                    });
                                    Globals.LogMessage("Tried removing:", cookie.name, "Result:", result);

                                }
                                Globals.LogMessage(`Attempted to delete ${filtered.length} cookies`);
                            }
                            else {
                                BROWSER.browsingData.remove({}, {
                                    cookies: true
                                });
                            }
                            break;
                        case "localStorage":
                            if (domain) {
                                const origin = ensureHttps(domain);

                                // Case 1: Delete ALL localStorage for domain
                                if (!key) {
                                    // browsingData's origins is a chrome only option, so this is cleared in the page instead
                                    const clearTabs = await BROWSER.tabs.query({
                                        url: ["http://*/*", "https://*/*"]
                                    });

                                    const clearTarget = stripUrlPrefix(domain);
                                    const clearMatches = clearTabs.filter(tab => tab.url && stripUrlPrefix(tab.url).startsWith(clearTarget));

                                    if (!clearMatches.length) {
                                        console.warn(`No open tabs found for ${domain}`);
                                        sendToNativeAppFromBackground('NOTOK');
                                        return;
                                    }

                                    await BROWSER.scripting.executeScript({
                                        target: { tabId: clearMatches[0].id },
                                        func: () => { localStorage.clear(); return 'OK'; }
                                    });

                                    Globals.LogMessage(`All localStorage cleared for ${origin}`);
                                } else {
                                    // Case 2: Delete specific key
                                    const tabs = await BROWSER.tabs.query({
                                        url: ["http://*/*", "https://*/*"]
                                    });

                                    const target = stripUrlPrefix(domain);

                                    const matchingTabs = tabs.filter(tab => {
                                        if (!tab.url) return false;

                                        return stripUrlPrefix(tab.url).startsWith(target);
                                    });

                                    if (!matchingTabs.length) {
                                        console.warn(`No open tabs found for ${domain}`);
                                        sendToNativeAppFromBackground('NOTOK');
                                        return;
                                    }

                                    await BROWSER.scripting.executeScript({
                                        target: { tabId: matchingTabs[0].id },
                                        func: (k) => {
                                            localStorage.removeItem(k);
                                        },
                                        args: [key]
                                    });
                                        Globals.LogMessage(`Key "${key}" removed from ${domain}`);
                                }
                            }
                            else {
                                BROWSER.browsingData.remove(
                                    { since: 0 },
                                    { localStorage: true }
                                );
                            }
                            break;
                        case "sessionStorage":
                            if (domain) {

                                const tabs = await BROWSER.tabs.query({
                                    url: ["http://*/*", "https://*/*"]
                                });

                                const target = stripUrlPrefix(domain);

                                const matchingTabs = tabs.filter(tab => {
                                    if (!tab.url) return false;
                                    return stripUrlPrefix(tab.url).startsWith(target);
                                });

                                if (!matchingTabs.length) {
                                    console.warn(`No open tabs found for ${domain}`);
                                    sendToNativeAppFromBackground('NOTOK');
                                    return;
                                }

                                // If no key  clear ALL sessionStorage in each matching tab
                                if (!key) {
                                    for (const tab of matchingTabs) {
                                        await BROWSER.scripting.executeScript({
                                            target: { tabId: tab.id },
                                            func: () => {
                                                sessionStorage.clear();
                                            }
                                        });
                                    }
                                        Globals.LogMessage(`All sessionStorage cleared for ${domain}`);
                                }

                                // If key provided  remove specific key
                                else {
                                    for (const tab of matchingTabs) {
                                        await BROWSER.scripting.executeScript({
                                            target: { tabId: tab.id },
                                            func: (k) => {
                                                sessionStorage.removeItem(k);
                                            },
                                            args: [key]
                                        });
                                    }
                                        Globals.LogMessage(`Key "${key}" removed from sessionStorage for ${domain}`);
                                }
                            }
                            else {
                                // Clear sessionStorage from ALL open tabs
                                const tabs = await BROWSER.tabs.query({
                                    url: ["http://*/*", "https://*/*"]
                                });

                                for (const tab of tabs) {
                                    if (!tab.id) continue;

                                    await BROWSER.scripting.executeScript({
                                        target: { tabId: tab.id },
                                        func: () => {
                                            sessionStorage.clear();
                                        }
                                    });
                                }
                                    Globals.LogMessage("All sessionStorage cleared in all open tabs");
                            }
                            break;
                        case "cache":
                            if (domain) {
                                const origin = ensureHttps(domain);

                                //No path, no key  clear ALL cache storage for domain
                                if (!path && !key) {
                                    // browsingData's origins and cacheStorage are chrome only options, so the caches are opened and
                                    const clearTabs = await BROWSER.tabs.query({
                                        url: ["http://*/*", "https://*/*"]
                                    });

                                    const clearTarget = stripUrlPrefix(domain);
                                    const clearMatches = clearTabs.filter(tab => tab.url && stripUrlPrefix(tab.url).startsWith(clearTarget));

                                    if (!clearMatches.length) {
                                        console.warn(`No open tabs found for ${domain}`);
                                        sendToNativeAppFromBackground('NOTOK');
                                        return;
                                    }

                                    await BROWSER.scripting.executeScript({
                                        target: { tabId: clearMatches[0].id },
                                        func: async () => {
                                        const names = await caches.keys();

                                        for (const each of names) {
                                            await caches.delete(each);
                                        }

                                        return 'OK';
                                    }
                                    });

                                    Globals.LogMessage(`All cache storage cleared for ${origin}`);

                                } else {
                                    // We need matching tabs for script injection
                                    const tabs = await BROWSER.tabs.query({
                                        url: ["http://*/*", "https://*/*"]
                                    });

                                    const target = stripUrlPrefix(domain);

                                    const matchingTabs = tabs.filter(tab => {
                                        if (!tab.url) return false;
                                        return stripUrlPrefix(tab.url).startsWith(target);
                                    });

                                    if (!matchingTabs.length) {
                                        console.warn(`No open tabs found for ${domain}`);
                                        sendToNativeAppFromBackground('NOTOK');
                                        return;
                                    } else {
                                        const tabId = matchingTabs[0].id;

                                        //path provided, no key  delete named cache
                                        if (storeName && !key) {
                                            await BROWSER.scripting.executeScript({
                                                target: { tabId },
                                                func: async (cacheName) => {
                                                    if (!("caches" in window)) return;
                                                    await caches.delete(cacheName);
                                                },
                                                args: [storeName]
                                            });
                                            Globals.LogMessage(`Cache "${storeName}" deleted for ${domain}`);
                                        } else if (storeName && key) {   //path + key  delete specific request inside named cache
                                            await BROWSER.scripting.executeScript({
                                                target: { tabId },
                                                func: async (cacheName, requestUrl) => {
                                                    if (!("caches" in window)) return;

                                                    const cache = await caches.open(cacheName);
                                                    await cache.delete(requestUrl);
                                                },
                                                args: [storeName, key]
                                            });
                                            Globals.LogMessage(`Request "${key}" removed from cache "${storeName}" for ${domain}`);
                                        }
                                    }
                                }
                            } else {
                                // No domain clear EVERYTHING
                                await BROWSER.browsingData.remove(
                                    { since: 0 },
                                    { cacheStorage: true }
                                );
                                Globals.LogMessage("All cache storage cleared globally");
                            }
                            break;
                        case "indexedDb":
                            if (domain) {
                                const origin = ensureHttps(domain);

                                // CASE 1 No path  clear ALL IndexedDB for domain
                                if (!path) {
                                    // browsingData's origins is a chrome only option, so the databases are listed and dropped in the page
                                    const clearTabs = await BROWSER.tabs.query({
                                        url: ["http://*/*", "https://*/*"]
                                    });

                                    const clearTarget = stripUrlPrefix(domain);
                                    const clearMatches = clearTabs.filter(tab => tab.url && stripUrlPrefix(tab.url).startsWith(clearTarget));

                                    if (!clearMatches.length) {
                                        console.warn(`No open tabs found for ${domain}`);
                                        sendToNativeAppFromBackground('NOTOK');
                                        return;
                                    }

                                    await BROWSER.scripting.executeScript({
                                        target: { tabId: clearMatches[0].id },
                                        func: async () => {
                                        const dbs = await indexedDB.databases();

                                        for (const each of dbs) {
                                            if (each.name) {
                                                indexedDB.deleteDatabase(each.name);
                                            }
                                        }

                                        return 'OK';
                                    }
                                    });

                                    Globals.LogMessage(`All IndexedDB cleared for ${origin}`);
                                } else {

                                    // We need a matching tab for granular operations
                                    const tabs = await BROWSER.tabs.query({
                                        url: ["http://*/*", "https://*/*"]
                                    });

                                    const target = stripUrlPrefix(domain);

                                    const matchingTabs = tabs.filter(tab => {
                                        if (!tab.url) return false;
                                        return stripUrlPrefix(tab.url).startsWith(target);
                                    });

                                    if (!matchingTabs.length) {
                                        console.warn(`No open tabs found for ${domain}`);
                                        sendToNativeAppFromBackground('NOTOK');
                                        return;
                                    }

                                    const tabId = matchingTabs[0].id;

                                    // CASE 2 - Delete entire database
                                    if (path && !storeName) {
                                        await BROWSER.scripting.executeScript({
                                            target: { tabId },
                                            func: async (dbName) => {
                                                await new Promise((resolve, reject) => {
                                                    const request = indexedDB.deleteDatabase(dbName);
                                                    request.onsuccess = () => resolve();
                                                    request.onerror = () => reject(request.error);
                                                    request.onblocked = () => reject("Delete blocked");
                                                });
                                            },
                                            args: [path]
                                        });
                                        Globals.LogMessage(`Database "${path}" deleted for ${domain}`);
                                    } else if (path && storeName && key !== undefined) {    // CASE 3 - Delete specific record from store
                                        await BROWSER.scripting.executeScript({
                                            target: { tabId },
                                            func: async (dbName, store, recordKey) => {
                                                const openReq = indexedDB.open(dbName);

                                                await new Promise((resolve, reject) => {
                                                    openReq.onerror = () => reject(openReq.error);

                                                    openReq.onsuccess = () => {
                                                        const db = openReq.result;

                                                        const tx = db.transaction(store, "readwrite");
                                                        const objectStore = tx.objectStore(store);

                                                        objectStore.delete(recordKey);

                                                        tx.oncomplete = () => {
                                                            db.close();
                                                            resolve();
                                                        };

                                                        tx.onerror = () => reject(tx.error);
                                                    };
                                                });
                                            },
                                            args: [path, storeName, key]
                                        });
                                        Globals.LogMessage(
                                            `Record "${key}" removed from store "${storeName}" in DB "${path}" for ${domain}`
                                        );
                                    }
                                }
                            }
                            else {
                                // No domain  clear EVERYTHING globally
                                await BROWSER.browsingData.remove(
                                    { since: 0 },
                                    { indexedDB: true }
                                );
                                Globals.LogMessage("All IndexedDB cleared globally");
                            }
                            break;
                    }
                }
                sendToNativeAppFromBackground('OK');
                break;
            case REQUEST.EVALUATE_PERSISTENT:
                Messaging.sendQueryMessage(activeTabId, request.message, { xpath: request.data.xpath }, true, 0);
                break;
            case REQUEST.EVALUATE:
                Messaging.sendQueryMessage(activeTabId, request.message, { xpath: request.data.xpath }, true, contentFrameId);
                break;
            case REQUEST.EVALUATE_ALL_PERSISTENT:
                Messaging.sendQueryMessage(activeTabId, request.message, { xpath: request.data.xpath }, false, 0);
                break;
            case REQUEST.EVALUATE_ALL:
                Messaging.sendQueryMessage(activeTabId, request.message, { xpath: request.data.xpath }, false, contentFrameId);
                break;
            case REQUEST.FETCH:
                // the page issues the request, not the extension, so it carries the origin the tab is already on
                // along with its cookies and whatever clearance the session has earned
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    url: request.data.url,
                    method: request.data.method,
                    body: request.data.body,
                    contentType: request.data.contentType,
                    headers: request.data.headers,
                    bytes: request.data.bytes
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.FILL_IN_APPEND:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    text: request.data.text
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.FILL_IN_INSERT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    text: request.data.text
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.FILL_IN_OVERWRITE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    text: request.data.text
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.FIRE_CHANGE_EVENT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.FOCUS:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.DRAG_AND_DROP:
                if (!request.data.deltaX) { request.data.deltaX = 0; }
                if (!request.data.deltaY) { request.data.deltaY = 0; }
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    deltaX: request.data.deltaX,
                    deltaY: request.data.deltaY,
                    // Grab offset within the element; when GPAL sends it, playback
                    // grabs there instead of the center. Undefined -> center fallback.
                    offsetX: request.data.offsetX,
                    offsetY: request.data.offsetY
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.FORWARD:
                navigateHistory(activeTabId, 'forward').then((url) => {
                    sendToNativeApp(url ? { tabId: activeTabId, Url: url } : 'NOTOK');
                });
                break;
            case REQUEST.FULLSCREEN:
                BROWSER.windows.getCurrent({}, function (window) {
                    BROWSER.windows.update(window.id, { state: "fullscreen" });
                    sendToNativeApp('OK');
                });
                break;
            case REQUEST.GET_ATTRIBUTE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    attribute: request.data.attribute,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SET_ATTRIBUTE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    attribute: request.data.attribute,
                    value: request.data.value
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SET_VALUE_FROM_ELEMENT:
                // elementId is the source, destSelector the destination it is copied into
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    destSelector: request.data.destSelector
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_BOUNDING_CLIENT_RECT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.ELEMENT_FROM_POINT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    x: request.data.x,
                    y: request.data.y
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_CONTENT_AND_CSS:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_CSS_ATTRIBUTES:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_CURRENT_URL:
                BROWSER.tabs.query({ active: true }, function (tabs) {
                    if (tabs.length > 0) {
                        sendToNativeAppFromBackground(tabs[0].url);
                    }
                    else
                        sendToNativeAppFromBackground('NOTOK');
                });
                break;
            case REQUEST.GET_CURRENT_WINDOW:
                BROWSER.windows.getCurrent(function (window) {
                    BROWSER.tabs.query({ active: true }, function (tabs) {
                        if (tabs.length > 0) {
                            sendToNativeAppFromBackground({ windowId: window.id, url: tabs[0].url });
                        }
                        else
                            sendToNativeAppFromBackground('NOTOK');
                    });
                });
                break;
            case REQUEST.GET_DOCUMENT_STAMP: {
                // performance.timeOrigin is set when the document is created, so it changes when a page is
                // replaced even at the same address, which is what tells a real navigation from a click that
                // went nowhere. the url rides along because the caller wants both and this is asked after
                // every click.
                // straight after a navigation the content script may not be injected yet and nothing would
                // ever answer, so the tab answers instead: its url with no origin, which the caller reads as
                // "cannot say yet" rather than as a page that never moved
                let stampHandled = false;

                const answerStampFromTab = () => {
                    if (stampHandled) return;
                    stampHandled = true;

                    BROWSER.tabs.get(activeTabId, (tab) => {
                        void BROWSER.runtime.lastError;
                        sendToNativeAppFromBackground(tab && tab.url ? "|" + tab.url : "NOTOK");
                    });
                };

                const stampTimer = setTimeout(answerStampFromTab, 1000);

                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message
                }, (response) => {
                    if (stampHandled) return;

                    clearTimeout(stampTimer);

                    if (response && response.origin) {
                        stampHandled = true;
                        sendToNativeApp(response.origin + "|" + response.url);
                    }
                    else
                        answerStampFromTab();
                });
                break;
            }
            case REQUEST.GET_DOM_ATTRIBUTES:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_DOM_PROPERTIES:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_ELEMENT_ATTRIBUTE_HASH:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_HYDRATION_SCRIPTS:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_PAGE_SOURCE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_PARENT_NODE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_READY_STATUS: {
                // A navigation that failed outright is the one thing this call must not answer 'loading' to. The
                // page is not coming, so the caller would poll until it gave up and then carry on as though the
                // page were merely slow. Say what happened instead, once, and let the caller decide to stop
                if (Globals.navError) {
                    sendToNativeAppFromBackground('nav-error ' + Globals.navError);
                    break;
                }

                // Primary route: ask frame 0's content script for document.readyState
                // (gives real 'loading'/'interactive'/'complete'). But the content
                // script may not be injected yet on a new tab / mid-navigation, in
                // which case that message never gets a receiver and would hang. So if
                // nothing comes back within 3s, answer from the background via
                // tabs.get().status so GPAL always gets a status to keep polling on.
                let readyStatusHandled = false;

                // Nothing answered from the page. Ask the tab itself: when the browser
                // says 'complete' the navigation really has finished and the tab simply
                // has nothing we can inject into -- a download that left a blank tab, a
                // built-in viewer, an about: page. Answering 'loading' there makes GPAL
                // poll a tab that is never going to change, then carry on as though the
                // page had merely been slow.
                const answerReadyFromTab = () => {
                    BROWSER.tabs.get(activeTabId, (tab) => {
                        void BROWSER.runtime.lastError;
                        sendToNativeAppFromBackground(tab?.status === 'complete' ? 'complete' : 'loading', true);
                    });
                };

                const readyStatusTimer = setTimeout(() => {
                    if (readyStatusHandled) return;
                    readyStatusHandled = true;
                    answerReadyFromTab();
                }, 3000);

                Messaging.messageATab(activeTabId, 0, {
                    message: request.message,
                }, (response) => {
                    if (readyStatusHandled) return;
                    readyStatusHandled = true;
                    clearTimeout(readyStatusTimer);
                    // A null/absent response means frame 0 had no live content script to
                    // report document.readyState (messageATab surfaces a missing receiver
                    // as null) -- fall back to the tab's own status rather than forwarding
                    // null or assuming the page is still on its way.
                    if (response != null) {
                        sendToNativeApp(response, true);
                    } else {
                        answerReadyFromTab();
                    }
                });
                break;
            }
            case REQUEST.GET_SHADOW_ROOT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GET_STATUS_CODE:
                // 0 when this tab's page has no status: no response yet, or the navigation failed outright
                sendToNativeAppFromBackground(Globals.serverStatusCodes[activeTabId] ?? 0);
                retval = false;
                break;
            case REQUEST.GET_STORAGE:
                if (!request.data.storageType) {

                } else {
                    const tabs = await BROWSER.tabs.query({});
                    const domain = request.data.domain;
                    const key = request.data.key;
                    const path = request.data.path;
                    const dbName = request.data.path;
                    const storeName = request.data.storeName;
                    let jsonString = '';
                        Globals.LogMessage(domain);
                        Globals.LogMessage(key);
                        Globals.LogMessage(path);
                    switch (request.data.storageType) {
                        // NOTE: this gets all cookies, not just a list of names given a wildcard (missing parm)
                        case "cookie":
                            if (domain) {
                                const cookies = await BROWSER.cookies.getAll({ partitionKey: {} });
                                 Globals.LogMessage(cookies.map(c => c.domain));
                                const filtered = cookies.filter(cookie => {
                                    if (!cookieDomainMatches(cookie.domain, domain)) return false;
                                    if (path && cookie.path !== path) return false;
                                    if (key && cookie.name !== key) return false;

                                    return true;
                                });

                                sendToNativeAppFromBackground(filtered, true);
                            }
                            else {
                                const cookies = await BROWSER.cookies.getAll({});
                                sendToNativeAppFromBackground(cookies, true);
                            }
                            break;
                        case "localStorage":
                            // Case 1: Get ALL localStorage for current active tab
                            if (!key) {
                                BROWSER.scripting.executeScript({
                                    target: { tabId: activeTabId },
                                    func: () => {
                                        const data = {};

                                        for (let i = 0; i < localStorage.length; i++) {
                                            const key = localStorage.key(i);
                                            data[key] = localStorage.getItem(key);
                                        }

                                        return data;
                                    }
                                }, (results) => {
                                    if (results && results[0] && results[0].result) jsonString = results[0].result;
                                    sendToNativeAppFromBackground(jsonString, true);
                                });

                            }
                            else {
                                // Case 2: Get specific key
                                BROWSER.scripting.executeScript(
                                    {
                                        target: { tabId: activeTabId }, // you must have this
                                        func: (key) => {
                                            const value = localStorage.getItem(key);

                                            if (value === null) {
                                                return null;
                                            }

                                            // the value on its own, the way selenium and puppeteer answer a
                                            // keyed read and the way this endpoint answers a wildcard one.
                                            // not encoded here: postMessage encodes on the way out
                                            return value;
                                        },
                                        args: [key]
                                    },
                                    (results) => {
                                        if (results && results[0] && results[0].result) jsonString = results[0].result;

                                        if (jsonString === null) {
                                              Globals.LogMessage("Key not found");
                                        } else {
                                            sendToNativeAppFromBackground(jsonString, true)
                                        }
                                    }
                                );
                            }
                            break;
                        case "sessionStorage":
                            // Case 1: Get ALL localStorage for current active tab
                            if (!key) {
                                BROWSER.scripting.executeScript({
                                    target: { tabId: activeTabId },
                                    func: () => {
                                        const data = {};

                                        for (let i = 0; i < sessionStorage.length; i++) {
                                            const key = sessionStorage.key(i);
                                            data[key] = sessionStorage.getItem(key);
                                        }

                                        return data;
                                    }
                                }, (results) => {
                                    if (results && results[0] && results[0].result) jsonString = results[0].result;
                                    Globals.LogMessage(results);
                                    Globals.LogMessage(jsonString);
                                    sendToNativeAppFromBackground(jsonString, true);
                                });

                            }
                            else {
                                // Case 2: Get specific key
                                BROWSER.scripting.executeScript(
                                    {
                                        target: { tabId: activeTabId }, // you must have this
                                        func: (key) => {
                                            const value = sessionStorage.getItem(key);

                                            if (value === null) {
                                                return null;
                                            }

                                            // the value on its own, the way selenium and puppeteer answer a
                                            // keyed read and the way this endpoint answers a wildcard one.
                                            // not encoded here: postMessage encodes on the way out
                                            return value;
                                        },
                                        args: [key]
                                    },
                                    (results) => {
                                        if (results && results[0] && results[0].result) jsonString = results[0].result;

                                        if (jsonString === null) {
                                            Globals.LogMessage("Key not found");
                                        } else {
                                            sendToNativeAppFromBackground(jsonString, true)
                                        }
                                    }
                                );
                            }
                            break;
                        case "cache":
                            //no path no key = Get all cache from current active tab
                            if (!storeName && !key) {
                                queryStorageTab((tabs) => {
                                    if (!tabs || !tabs[0]) {
                                        console.error('No tab to run', request.message, 'on');
                                        sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                        return;
                                    }

                                    const tabId = tabs[0].id;
                                    BROWSER.scripting.executeScript({
                                        target: { tabId },
                                        func: async () => {
                                            // Next level: just the names of the caches themselves
                                            const cacheNames = await caches.keys();
                                            return cacheNames;
                                        }
                                    }, (results) => {
                                        const jsonString = (results && results[0] && results[0].result) || null;
                                        sendToNativeAppFromBackground(jsonString, true);
                                    });
                                });
                            }
                            else if (!key) {
                                queryStorageTab((tabs) => {
                                    if (!tabs || !tabs[0]) {
                                        console.error('No tab to run', request.message, 'on');
                                        sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                        return;
                                    }

                                    const tabId = (tabs && tabs[0]) ? tabs[0].id : null;
                                    if (!tabId) return;

                                    BROWSER.scripting.executeScript({
                                        target: { tabId },
                                        func: async (cacheName) => {
                                            const cache = await caches.open(cacheName);
                                            const responses = await cache.keys();

                                            // NEXT LEVEL: Extract only the URL string from each request object
                                            const names = responses.map(req => req.url);

                                            return names;
                                        },
                                        args: [storeName]
                                    }, (results) => {
                                        // Classic null check for browser compatibility
                                        const jsonString = (results && results[0] && results[0].result) || null;
                                         Globals.LogMessage(jsonString);
                                        sendToNativeAppFromBackground(jsonString, true);
                                    });
                                });
                            }

                            // get request under cache "path" with name "key"
                            else {
                                queryStorageTab((tabs) => {
                                    if (!tabs || !tabs[0]) {
                                        console.error('No tab to run', request.message, 'on');
                                        logError({ type: 'storage-error', message: `failed: ${request.message}: no tab to run it on` });
                                        sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                        return;
                                    }

                                    const tabId = tabs[0].id;

                                    BROWSER.scripting.executeScript(
                                        {
                                            target: { tabId },
                                            func: async (storeName, key) => {
                                                const cache = await caches.open(storeName);
                                                const response = await cache.match(key);

                                                if (!response) return null;

                                                return {
                                                    url: response.url,
                                                    body: await response.text()
                                                };
                                            },
                                            args: [storeName, key]
                                        },
                                        (results) => {
                                            if (results && results[0] && results[0].result) jsonString = results[0].result;
                                              Globals.LogMessage(jsonString);
                                            sendToNativeAppFromBackground(jsonString, true);
                                        }
                                    );
                                });
                            }
                            break;
                        case "indexedDb":
                            // Outside the if/else - single entry point
                            queryStorageTab(async (tabs) => {
                                if (!tabs || !tabs[0]) {
                                    console.error('No tab to run', request.message, 'on');
                                    logError({ type: 'storage-error', message: `failed: ${request.message}: no tab to run it on` });
                                    sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                    return;
                                }

                                const tabId = tabs[0].id;

                                // Convert undefined/null/empty to explicit null for clarity
                                const safeDbName = dbName ? String(dbName) : null;
                                const safeStoreName = storeName ? String(storeName) : null;
                                const safeKey = (key !== undefined && key !== null) ? key : null;

                                BROWSER.scripting.executeScript({
                                    target: { tabId },
                                    func: async (dbName, storeName, key) => {
                                        // Helper: Open database
                                        function openDb(name) {
                                            return new Promise((resolve, reject) => {
                                                const req = indexedDB.open(name);
                                                req.onsuccess = () => resolve(req.result);
                                                req.onerror = () => reject(req.error);
                                                req.onblocked = () => reject(new Error("Database blocked"));
                                            });
                                        }

                                        // Helper: Get all values from a store
                                        function getAllValues(db, storeName) {
                                            return new Promise((resolve, reject) => {
                                                const tx = db.transaction(storeName, "readonly");
                                                const store = tx.objectStore(storeName);
                                                const req = store.getAll();
                                                req.onsuccess = () => resolve(req.result);
                                                req.onerror = () => reject(req.error);
                                            });
                                        }

                                        // Helper: Get single value by key
                                        function getValue(db, storeName, key) {
                                            return new Promise((resolve, reject) => {
                                                const tx = db.transaction(storeName, "readonly");
                                                const store = tx.objectStore(storeName);
                                                const req = store.get(key);
                                                req.onsuccess = () => resolve(req.result ?? null);
                                                req.onerror = () => reject(req.error);
                                            });
                                        }

                                        try {
                                            // === CASE 1: No dbName > list all databases ===
                                            if (!dbName) {
                                                // Modern way (Chrome 119+)
                                                if (typeof indexedDB.databases === "function") {
                                                    const dbs = await indexedDB.databases();
                                                    return dbs.map(db => db.name);
                                                }
                                                // Fallback: We cannot reliably list all DB names without databases()
                                                // Return empty array or a helpful message
                                                return [];
                                            }

                                            // === CASE 2: dbName given, but no storeName > list object stores ===
                                            if (!storeName) {
                                                const db = await openDb(dbName);
                                                const storeNames = Array.from(db.objectStoreNames);
                                                db.close();
                                                return storeNames;
                                            }

                                            // === CASE 3+: Both dbName and storeName given ===
                                            const db = await openDb(dbName);

                                            if (!db.objectStoreNames.contains(storeName)) {
                                                db.close();
                                                return key ? null : [];   // null for single key, [] for getAll
                                            }

                                            if (key !== null) {
                                                // Get single value
                                                const value = await getValue(db, storeName, key);
                                                db.close();
                                                // the value alone, the same as a keyed local or session
                                                // storage read. the caller supplied the key and gains nothing
                                                // from being told it back
                                                return value;
                                            } else {
                                                // Get all values
                                                const values = await getAllValues(db, storeName);
                                                db.close();
                                                return values;
                                            }

                                        } catch (e) {
                                            console.error("IndexedDB error:", e);
                                            logError({ type: 'storage-error', message: `IndexedDB error: ${e}` });
                                            return { error: e.toString() };
                                        }
                                    },
                                    args: [safeDbName, safeStoreName, safeKey]   // Never undefined
                                }, (results) => {
                                    if (!results || !results[0]) {
                                        sendToNativeAppFromBackground({ error: "No result from injected script" }, true);
                                        return;
                                    }

                                    const jsonString = results[0].result;

                                    if (jsonString === null) {
                                        Globals.LogMessage("Key not found");
                                        sendToNativeAppFromBackground("null", true);           // or whatever format your native app expects
                                    } else {
                                        sendToNativeAppFromBackground(jsonString, true);
                                    }
                                });
                            });
                            break;
                    }
                }
                break;
            case REQUEST.SET_STORAGE:
                const tabs = await BROWSER.tabs.query({});
                const domain = request.data.domain;
                const key = request.data.key;
                const path = request.data.path;
                const data = request.data.data;
                const storeName = request.data.storeName;
                let jsonString = '';
                Globals.LogMessage(domain);
                Globals.LogMessage(key);
                Globals.LogMessage(path);
                switch (request.data.storageType) {
                    case "cookie": {
                        // the lookup get and delete already use. cookies.get needs a url that matches a
                        // host-only cookie's host exactly, so a cookie held on www.youtube.com was missed for
                        // youtube.com, and every path out of that miss answered nothing, which left the caller
                        // waiting on a reply that never came
                        const heldCookies = await BROWSER.cookies.getAll({ partitionKey: {} });
                        const existingCookie = heldCookies.find(cookie => {
                            if (!cookieDomainMatches(cookie.domain, domain)) return false;
                            if (path && cookie.path !== path) return false;
                            return cookie.name === key;
                        });

                        if (!existingCookie) {
                            // a set for a name that is not there creates it. the domain asked for says the
                            // scope: a leading dot is a domain cookie, a bare host is host only, and no domain
                            // at all takes the host of the tab the workflow is on
                            const askedDomain = (domain || '').trim().replace(/^https?:\/\//, '');
                            const activeTabs = await BROWSER.tabs.query({ active: true, lastFocusedWindow: true });
                            const tabHost = activeTabs[0]?.url ? new URL(activeTabs[0].url).hostname : '';
                            const newHost = askedDomain.replace(/^\./, '') || tabHost;

                            if (!newHost) {
                                console.error("Cookie not created, no domain asked for and no tab to take one from");
                                sendToNativeAppFromBackground('failed: no domain to create the cookie on', true);
                                break;
                            }

                            const newDetails = {
                                url: `https://${newHost}${path || '/'}`,
                                name: key,
                                value: data,
                                path: path || '/'
                            };

                            if (askedDomain.startsWith('.')) {
                                newDetails.domain = askedDomain;
                            }

                            BROWSER.cookies.set(newDetails, (created) => {
                                if (BROWSER.runtime.lastError) {
                                    console.error("Failed:", BROWSER.runtime.lastError);
                                    sendToNativeAppFromBackground(`failed: ${BROWSER.runtime.lastError.message}`, true);
                                    return;
                                }
                                Globals.LogMessage("Created cookie", newDetails.name);
                                sendToNativeAppFromBackground('OK', true);
                            });
                            break;
                        }

                        const details = {
                            url: `https://${existingCookie.domain.replace(/^\./, '')}${existingCookie.path}`,
                            name: existingCookie.name,
                            value: data,
                            path: existingCookie.path,
                            secure: existingCookie.secure,
                            httpOnly: existingCookie.httpOnly,
                            sameSite: existingCookie.sameSite,
                        };

                        // IMPORTANT: preserve domain vs host-only. naming a domain is what makes a cookie a
                        // domain cookie, so only one that already was one gets named
                        if (false === existingCookie.hostOnly) {
                            details.domain = existingCookie.domain;
                        }

                        // CRITICAL: preserve partitionKey if present
                        if (existingCookie.partitionKey) {
                            details.partitionKey = existingCookie.partitionKey;
                        }

                        BROWSER.cookies.set(details, (cookie) => {
                            if (BROWSER.runtime.lastError) {
                                console.error("Failed:", BROWSER.runtime.lastError);
                                sendToNativeAppFromBackground(`failed: ${BROWSER.runtime.lastError.message}`, true);
                                return;
                            }
                                Globals.LogMessage("Updated cookie");
                            sendToNativeAppFromBackground('OK', true);
                        });
                        break;
                    }
                    case "localStorage":
                        queryStorageTab((tabs) => {
                            if (!tabs || !tabs[0]) {
                                console.error('No tab to run', request.message, 'on');
                                logError({ type: 'storage-error', message: `failed: ${request.message}: no tab to run it on` });
                                sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                return;
                            }

                            const tabId = tabs[0].id;
                            BROWSER.scripting.executeScript(
                                {
                                    target: { tabId },
                                    func: (key, data) => {
                                        localStorage.setItem(key, data);
                                        return 'OK';
                                    },
                                    args: [key, data]
                                },
                                (results) => {
                                    if (results && results[0] && results[0].result)
                                        jsonString = results[0].result;

                                        Globals.LogMessage(jsonString);
                                    sendToNativeAppFromBackground(jsonString, true);
                                }
                            );
                        });
                        break;
                    case "sessionStorage":
                        queryStorageTab((tabs) => {
                            if (!tabs || !tabs[0]) {
                                console.error('No tab to run', request.message, 'on');
                                logError({ type: 'storage-error', message: `failed: ${request.message}: no tab to run it on` });
                                sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                return;
                            }

                            const tabId = tabs[0].id;

                            BROWSER.scripting.executeScript(
                                {
                                    target: { tabId },
                                    func: (key, data) => {
                                        sessionStorage.setItem(key, data);
                                        return 'OK';
                                    },
                                    args: [key, data]
                                },
                                (results) => {
                                    if (results && results[0] && results[0].result) jsonString = results[0].result;
                                        Globals.LogMessage(jsonString);
                                    sendToNativeAppFromBackground(jsonString, true);
                                }
                            );
                        });
                        break;
                    case "cache":
                        const contentType = "application/json";
                        queryStorageTab((tabs) => {
                            if (!tabs || !tabs[0]) {
                                console.error('No tab to run', request.message, 'on');
                                sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                return;
                            }

                            const tabId = tabs[0].id;

                            BROWSER.scripting.executeScript(
                                {
                                    target: { tabId },
                                    func: async (cacheName, key, rawData, contentType) => {
                                        try {
                                            // Ensure the key is a full URL
                                            const url = new URL(key, location.origin).toString();

                                            // Open the cache
                                            const cache = await caches.open(cacheName);

                                            // Create a response with the correct content type
                                            const response = new Response(rawData, {
                                                headers: { 'Content-Type': contentType }
                                            });

                                            // Put the entry into the cache
                                            await cache.put(url, response);

                                            return true;
                                        } catch (e) {
                                            console.error("Cache put failed:", e);
                                            return false;
                                        }
                                    },
                                    args: [storeName, key, data, contentType]
                                },
                                (results) => {
                                    // the page answers whether the entry went in. answering OK whatever it said
                                    // reported a cache that refused the put as a cache that took it, and the read
                                    // afterwards then came back with whatever the site itself had stored
                                    const cachePut = results && results[0] ? results[0].result : false;

                                        Globals.LogMessage(cachePut);

                                    sendToNativeAppFromBackground(true === cachePut ? 'OK' : 'failed: the cache did not take the entry', true);
                                }
                            );
                        });
                        break;
                    case "indexedDb":
                        queryStorageTab((tabs) => {
                            if (!tabs || !tabs[0]) {
                                console.error('No tab to run', request.message, 'on');
                                sendToNativeAppFromBackground(`failed: ${request.message}: no tab to run it on`);
                                return;
                            }

                            const tabId = tabs[0].id;

                            BROWSER.scripting.executeScript(
                                {
                                    target: { tabId },
                                    func: (dbName, storeName, inputKey, rawValue) => {
                                        new Promise((resolve) => {
                                            function fail(msg, err, db) {
                                                console.error(msg, err?.name || err || '');
                                                try { db?.close(); } catch { }
                                                resolve(false);
                                            }

                                            function parseValue(v) {
                                                try {
                                                    return JSON.parse(v);
                                                } catch {
                                                    return v; // keep as string
                                                }
                                            }

                                            function isValidKey(k) {
                                                // Valid IndexedDB keys: number, string, Date, Array
                                                if (k === undefined) return false;
                                                if (typeof k === 'string' || typeof k === 'number') return true;
                                                if (k instanceof Date) return true;
                                                if (Array.isArray(k)) return true;
                                                return false;
                                            }

                                            function ensureInlineKey(value, keyPath, key, autoIncrement) {

                                                if (keyPath === null) return { value, usedKey: key };

                                                if (typeof value !== 'object' || value === null) {
                                                    if (keyPath && key !== undefined) {
                                                        const wrapped = {};

                                                        if (typeof keyPath === 'string') {
                                                            wrapped[keyPath] = key;
                                                        } else if (Array.isArray(keyPath)) {
                                                            if (!Array.isArray(key)) {
                                                                {
                                                                    throw new Error('Compound key requires array key');
                                                                }
                                                            }
                                                            for (let i = 0; i < keyPath.length; i++) {
                                                                wrapped[keyPath[i]] = key[i];
                                                            }
                                                        }

                                                        wrapped.value = value;
                                                        return { value: wrapped, usedKey: undefined };
                                                    }

                                                    if (autoIncrement) {
                                                        return { value, usedKey: undefined };
                                                    }

                                                    throw new Error('Inline keyPath requires object value');
                                                }

                                                if (typeof keyPath === 'string') {
                                                    if (!(keyPath in value)) {
                                                        if (key !== undefined) {
                                                            value[keyPath] = key;
                                                        }
                                                        else if (!autoIncrement) {
                                                            throw new Error('Missing required inline keyPath property');
                                                        }
                                                    }

                                                } else if (Array.isArray(keyPath)) {
                                                    // Compound key
                                                    for (let i = 0; i < keyPath.length; i++) {
                                                        const kp = keyPath[i];
                                                        if (!(kp in value)) {
                                                            if (Array.isArray(key) && key[i] !== undefined) {
                                                                value[kp] = key[i];
                                                            } else if (!autoIncrement) {
                                                                throw new Error('Missing compound keyPath property: ' + kp);
                                                            }
                                                        }
                                                    }
                                                }

                                                return { value, usedKey: undefined };
                                            }

                                            const openReq = indexedDB.open(dbName);

                                            openReq.onerror = () => {
                                                fail('Failed to open database', openReq.error);
                                            };

                                            openReq.onsuccess = () => {
                                                const db = openReq.result;
                                                    Globals.LogMessage("DB name:", db.name);
                                                    Globals.LogMessage("Available stores:", db.objectStoreNames);
                                                    Globals.LogMessage("Current origin:", location.origin);
                                                let tx;
                                                try {
                                                    tx = db.transaction(storeName, 'readwrite');
                                                } catch (e) {
                                                    fail('Transaction creation failed', e, db);
                                                    return;
                                                }

                                                const store = tx.objectStore(storeName);

                                                let value = parseValue(rawValue);
                                                let key = inputKey;

                                                // Normalize empty string key  undefined
                                                if (key === '') key = undefined;

                                                // Validate key format if provided
                                                if (key !== undefined && !isValidKey(key)) {
                                                    fail('Invalid key type', key, db);
                                                    return;
                                                }

                                                let finalValue, finalKey;

                                                //try {
                                                const result = ensureInlineKey(
                                                    value,
                                                    store.keyPath,
                                                    key,
                                                    store.autoIncrement
                                                );
                                                    Globals.LogMessage(result);
                                                finalValue = result.value;
                                                finalKey = result.usedKey;
                                                //} catch (e) {
                                                //    fail('Key handling failed', e, db);
                                                //    return;
                                                //}

                                                let putReq;

                                                try {
                                                    if (store.keyPath === null) {
                                                        // OUT-OF-LINE
                                                        if (finalKey === undefined && !store.autoIncrement) {
                                                            fail('Missing key for out-of-line store', null, db);
                                                            return;
                                                        }
                                                        putReq = store.put(finalValue, finalKey);
                                                    } else {
                                                        // IN-LINE
                                                        putReq = store.put(finalValue);
                                                    }
                                                } catch (e) {
                                                    fail('Put setup error', e, db);
                                                    return;
                                                }

                                                putReq.onsuccess = () => {
                                                    try { { db.close(); } } catch { { } }
                                                    resolve(true);
                                                };

                                                putReq.onerror = (event) => {
                                                    fail('Put request error', event.target.error, db);
                                                };

                                                tx.onabort = (event) => {
                                                    fail('Transaction aborted', event.target.error, db);
                                                };
                                            };
                                        });
                                    },
                                    args: [path, storeName, key, data]
                                }
                            );
                        });
                        sendToNativeAppFromBackground('OK', true);
                        break;
                }
                break;
            case REQUEST.GET_USERAGENT:
                const agentString = navigator.userAgent;
                sendToNativeAppFromBackground(agentString);
                retval = false;
                break;
            case REQUEST.GET_LANGUAGES:
                // the list, most preferred first. the Accept-Language header is built from it on the GPAL side,
                // because the weighting a browser puts on the list is the browser's own and belongs in one place
                const languageList = navigator.languages.join(',');
                sendToNativeAppFromBackground(languageList);
                retval = false;
                break;
            case REQUEST.CAPTURE_CALLS:
                // webRequest watches from outside the page, so this records what the browser asks for rather
                // than only what page script issued, and nothing is injected for a site to notice
                if (false === request.data.capture)
                    CallRecorder.stop();
                else {
                    if (true === request.data.clear) CallRecorder.clear();

                    CallRecorder.start(request.data.filter);
                }

                sendToNativeAppFromBackground('OK');
                retval = false;
                break;
            case REQUEST.GET_CAPTURED_CALLS:
                // everything recorded so far, oldest first. the recorder keeps recording, so asking twice is
                // how a workflow watches a page rather than a way of ending the capture.
                // the object goes over as it is, not stringified: native messaging encodes what it is given,
                // so handing it a string would wrap the json in a json string and escape every quote in it
                sendToNativeAppFromBackground(CallRecorder.snapshot());
                retval = false;
                break;
            case REQUEST.GET_WINDOW_RECTANGLE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GOTO: {
                // New page coming -- drop any stale frame target so the first query
                // after navigating goes to the main frame, not a dead child frame.
                Globals.activeFrameId = 0;

                // a download named against the page being left is not the one arriving next
                disarmDownloadFilename("the caller navigated");

                // the page being left's status is not the new page's
                delete Globals.serverStatusCodes[activeTabId];
                let gotoAcked = false;
                let gotoTimer;

                // Ack only once the target tab's URL actually changes to the new
                // document. Acking right after issuing the navigation (as before)
                // races GPAL's follow-up ready-status check, which then reads the
                // still-current old page as 'complete' (seen on Firefox). A URL
                // change in tabs.onUpdated is the navigation-committed signal.
                function finishGoto(refused = false) {
                    if (gotoAcked) return;
                    gotoAcked = true;
                    clearTimeout(gotoTimer);
                    try { BROWSER.tabs.onUpdated.removeListener(onGotoUpdated); } catch (e) { void e; }
                    try { BROWSER.webNavigation.onCommitted.removeListener(onGotoCommitted); } catch (e) { void e; }
                    sendToNativeAppFromBackground(false === refused && activeTabId != null ? { tabId: activeTabId, url: request.data.url } : 'NOTOK', true);
                }

                function onGotoUpdated(tabId, changeInfo) {
                    if (tabId === activeTabId && changeInfo.url) {
                        finishGoto();
                    }
                }

                // A goto to the url the tab is already on loads the page again without changing the url, so
                // onUpdated never reports one. The new document committing in the tab's main frame is the same
                // signal for that case.
                function onGotoCommitted(details) {
                    if (details.tabId === activeTabId && 0 === details.frameId) {
                        finishGoto();
                    }
                }

                // Register before navigating so a fast commit isn't missed, but
                // guarded so a listener failure can never block the navigation.
                try { BROWSER.tabs.onUpdated.addListener(onGotoUpdated); } catch (e) { void e; }
                try { BROWSER.webNavigation.onCommitted.addListener(onGotoCommitted); } catch (e) { void e; }
                // Fallback: same-URL goto, blocked navigation, etc. may never fire
                // a URL change; ack anyway so the serial native pipe never stalls.
                gotoTimer = setTimeout(finishGoto, 8000);   // NOTE: hard coded value

                // tabs.update(activeTabId, ...) navigates the specific tab — the
                // reason GOTO moved off the old tabId-less tabs.update({url}) to
                // executeScript. The two-arg form keeps that targeting without the
                // page injection, which no-ops on the first call in Firefox.
                // A url the browser refuses here (Firefox refuses file: from an
                // extension) is answered NOTOK at once. The page cannot go there
                // either, and the timer would answer as though it had.
                try {
                    await BROWSER.tabs.update(activeTabId, {
                        url: ensureHttps(request.data.url)
                    });
                } catch (err) {
                    logError({ type: 'goto-error', message: `goto [${request.data.url}] refused by the browser: ${err}` });
                    finishGoto(true);
                }
                break;
            }
            case REQUEST.GOTO_TAB:
                // Switching tabs fires no navigation, so onCommitted won't reset the
                // frame target -- do it here; the new tab starts at its main frame.
                Globals.activeFrameId = 0;
                if (request.data.tabId) {
                    BROWSER.tabs.get(request.data.tabId, (tab) => {
                        BROWSER.tabs.update(tab.id, { active: true }, () => {
                            sendToNativeAppFromBackground({ tabId: tab.id, url: tab.url }, true);
                        });
                        return;
                    });
                } else if (request.data.url) {
                    // One answer only. GPALRestAPI takes every reply after the first as the answer to the next
                    // request. The first tab whose url starts with the one asked for, or failing that contains it,
                    // is made active and its window focused; 'NOTOK' only when no tab matches.
                    const wantedUrl = stripUrlPrefix(request.data.url);
                    BROWSER.tabs.query({}, (tabs) => {
                        const tab = tabs.find(t => t.url && stripUrlPrefix(t.url).startsWith(wantedUrl))
                                 ?? tabs.find(t => t.url && stripUrlPrefix(t.url).includes(wantedUrl));
                        if (!tab) {
                            sendToNativeAppFromBackground('NOTOK', true);
                            return;
                        }
                        BROWSER.tabs.update(tab.id, { active: true }, () => {
                            BROWSER.windows.update(tab.windowId, { focused: true }, () => {
                                sendToNativeAppFromBackground({ windowId: tab.windowId, tabId: tab.id, url: tab.url }, true);
                            });
                        });
                    });
                }
                break;
            case REQUEST.GOTO_WINDOW:
                // Switching windows/tabs -- reset the frame target to the main frame.
                Globals.activeFrameId = 0;
                if (request.data.windowId) {
                    BROWSER.windows.update(request.data.windowId, { focused: true }, (win) => {
                        sendToNativeAppFromBackground({ windowId: win.id, url: win.url }, true);
                        return;
                    });
                }
                else if (request.data.url) {
                    // One answer only, as for goto-tab: the window holding the first tab whose url contains the one
                    // asked for is focused; 'NOTOK' only when no tab matches.
                    const wantedUrl = stripUrlPrefix(request.data.url);
                    BROWSER.windows.getAll({ populate: true }, (windows) => {
                        let match = null;
                        for (const window of windows) {
                            const tab = (window.tabs || []).find(t => t.url && stripUrlPrefix(t.url).includes(wantedUrl));
                            if (tab) {
                                match = { window, tab };
                                break;
                            }
                        }
                        if (!match) {
                            sendToNativeApp('NOTOK', true);
                            return;
                        }
                        // the matching tab is made active too: the window alone keeps whatever tab it was showing,
                        // and every request after this acts on the active tab
                        BROWSER.tabs.update(match.tab.id, { active: true }, () => {
                            BROWSER.windows.update(match.window.id, { focused: true }, (win) => {
                                sendToNativeAppFromBackground({ windowId: win.id, url: match.tab.url }, true);
                            });
                        });
                    });
                }
                break;
            case REQUEST.HIDE_ELEMENT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.HOVER:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.INJECT_SCRIPT:
                try {
                    var injectedScriptId = Globals.injectedScriptPrefix + Globals.generateNonce(12);
                    await BROWSER.userScripts.register([{
                        id: injectedScriptId,
                        matches: ['<all_urls>'],
                        js: [{ code: request.data.script }],
                        world: 'MAIN',
                        runAt: 'document_start',
                        allFrames: true
                    }]);
                    Globals.injectedScriptIds.push(injectedScriptId);
                    sendToNativeAppFromBackground(injectedScriptId, true);
                } catch (err) {
                    sendToNativeAppFromBackground({ error: err.message }, true);
                }
                break;
            case REQUEST.CLEAR_INJECTED_SCRIPTS:
                // asked of the browser rather than remembered. a registration lives in the profile and outlasts
                // both the browser and this service worker, while injectedScriptIds is only what this worker
                // registered since it last started, so anything from an earlier run is invisible to it. sweeping
                // by our own id prefix takes those too, and cannot touch a script another extension registered
                try {
                    var registered = await BROWSER.userScripts.getScripts();
                    var ours = registered
                        .filter(function (script) { return 0 === script.id.indexOf(Globals.injectedScriptPrefix); })
                        .map(function (script) { return script.id; });

                    if (ours.length > 0)
                        await BROWSER.userScripts.unregister({ ids: ours });

                    Globals.injectedScriptIds = [];
                    sendToNativeAppFromBackground(String(ours.length), true);
                } catch (err) {
                    sendToNativeAppFromBackground({ error: err.message }, true);
                }
                break;
            case REQUEST.EXECUTE_JAVASCRIPT:
                // userScripts.register runs a script on every document from now on, which is INJECT_SCRIPT.
                // userScripts.execute runs one once, on the page that is open, which is this. MAIN world so the
                // script sees the page's own variables and functions, the way selenium and puppeteer do
                try {
                    const executed = await BROWSER.userScripts.execute({
                        target: { tabId: activeTabId },
                        js: [{ code: request.data.script }],
                        world: 'MAIN',
                        injectImmediately: true
                    });

                    // the top frame is the one the workflow asked about
                    const topFrame = executed && executed[0];

                    if (topFrame && topFrame.error)
                        sendToNativeAppFromBackground({ error: topFrame.error }, true);
                    else
                        sendToNativeAppFromBackground(topFrame ? topFrame.result : null, true);
                } catch (err) {
                    sendToNativeAppFromBackground({ error: err.message }, true);
                }
                break;
            case REQUEST.IS_CLICKABLE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.IS_DISPLAYED:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.IS_ENABLED:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.IS_END_OF_PAGE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.IS_VISIBLE_IN_VIEWPORT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.LEFT_CLICK:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.TRUSTED_LEFT_CLICK: {
                // Real (isTrusted) left click at page coordinates via CDP, optional
                // press-and-hold (holdMs). Chrome/Edge only -- performTrustedClick
                // returns false where the debugger is unavailable (Firefox), so we
                // answer NOTOK and never stall the serial pipe.
                const okLeft = await performTrustedClick(activeTabId, request.data.x, request.data.y, 'left', Number(request.data.holdMs) || 0);
                sendToNativeAppFromBackground(okLeft ? 'OK' : 'NOTOK', true);
                retval = false;
                break;
            }
            case REQUEST.TRUSTED_MIDDLE_CLICK: {
                // Real (isTrusted) middle click at page coordinates via CDP.
                const okMiddle = await performTrustedClick(activeTabId, request.data.x, request.data.y, 'middle', Number(request.data.holdMs) || 0);
                sendToNativeAppFromBackground(okMiddle ? 'OK' : 'NOTOK', true);
                retval = false;
                break;
            }
            case REQUEST.LEFT_DOUBLE_CLICK:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.MAXIMIZE:
                BROWSER.windows.getCurrent({}, function (window) {
                    BROWSER.windows.update(window.id, { state: "maximized" });
                    sendToNativeAppFromBackground('OK');
                });
                break;
            case REQUEST.MIDDLE_CLICK:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    // Content couldn't open the tab itself (no trusted input available)
                    // and gave us the link instead -- do it here, where tabs.create needs
                    // no user activation. Background tab, matching a real middle click.
                    if (response && response.openInNewTab) {
                        BROWSER.tabs.create({ url: response.openInNewTab, active: false }, (tab) => {
                            void BROWSER.runtime.lastError;
                            sendToNativeAppFromBackground(tab ? { tabId: tab.id, Url: tab.url || response.openInNewTab } : 'NOTOK', true);
                        });
                        return;
                    }
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.MINIMIZE:
                BROWSER.windows.getCurrent({}, function (window) {
                    BROWSER.windows.update(window.id, { state: "minimized" });
                    sendToNativeAppFromBackground('OK');
                });
                break;
            case REQUEST.MOVE_TO:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.NEW_TAB:
                if (!request.data) {
                    BROWSER.tabs.create({ url: "about:blank", active: false }, function (tab) {
                        sendToNativeAppFromBackground({ tabId: tab.id, Url: tab.url }, true);
                    });
                }
                else if (request.data.url) {
                    BROWSER.tabs.create({ url: ensureHttps(request.data.url), active: false }, function (tab) {
                        sendToNativeAppFromBackground({ tabId: tab.id, Url: tab.url }, true);
                    });
                }
                break;
            case REQUEST.TAB_COUNT:
                // how many tabs the browser actually has, which is not how many the caller opened. a tab whose
                // first navigation turns into a download closes itself, and this is how that is noticed
                BROWSER.tabs.query({}, function (tabs) {
                    sendToNativeAppFromBackground(tabs ? tabs.length : 0);
                });
                break;
            case REQUEST.NEXT_TAB:
                BROWSER.tabs.query({}, function (tabs) {
                    if (!tabs || tabs.length === 0) {
                        sendToNativeAppFromBackground("NOTOK", true);
                    } else {
                        const activeTab = tabs.find(tab => tab.active);
                        if (activeTab) {
                            const activeIndex = activeTab.index;
                            const nextIndex = (activeIndex + 1) % tabs.length;
                            const nextTab = tabs.find(tab => tab.index === nextIndex);
                            if (nextTab) {
                                BROWSER.tabs.update(nextTab.id, { active: true }, () => {
                                    sendToNativeAppFromBackground({ TabId: nextTab.id, Url: nextTab.url });
                                });
                            } else {
                                sendToNativeAppFromBackground("NOTOK");
                            }
                        }
                        else
                            sendToNativeAppFromBackground("NOTOK");
                    }
                });
                break;
            case REQUEST.NEXT_WINDOW:
                BROWSER.windows.getAll({}, (windows) => {
                    if (windows.length === 0) return;

                    BROWSER.windows.getCurrent((currentWindow) => {
                        // Sort windows by ID to have a consistent order
                        const sortedWindows = windows.sort((a, b) => a.id - b.id);
                        const currentIndex = sortedWindows.findIndex(w => w.id === currentWindow.id);

                        // Move to next window, wrapping around
                        const nextIndex = (currentIndex + 1) % sortedWindows.length;
                        const nextWindow = sortedWindows[nextIndex];

                        BROWSER.windows.update(nextWindow.id, { focused: true });
                        sendToNativeAppFromBackground(nextWindow.id);
                    });
                });
                break;
            case REQUEST.NORMAL:
                BROWSER.windows.getCurrent({}, function (window) {
                    BROWSER.windows.update(window.id, { state: "normal" });
                    sendToNativeAppFromBackground('OK');
                });
                break;
            case REQUEST.OPEN_WINDOW: //TEST: empty request ALSO TODO: Callback function return gives old window, not the newly created one
                var newURL = 'about:blank';
                if (request.data && request.data.url) {
                    newURL = ensureHttps(request.data.url);
                }
                BROWSER.windows.create({
                    url: newURL, // The URL to open in the new window
                    type: 'normal', // Specifies the window type (e.g., 'normal', 'popup')
                    width: 800, // Optional: width of the new window
                    height: 600, // Optional: height of the new window
                    left: 100, // Optional: horizontal position from the left edge of the screen
                    top: 100, // Optional: vertical position from the top edge of the screen
                    focused: true, // Optional: whether the new window should be focused
                    incognito: false // Optional: whether the new window should be an incognito window
                }, function (newWindow) {
                    // Callback function executed after the window is created
                    BROWSER.tabs.query({ active: true }, function (tabs) { //TODO: Window ID return is accurate, tab query is incorrect
                        if (tabs.length > 0) {
                            sendToNativeAppFromBackground({ windowId: newWindow.id, url: tabs[0].url });
                        }
                        else
                            sendToNativeAppFromBackground('NOTOK');
                    });
                });
                break;
            case REQUEST.SET_DOWNLOAD_FILENAME: {
                // USE LEFT-CLICK-DOWNLOAD
                // INTERCEPT downloads and name with the given name (headless usage really)
                // arms the click the caller makes next. LEFT_CLICK_DOWNLOAD does both in one go and is what GPAL
                // uses; this is for a caller driving the endpoints itself
                try {
                    armDownloadFilename(request.data.downloadPath);   // e.g., "GPALtemp/file123.pdf"
                }
                catch (err) {
                    Logging.log(LOG_TYPE.ERROR, err);
                }

                sendToNativeAppFromBackground("OK");
                break;
            }
            case REQUEST.LEFT_CLICK_DOWNLOAD: {
                // name the destination and click in one message, so there is no window between the two for
                // anything else to be named, and nothing left armed if the click never comes.
                // naming is the optional half. a click the caller asked for still goes when it fails, and the
                // file arrives under the browser's own name for gpal's watcher to rename
                try {
                    armDownloadFilename(request.data.downloadPath);
                }
                catch (err) {
                    Logging.log(LOG_TYPE.ERROR, err);
                }

                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: REQUEST.LEFT_CLICK,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            }
            case REQUEST.DOWNLOAD_URL: {
                // the browser downloads the url itself: no tab, and saveAs false never shows the dialog, whatever
                // the profile says about asking where to save. the filename option names the download in every
                // browser, relative to the download directory, so nothing is armed for onDeterminingFilename
                disarmDownloadFilename("download-url names its own download");

                const downloadName = downloadNameFor(request.data.downloadPath);
                const options = { url: request.data.url, saveAs: false, conflictAction: "overwrite" };

                if (downloadName)
                    options.filename = downloadName;

                BROWSER.downloads.download(options)
                    .then(downloadId => sendToNativeAppFromBackground({ downloadId }))
                    .catch(async err => {
                        await logError({ type: REQUEST.DOWNLOAD_URL, message: err?.message || String(err), stack: err?.stack });
                        sendToNativeAppFromBackground('NOTOK');
                    });
                break;
            }
            case REQUEST.SET_RANGE:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    rangeValue: request.data.rangeValue
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.GOOGLE_REFERRER:
                try {
                    await setOneNavigationReferrer("https://www.google.com/");
                    sendToNativeAppFromBackground('OK');
                } catch (err) {
                    await logError({ type: REQUEST.GOOGLE_REFERRER, message: err?.message || String(err), stack: err?.stack });
                    sendToNativeAppFromBackground('NOTOK');
                }
                retval = false;
                break;
            case REQUEST.OVERRIDE_REFERRER:
                try {
                    if (request.data.url) {
                        // GPAL sends this just before each GoTo, so the referrer goes with that navigation only
                        await setOneNavigationReferrer(ensureHttps(request.data.url));
                        sendToNativeAppFromBackground('OK');
                    }
                    else
                        sendToNativeAppFromBackground('NOTOK');
                } catch (err) {
                    await logError({ type: REQUEST.OVERRIDE_REFERRER, message: err?.message || String(err), stack: err?.stack });
                    sendToNativeAppFromBackground('NOTOK');
                }
                retval = false;
                break;
            case REQUEST.SET_USERAGENT:
                try {
                    setUserAgentRule(request.data.userAgent);
                    sendToNativeAppFromBackground('OK');
                } catch (err) {
                    await logError({ type: REQUEST.SET_USERAGENT, message: err?.message || String(err), stack: err?.stack });
                    sendToNativeAppFromBackground('NOTOK');
                }
                retval = false;
                break;
            case REQUEST.PAGE_DOWN:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.PAGE_END:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.PAGE_TOP:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.PAGE_UP:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.PRESS_MODIFIER_KEY:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    modifierKeys: request.data.modifierKeys
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.PREVIOUS_TAB:
                BROWSER.tabs.query({}, function (tabs) {
                    if (!tabs || tabs.length === 0) {
                        sendToNativeAppFromBackground("NOTOK");
                    } else {
                        const activeTab = tabs.find(tab => tab.active);
                        if (activeTab) {
                            const activeIndex = activeTab.index;
                            const nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;
                            const nextTab = tabs.find(tab => tab.index === nextIndex);
                            if (nextTab) {
                                BROWSER.tabs.update(nextTab.id, { active: true }, () => {
                                    sendToNativeAppFromBackground({ TabId: nextTab.id, Url: nextTab.url });
                                });
                            } else {
                                sendToNativeAppFromBackground("NOTOK");
                            }
                        }
                        else
                            sendToNativeAppFromBackground("NOTOK");
                    }
                });
                break;
            case REQUEST.PREVIOUS_WINDOW:
                BROWSER.windows.getAll({}, (windows) => {
                    if (windows.length === 0) return;

                    BROWSER.windows.getCurrent((currentWindow) => {
                        // Sort windows by ID to have a consistent order
                        const sortedWindows = windows.sort((a, b) => a.id - b.id);
                        const currentIndex = sortedWindows.findIndex(w => w.id === currentWindow.id);

                        // Move to previous window, wrapping around
                        const prevIndex = (currentIndex - 1 + sortedWindows.length) % sortedWindows.length;
                        const prevWindow = sortedWindows[prevIndex];

                        BROWSER.windows.update(prevWindow.id, { focused: true });
                        sendToNativeAppFromBackground(prevWindow.id);
                    });
                });
                break;
            case REQUEST.QUERY_PERSISTENT_SELECTOR:
                Messaging.sendQueryMessage(activeTabId, request.message, { css: request.data.css }, true, 0);
                break;
            case REQUEST.QUERY_SELECTOR:
                Messaging.sendQueryMessage(activeTabId, request.message, { css: request.data.css }, true, contentFrameId);
                break;
            case REQUEST.QUERY_PERSISTENT_SELECTORS:
                Messaging.sendQueryMessage(activeTabId, request.message, { css: request.data.css }, false, 0);
                break;
            case REQUEST.QUERY_SELECTORS:
                Messaging.sendQueryMessage(activeTabId, request.message, { css: request.data.css }, false, contentFrameId);
                break;
            case REQUEST.REFRESH:
                BROWSER.tabs.reload({ bypassCache: true });
                sendToNativeAppFromBackground('OK');
                retval = false;
                break;
            case REQUEST.RELEASE_MODIFIER_KEY:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    modifierKeys: request.data.modifierKeys
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.RESTORE:
                BROWSER.windows.getAll({ populate: true }, function (windows) {
                    for (let win of windows) {
                        if (win.state === "minimized") {
                            BROWSER.windows.update(win.id, { state: "normal" });
                        }
                    }
                    sendToNativeAppFromBackground('OK');
                });
                break;
            case REQUEST.RIGHT_CLICK:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SCROLL_INTO_VIEW:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                });
                sendToNativeApp('OK');
                break;
            case REQUEST.SCROLL_ELEMENT: //TEST: Might be null reference
                if (!request.data.hPixels) { request.data.hPixels = 0; }
                if (!request.data.vPixels) { request.data.vPixels = 0; }
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    hPixels: request.data.hPixels,
                    vPixels: request.data.vPixels
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SCROLL_WINDOW: //TEST: Might be null reference
                if (!request.data.hPixels) { request.data.hPixels = 0; }
                if (!request.data.vPixels) { request.data.vPixels = 0; }
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    hPixels: request.data.hPixels,
                    vPixels: request.data.vPixels
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SELECT_CLICK:
                if (request.data.selectIndex)
                    Messaging.messageATab(activeTabId, contentFrameId, {
                        message: request.message,
                        elementId: pickSelector(request.data),
                        selectIndex: request.data.selectIndex
                    }, (response) => {
                        sendToNativeApp(response);
                    });
                else if (request.data.selectValue)
                    Messaging.messageATab(activeTabId, contentFrameId, {
                        message: request.message,
                        elementId: pickSelector(request.data),
                        selectValue: request.data.selectValue
                    }, (response) => {
                        sendToNativeApp(response);
                    });
                break;
            case REQUEST.SEND_KEY:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data),
                    key: request.data.key,
                    code: request.data.code
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SEND_STRING:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    text: request.data.text,
                    typingDelay: request.data.typingDelay || 0
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.SWITCH_TO_DEFAULT_CONTENT:
                // Back to the main frame. Reset the target, and broadcast so every
                // frame drops its elementSearchRoot back to its own document (the one
                // remaining broadcast -- an unambiguous reset).
                Globals.activeFrameId = 0;
                Messaging.messageATab(activeTabId, null, {
                    message: request.message,
                });
                sendToNativeApp('OK');
                break;
            case REQUEST.SWITCH_TO_ELEMENT: {
                // The current active frame is the "parent/finder" -- it can locate the
                // <iframe> tag but can't descend into it (cross-origin walls off
                // contentDocument). So the content reports the iframe (src + index),
                // we resolve its child frameId here, and target that frame going
                // forward. A regular (non-iframe) element just narrows elementSearchRoot.
                const parentFrameId = contentFrameId ?? 0;
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, async (response) => {
                    if (response && response.iframe) {
                        const childId = await resolveChildFrameId(activeTabId, parentFrameId, response.iframe.src, response.iframe.index);
                        if (childId != null) {
                            Globals.activeFrameId = childId;
                            sendToNativeApp('OK', true);
                        } else {
                            sendToNativeApp('NOTOK', true);
                        }
                    } else {
                        sendToNativeApp(response);
                    }
                });
                break;
            }
            case REQUEST.SWITCH_TO_SHADOW_ROOT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                    elementId: pickSelector(request.data)
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.TOP_BROWSER:
                BROWSER.windows.update(windowId, { focused: true });
                sendToNativeAppFromBackground('OK');
                break;
            case REQUEST.WINDOW_INNER_HEIGHT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.WINDOW_INNER_WIDTH:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.WINDOW_OUTER_HEIGHT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.WINDOW_OUTER_WIDTH:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.WINDOW_PAGE_XOFFSET:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.WINDOW_PAGE_YOFFSET:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.WINDOW_SCREEN_LEFT:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
            case REQUEST.WINDOW_SCREEN_TOP:
                Messaging.messageATab(activeTabId, contentFrameId, {
                    message: request.message,
                }, (response) => {
                    sendToNativeApp(response);
                });
                break;
        }
        } catch (error) {
            console.error('Request failed:', request.message, error);

            if (false === requestAnswered) {
                sendToNativeAppFromBackground(`failed: ${request.message}: ${error?.message ?? error}`);
            }
        }
        return retval;
    }

    /**
     * Sends a message from the background script to other extension contexts,
     * such as the popup, using the browser runtime messaging API.
     *
     *
     * @static
     * @param {*} command - The message or payload to send to the extension.
     * @returns {void}
     */
    static sendToPopup(command) {
        try {
            BROWSER.runtime.sendMessage(command);
        } catch (err) {
            Globals.LogMessage(LOG_TYPE.ERROR, err);
        }
    }
    /**
     * Sends a query to a content script and forwards the response to the native
     * messaging host.
     *
     * @static
     * @param {number} tabId - The ID of the target browser tab.
     * @param {string} messageType - The type of query to send to the content script.
     * @param {Object} messageData - Additional data to include with the query.
     * @param {boolean} isSingleElement - If `true`, wraps the response in an array
     * before sending it to the native application.
     * @param {?number} [frameId=null] - The ID of the target frame within the tab.
     * If `null`, the message is sent according to the default behavior of
     * `messageATab()`.
     * @returns {void}
     */
    static sendQueryMessage(tabId, messageType, messageData, isSingleElement, frameId = null) {
        // a page that never loaded runs no content script, so there is nothing to ask and nothing will answer.
        // An empty list is the honest answer here and the one the caller already understands, rather than the
        // NOTOK a value returning request gets: this contract is a list of elements, and a string in its place
        // would only fail to deserialize. get-ready-status is what says why the page is not there
        if (Globals.navError) {
            sendToNativeApp([], true);
            return;
        }

        let responseHandled = false;
        setTimeout(() => {
            if (!responseHandled) {
                responseHandled = true;
                    Globals.LogMessage(`send query message returned timeout`);
                sendToNativeApp([], true);  // no response from any content in 5 seconds, nobody has it, send empty response
            }
        }, 15_000);

        Messaging.messageATab(tabId, frameId, {
            message: messageType,
            ...messageData
        }, (response) => {
            if (responseHandled) return;
            responseHandled = true;
            if (response) {
                var ourResponse = isSingleElement ? [response] : response;
                    Globals.LogMessage(`send query message returned ${ourResponse}`);
                sendToNativeApp(ourResponse);
            } else {
                // No live receiver in the frame (or an empty answer): the selector
                // isn't present, so return [] now instead of waiting out the timer.
                    Globals.LogMessage(`send query message: no result, returning []`);
                sendToNativeApp([], true);
            }
        });
    }

    /**
     * Sends a message from a content script or extension context to the background
     * script and optionally handles the asynchronous response.
     *
     *
     * @static
     * @param {*} message - The message payload to send to the background script.
     * @param {Function} [callback] - Optional callback invoked with the response
     * from the background script.
     * @returns {void}
     */
    static sendMessageToBackground(message, callback) {

        async function sendIt(objectMessage) {
            if (callback)
                return new Promise((resolve, reject) => {
                    BROWSER.runtime.sendMessage(
                        BROWSER.runtime.id,
                        objectMessage,
                        (response) => {
                            void BROWSER.runtime.lastError;
                          if (response || 0 === response)
                                resolve(response);
                            else
                                reject('because');
                        }
                    );
                }).catch(error => {
                    // Handle different types of errors that can occur when sending messages to tabs
                    Globals.LogMessage('sendMessageToBackground error', error.message);
                    logError({ type: 'background-error', message: `sendMessageToBackground error ${error.message}` });
                    void BROWSER.runtime.lastError;
                });
            else {
                try {
                    return BROWSER.runtime.sendMessage(BROWSER.runtime.id, objectMessage);
                } catch (error) {
                    Globals.LogMessage('sendMessageToBackground error', error.message);
                    logError({ type: 'background-error', message: `sendMessageToBackground error ${error.message}` });
                    void BROWSER.runtime.lastError;
                }
            }
        }

        async function doit() {
            try {
                var response = await sendIt(message);
                if (typeof callback === "function")
                    callback(response);
                else
                    return response;    // must have this return
            } catch (error) {
                try {   // try again
                    response = await sendIt(message);
                    if (typeof callback === "function")
                        callback(response);
                    else
                        return response;    // must have this return
                } catch (error) {
                    if ('because' !== error.reason) {
                        Globals.LogMessage(LOG_TYPE.DEBUG, 'Error Sending Message to BG', message, error);
                        logError({ type: 'messaging-error', message: `Error Sending Message to BG ${message} ${error}` });
                    }
                }
            }
        }
        return doit();
    }

    static getAsciiCharOrKeycode(which, key) {
        return (0x20 == which) // space
            || (0x30 <= which && which <= 0x5A) // ascii
            || (0x60 <= which && which <= 0x6f) // numpad
            || (0xBA <= which && which <= 0xC0) //punctuation
            || (0xDB <= which && which <= 0xDF) //punctuation
            ? key : which;
    }

    static isPrintable(keypressEvent) {
        return (0x20 == keypressEvent.which) // space
            || (0x30 <= keypressEvent.which && keypressEvent.which <= 0x5A) // ascii
            || (0x60 <= keypressEvent.which && keypressEvent.which <= 0x6f) // numpad
            || (0xBA <= keypressEvent.which && keypressEvent.which <= 0xC0) //punctuation
            || (0xDB <= keypressEvent.which && keypressEvent.which <= 0xDF) //punctuation
            ;
    }

    static messageATab(tabId, contentId, message, callback) {
        const options = {};

        // nothing in the page can be reached once a navigation has failed outright, because no content script was
        // ever injected into an error page. Answering NOTOK at once beats waiting out a timeout on a tab that is
        // never going to reply. Navigation, window and tab requests are handled in the background and so are
        // untouched by this, which is what leaves a workflow able to navigate somewhere else and carry on
        if (Globals.navError) {
            if (callback) callback('NOTOK');
            return;
        }

        try {
            if (null != contentId) {
                options.frameId = contentId;  // Target specific frame (e.g., 0 = main) - but nested frames still get the message... useless mostly
                message.frameId = contentId;
            }
        } catch (error) {
            // if we have a object, then we can set the contentid, if it's a string, it's a simple broadcast message not directed at a content
        }

            Globals.LogMessage(`messageatab message [${JSON.stringify(message)}] frame [${contentId}]`);

        async function messageTab(tabId, message) {
            let tab;
            try {
                void BROWSER.runtime.lastError;

                // Check if the tab is still open - but might have a stale content script not listening..
                //if (tabId)  // if we don't have a tabid, then we have no content listening, so don't dispatch
                    // trying to check to see if the tab open returns and doesn't resolve the promise
                //    tab = await BROWSER.tabs.get(tabId);

                //if (tab)
                {
                    return new Promise((resolve, reject) => {
                        if (null != contentId)
                            // Send the message to the tab
                            try {
                                BROWSER.tabs.sendMessage(
                                    tabId,
                                    message,
                                    options,
                                    (response) => {
                                        // Settle even when the frame has no live
                                        // listener (runtime.lastError set, response
                                        // undefined) so the caller gets an answer
                                        // instead of hanging the serial native pipe.
                                        // null means "no receiver / no answer".
                                        void BROWSER.runtime.lastError;
                                        resolve(response ?? null);
                                    });
                            } catch (error) {
                                if (false == (error || error.message).includes('No tab'))
                                    //LogMessage(LOG_TYPE.WARN, `Can't send ${message || message.message} to tab:${toastStrong(tabId)}`, toastStrong(error));
                                void BROWSER.runtime.lastError;
                            }
                        else
                            BROWSER.tabs.sendMessage(
                                tabId,
                                message,
                                (response) => {
                                    void BROWSER.runtime.lastError;
                                    if (response != null) {   // we can get a -1 frameid from popup
                                        resolve(response);
                                    }
                                    //else
                                    //    reject('because:' + response);
                                });
                    }).catch(error => {
                        void BROWSER.runtime.lastError;
                        // Handle different types of errors that can occur when sending messages to tabs
                        if (!error.message && 'because' === error.slice(0, 7)) {
                            Globals.LogMessage(`Message [${message.message}]<br>Got no response.`, error);
                            logError({ type: 'messaging-error', message: `Message [${message.message}]<br>Got no response. ${error}` });
                        }
                        else
                            switch (error.message) {
                                // If the message context or extension context is invalidated, log a warning message
                                case "Message context invalidated.":
                                case "Extension context invalidated.":
                                    Globals.LogMessage("Tab Messaging Error",
                                        "Ottomatic has been reloaded since the recording began, and tab ID " +
                                        tabId +
                                        " is now stale.");
                                    logError({
                                        type: 'messaging-error', message: `Ottomatic has been reloaded since the recording began, and tab ID " +
                                        tabId +
                                        " is now stale. ${error.message}` });
                                    break;

                                // If the receiving end of the message does not exist (i.e., the tab has closed), log a warning message
                                case "Could not establish connection. Receiving end does not exist.":
                                    Globals.LogMessage("Tab Messaging Error",
                                        "Tab ID " +
                                        tabId +
                                        " has closed since recording began."
                                    );
                                    break;
                                // Otherwise, re-throw the error
                                default:
                                case "The message port closed before a response was received.":
                                    Globals.LogMessage("Default: Tab Messaging Error", error.message);
                                    logError({ type: 'messaging-error', message: `Default: Tab Messaging Error ${error.message}` });
                            }
                    });
                }
            } catch (error) {
                if (BROWSER.runtime.lastError && false == BROWSER.runtime.lastError.includes('No tab')) {
                    Globals.LogMessage(`'Tab closed.'\nCan\'t send [${message.message ? message.message : message}]\nto tab ${tabId}`, error);
                    logError({ type: 'messaging-error', message: `Tab closed.'\nCan\'t send [${message.message ? message.message : message}]\nto tab ${tabId} ${error}` });
                }
            }
            void BROWSER.runtime.lastError;
        }
        async function sendTabMessage() {
            let x;


            // 2. Now send the message
            try {
                if (callback) {
                    x = await messageTab(tabId, message);
                } else {
                    await messageTab(tabId, message);
                }
            } catch (err) {
                Globals.LogMessage('send failed after ready', err);
                logError({ type: 'messaging-error', message: `send failed after ready ${err}` });
            }

            // 3. Call callback. Fire even when x is null/undefined (targeted send
            // to a frame with no live listener) so callers can apply a default
            // instead of hanging.
            if (typeof callback === "function") {
                callback(x ?? null);
            }
        }

        return sendTabMessage();
    }
    ///////////////////////
    // Background Message Handler- read from popup
    ///////////////////////

    /* Defines a function to listen/handle incoming messages from other content/tabs/popup */
    static handleMessageForBackground(message, sender, functionSendResponse) {
        let retval = false; // true = we will respond after some async call, keep port open/ false = we are handling call synchronously, close port
        try {
            Globals.currentContentID = sender.frameId;
        } catch { }

        try {
            Globals.currentTabID = sender.tab.id;  // on start up as service worker 'warms up', the first call does not have a defined .tab.id in background, known behavior
        } catch { }

        if (!message.message)
            switch (message) {
                case REQUEST.RELOAD_PERSISTENCE:
                    reloadPersistence();
                    break;
                case REQUEST.CLEAR_LOGS:
                    clearLogs().then(() => functionSendResponse(true));
                    retval = true;   // answered once the keys are gone
                    break;
                case REQUEST.GET_MY_TAB_ID:
                    functionSendResponse(Globals.currentTabID);
                    break;
                case REQUEST.GET_MY_FRAME_ID:
                    functionSendResponse(sender.frameId);
                    break;
                default:
                        Globals.LogMessage(`Forwarding message [${message}] to nativeapp`);
                    sendToNativeApp(message);
                    break;
            }
        else {
            switch (message.message) {
                case REQUEST.LOG_ERROR:
                    logError(message.payload);
                    break;
                case REQUEST.AUDIT_LOG:
                    logAuditTrail(
                        message.source,
                        message.target,
                        message.type
                    );
                    break;
                case REQUEST.CHECK_NETWORK_IDLE_RESPONSE:   // network idle response from each contant page
                    if (idleResponseTrackers.has(message.messageId)) {
                        const tracker = idleResponseTrackers.get(message.messageId);
                        const contentId = message.contentId;
                        if (!tracker.responseTracker.has(contentId)) {
                            tracker.responseTracker.set(contentId, message.isIdle);
                            tracker.numberOfResponses = (tracker.numberOfResponses || 0) + 1;
                            tracker.consensus = (tracker.consensus !== undefined ? tracker.consensus : true) && message.isIdle;
                                Globals.LogMessage(`Received idle response from content ${contentId}: isIdle=${message.isIdle}, Total: ${tracker.numberOfResponses}, messageId=${message.messageId}`);
                            functionSendResponse({ received: true }); // Acknowledge receipt
                        }
                    }
                    retval = true; // Async response
                    break;
                case REQUEST.TRUSTED_DRAG: {
                    // Content detected a native draggable and wants a trusted drag.
                    // Drive it via CDP from here; reply OK/NOTOK so content can fall
                    // back to the synthetic path when we can't (Firefox/no debugger).
                    const tabId = sender.tab?.id;
                    performTrustedDrag(tabId, message.startX, message.startY, message.endX, message.endY)
                        .then((ok) => functionSendResponse(ok ? 'OK' : 'NOTOK'))
                        .catch(() => functionSendResponse('NOTOK'));
                    retval = true;   // async response
                    break;
                }
            }
        }
        //if (functionSendResponse)
        //    functionSendResponse(responseVal);
        // Ignore any runtime errors
        void BROWSER.runtime.lastError;
        /* Return true to indicate that the response callback function will be called asynchronously */
        return retval;
    }

    ///////////////////////
    // Content Message Handler
    ///////////////////////
    /*
        The overall purpose of this code below is to listen for messages sent from other parts of the
        extension or from content scripts, using the BROWSER.runtime.onMessage API. It checks the
        type of message received and takes appropriate action based on the message type.

        - objectMessage: the message that was sent
        - objectSender: information about the sender of the message
        - functionSendResponse: a function that can be used to send a response back to the sender of the message

        *** Content scripts are used to modify the appearance and behavior of web pages, and to communicate with the background script of the extension.

        * To do: what are 'THINGS', give better description
        * while recording, when you click on an element a screen shot is taken
        * possibly asks all tabs for permission
        * 
    */

    static handleMessagesToContent(request, sender, sendResponse) {

        let retval = false;
        //if (undefined !== Globals.currentContentID && null !== request.frameId && undefined !== request.frameId && request.frameId !== Globals.currentContentID) {
        //    //console.log(`IGNORED: frame [${Globals.currentContentID}] request [${JSON.stringify(request)}]`);
        //    return;  // Ignore messages not meant for this frame
        //}

        //logAuditTrail("background.js", Globals.currentContentID, request);


        if (Globals.debug)
            console.log(`request [${JSON.stringify(request)}]`);

        switch (request.message) {
            case REQUEST.CHECK_NETWORK_IDLE_CONTENT:
                const idleState = window.networkIdleObserver
                    ? queryNetworkIdle(request.timeoutMs || 500, request.maxConnections ?? 0, request.pruneMs || 3000)
                    : (performance.now() - lastActivity > (request.timeoutMs || 500));
                    Globals.LogMessage(`Content ${Globals.currentContentID} responding: isIdle=${idleState}, messageId=${request.messageId}, contentId=${Globals.currentContentID}`);
                // Acknowledge original message
                sendResponse("OK");
                // Send response to runtime for accumulation
                BROWSER.runtime.sendMessage({
                    message: REQUEST.CHECK_NETWORK_IDLE_RESPONSE,
                    messageId: request.messageId,
                    contentId: Globals.currentContentID,
                    isIdle: idleState
                });
                retval = true;
                break;
            case REQUEST.EVALUATE_PERSISTENT:
            case REQUEST.EVALUATE:
                if (!canEvaluateXpath()) { sendResponse([]); break; }
                var xpathElement = getXpathElement(request.xpath);
                if (xpathElement != null) {
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning [1] elements`)
                    sendResponse(createGPALElementJson(xpathElement));
                }
                else if (REQUEST.QUERY_PERSISTENT_SELECTORS == request.message) {   // always contentid 0
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning NO elements`)
                    sendResponse([]);
                } else // we don't have it, leave the port open for other frames
                    sendResponse([])
                break;
            case REQUEST.EVALUATE_ALL_PERSISTENT:
            case REQUEST.EVALUATE_ALL: {
                if (!canEvaluateXpath()) { sendResponse([]); break; }
                const xpathElements = [];
                const xpathResult = getSearchDocument().evaluate(
                    request.xpath,
                    elementSearchRoot,
                    null,
                    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                    null
                );
                for (let i = 0; i < xpathResult.snapshotLength; i++) {
                    xpathElements.push(xpathResult.snapshotItem(i));
                }
                const overrideXPath = xpathElements.length === 1 ? request.xpath : null;
                const gpalElements = xpathElements.map(el => createGPALElementJson(el, null, overrideXPath));

                if (0 < gpalElements.length) {
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning [${gpalElements.length}] elements`)
                    sendResponse(gpalElements);
                }
                else if (REQUEST.EVALUATE_ALL_PERSISTENT == request.message) {   // always contentid 0
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning NO elements`)
                    sendResponse([]);
                } else // we don't have it, leave the port open for other frames
                    sendResponse([])
                break;
            }
            case REQUEST.GET_HYDRATION_SCRIPTS:
                if (0 == Globals.currentContentID) {
                    // the three things the hydration extractor wants, taken from the document rather than from
                    // its markup. script text is character data, so what goes back is the json exactly as the
                    // page wrote it, with no html escaping for the caller to undo and nothing to re-parse
                    const nextDataEl = document.querySelector("script#__NEXT_DATA__");
                    const heading = document.querySelector("h1");
                    const chunks = [];

                    document.querySelectorAll("script").forEach((oneScript) => {
                        if (oneScript.textContent && oneScript.textContent.indexOf("self.__next_f.push") >= 0)
                            chunks.push(oneScript.textContent.trim());
                    });

                    sendResponse({
                        title: document.title || (heading ? heading.textContent.trim() : null),
                        nextData: nextDataEl ? nextDataEl.textContent.trim() : null,
                        flightChunks: chunks
                    });
                }
                break;
            case REQUEST.GET_PAGE_SOURCE:
                if (0 == Globals.currentContentID) {
                    sendResponse(document.documentElement.outerHTML);
                }
                break;
            case REQUEST.GET_READY_STATUS:
                if (0 == Globals.currentContentID) {
                    sendResponse(document.readyState);
                }
                break;
            case REQUEST.GET_DOCUMENT_STAMP:
                if (0 == Globals.currentContentID)
                    sendResponse({ origin: performance.timeOrigin, url: location.href });
                break;
            case REQUEST.GET_WINDOW_RECTANGLE:
                if (0 == Globals.currentContentID)
                    // X and Y are the inner width and height, not a position. Every GPAL release reads this shape,
                    // so it stays as it is: a change would break every GPAL and OttoMagic pair of different versions
                    sendResponse({ X: window.innerWidth, Y: window.innerHeight, Width: window.outerWidth, Height: window.outerHeight });
                break;
            case REQUEST.IS_END_OF_PAGE:
                if (window.top !== window) {
                    return;
                }
                try {
                    const overflow = getComputedStyle(document.documentElement).overflow;
                    // The page's full height is documentElement's; body can be shorter. Scroll positions can be
                    // fractional, so the bottom counts within 1px, the same as GPAL's Selenium check.
                    if (overflow !== 'hidden') {
                        sendResponse((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 1);
                    } else {
                        const scrollable = Array.from(document.querySelectorAll('*')).find(
                            el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'hidden'
                        ) || document.documentElement;
                        sendResponse((scrollable.clientHeight + scrollable.scrollTop) >= scrollable.scrollHeight - 1);
                    }
                } catch {
                    sendResponse(false);
                }
                break;
            case REQUEST.PAGE_UP:
                scrollPage('up');
                sendResponse("OK");
                break;
            case REQUEST.PAGE_DOWN:
                scrollPage('down');
                sendResponse("OK");
                break;
            case REQUEST.PAGE_END:
                scrollToPosition('end');
                sendResponse("OK");
                break;
            case REQUEST.PAGE_TOP:
                scrollToPosition('top');
                sendResponse("OK");
                break;
            case REQUEST.PRESS_MODIFIER_KEY:
                pressModifierKey(request.modifierKeys);
                sendResponse("OK");
                break;
            case REQUEST.RELEASE_MODIFIER_KEY:
                releaseModifierKey(request.modifierKeys);
                sendResponse("OK");
                break;
            case REQUEST.QUERY_PERSISTENT_SELECTOR:
            case REQUEST.QUERY_SELECTOR:
                var cssElement = getCssElement(request.css);
                if (null != cssElement) {
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning [1] elements`)
                    const isUnique = elementSearchRoot.querySelectorAll(request.css).length === 1 && !(elementSearchRoot instanceof Element);
                    sendResponse(createGPALElementJson(cssElement, isUnique ? request.css : null));
                } else if (Globals.closedShadowHost) {
                    // Target lives inside a closed shadow root we can't pierce; the
                    // host is the only reachable object, so return it. GPAL clicks
                    // relative to the host's corner (offset) to reach the inner element.
                    sendResponse(createGPALElementJson(Globals.closedShadowHost));
                } else if (REQUEST.QUERY_PERSISTENT_SELECTOR === request.message) {   // always contentid 0
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning NO elements`)
                    sendResponse([]);
                } else // we don't have it, return empty set
                    sendResponse([]);
                break;
            case REQUEST.QUERY_PERSISTENT_SELECTORS:
            case REQUEST.QUERY_SELECTORS:
                const cssNodeList = elementSearchRoot.querySelectorAll(request.css);
                const cssElements = Array.from(cssNodeList).filter(el => el != null);
                // The asked-for css names the one match only from where it was asked. Searching inside an element
                // (switch-to-element), it names something else from the document, so the element's own css is used.
                const overrideCss = cssElements.length === 1 && !(elementSearchRoot instanceof Element) ? request.css : null;
                const gpalElements = cssElements.map(el => createGPALElementJson(el, overrideCss));

                if (0 < gpalElements.length) {
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning [${gpalElements.length}] elements`)
                    sendResponse(gpalElements);
                }
                else if (Globals.closedShadowHost) {
                    // Inside a closed shadow root we can't pierce -- return the host
                    // (the only reachable object) so GPAL clicks relative to its corner.
                    sendResponse([createGPALElementJson(Globals.closedShadowHost)]);
                }
                else if (REQUEST.QUERY_PERSISTENT_SELECTORS === request.message) {   // always contentid 0
                        Globals.LogMessage(`[${request.message}]: frame [${Globals.currentContentID}] returning NO elements`)
                    sendResponse([]);
                } else // we don't have it, leave the port open for other frames
                    sendResponse([])
                break;
            case REQUEST.SEND_KEY:
                // a shadow root keeps its own activeElement; document.activeElement only
                // reports its host, so the key would go to the wrong node
                const activeElement = getSearchRootNode().activeElement;

                // If nothing is focused or it's not editable/interactive, fallback to document
                const target = (activeElement && activeElement !== document.body)
                    ? activeElement
                    : document;

                const eventProps = {
                    key: request.key,
                    code: request.code,
                    bubbles: true,
                    cancelable: true,
                    ctrlKey: modifiersHeld.Control,
                    shiftKey: modifiersHeld.Shift,
                    altKey: modifiersHeld.Alt,
                    metaKey: modifiersHeld.Meta,
                    composed: true   // important for shadow DOM
                };

                let success = true;

                try {
                    // Most important order for real behavior
                    success = success && target.dispatchEvent(new KeyboardEvent('keydown', eventProps));

                    // keypress is deprecated but some old code still listens to it
                    if (request.key.length === 1) {   // only for printable characters
                        target.dispatchEvent(new KeyboardEvent('keypress', eventProps));
                    }

                    // if sending keys into an editable element, fire the input event
                    if (isElementEditable(target)) {
                        const inputEvent = new InputEvent('input', {
                            bubbles: true,
                            cancelable: true,
                            data: request.key,
                            inputType: 'insertText',
                            composed: true          // helps with Shadow DOM
                        });

                        target.dispatchEvent(inputEvent);
                    }

                    // keyup
                    target.dispatchEvent(new KeyboardEvent('keyup', eventProps));

                    // Special handling for <button> + Enter key (very common)
                    if (('submit' === target.type || target.tagName === 'BUTTON') && request.key === 'Enter') {
                        target.click();                    // or dispatch click event
                    }

                } catch (e) {
                    success = false;
                }

                sendResponse(success ? "OK" : "NOTOK");
                break;
            case REQUEST.SEND_STRING:
                var tempText = request.text;
                if (modifiersHeld.Shift) { tempText = toUpperCase(request.text); }
                var typingDelay = request.typingDelay || 0;
                if (0 < typingDelay) {
                    (async () => {
                        let first = true;
                        for (let char of request.text) {
                            if (!first) await new Promise(r => setTimeout(r, typingDelay));
                            document.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
                            document.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
                            document.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
                            first = false;
                        }
                        sendResponse("OK");
                    })();
                    retval = true; // keep message port open for the async sendResponse above
                } else {
                    for (let char of request.text) {
                        dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
                        dispatchResults = document.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
                        dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
                    }
                    sendResponse("OK");
                }
                break;
            case REQUEST.FETCH:
                // issued here, in the page, so it goes out on the tab's own connection carrying its cookies, its
                // TLS fingerprint and its header order. a relative url resolves against wherever the tab is.
                (async () => {
                    // firefox runs content scripts in their own compartment and refuses when an object crosses it,
                    // reporting the attempt rather than the line, so the caller cannot tell which step failed.
                    // This says which one, and costs nothing when nothing throws
                    var step = 'building the request';

                    try {
                        var target = new URL(request.url, location.href);
                        var headerPairs = request.headers || [];
                        var options = { method: request.method || 'GET', credentials: 'include', headers: {} };

                        // the rest client sends a flat name,value,name,value array. anything driving the endpoint
                        // by hand, the controller page included, can only send text, so take "Name: value" lines too
                        if ('string' === typeof headerPairs)
                            headerPairs = headerPairs.split(/[\r\n]+/).reduce(function (pairs, line) {
                                var at = line.indexOf(':');
                                if (0 < at) pairs.push(line.slice(0, at).trim(), line.slice(at + 1).trim());
                                return pairs;
                            }, []);

                        for (var h = 0; h < headerPairs.length; h += 2)
                            options.headers[headerPairs[h]] = headerPairs[h + 1];

                        if (request.body) {
                            options.body = request.body;
                            if (!options.headers['Content-Type'])
                                options.headers['Content-Type'] = request.contentType;
                        }

                        var asBytes = true === request.bytes || 'true' === request.bytes;

                        step = 'issuing the fetch';
                        var fetchResponse = await fetch(target.toString(), options);
                        var payload;

                        if (false === asBytes) {
                            step = 'reading the response as text';
                            payload = await fetchResponse.text();
                        }
                        else {
                            // text() would put a replacement character wherever a byte is not valid utf-8, which is
                            // most of any real file, so the body is read as a blob and base64 encoded.
                            // Deliberately not an arraybuffer: firefox runs content scripts in their own
                            // compartment, and building a typed array over a buffer that belongs to the page has
                            // to reach its constructor, which firefox refuses. A blob is handed to FileReader
                            // whole and never inspected, so nothing crosses. It also arrives base64 already, so
                            // there is no chunked walk to overflow the stack
                            step = 'reading the response as bytes';
                            var blob = await fetchResponse.blob();

                            step = 'base64 encoding';
                            payload = await new Promise(function (resolve, reject) {
                                var reader = new FileReader();
                                // a data url is "data:<mime>;base64,<payload>", and only the payload is wanted
                                reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
                                reader.onerror = function () { reject(reader.error); };
                                reader.readAsDataURL(blob);
                            });
                        }

                        step = 'answering';

                        // an object, not a stringified one. native messaging serializes whatever it is handed, so
                        // posting a string would arrive at the native app as a quoted, escaped json literal and
                        // need unwrapping twice, unlike the other engines
                        sendResponse({
                            status: fetchResponse.status,
                            body: payload,
                            encoding: asBytes ? 'base64' : null,
                            lastModified: fetchResponse.headers.get('Last-Modified')
                        });
                    } catch (e) {
                        // the port has to be answered or the caller waits forever. no body is how a fetch that
                        // could not be made reports itself, the same as the other engines returning null, and the
                        // reason rides along so the caller can say why rather than only that nothing came back
                        sendResponse({ status: 0, error: step + ': ' + ((e && e.message) ? e.message : String(e)) });
                    }
                })();
                retval = true; // keep message port open for the async sendResponse above
                break;
            case REQUEST.SCROLL_WINDOW:
                window.scrollBy(request.hPixels, request.vPixels, { behavior: "instant" });
                sendResponse("OK");
                break;
            case REQUEST.SWITCH_TO_DEFAULT_CONTENT:
                elementSearchRoot = document;
                Globals.closedShadowHost = null;   // leaving any closed-shadow context
                sendResponse("OK");
                break;
            case REQUEST.WINDOW_INNER_HEIGHT:
                sendResponse(window.innerHeight);
                break;
            case REQUEST.WINDOW_INNER_WIDTH:
                sendResponse(window.innerWidth);
                break;
            case REQUEST.WINDOW_OUTER_HEIGHT:
                sendResponse(window.outerHeight);
                break;
            case REQUEST.WINDOW_OUTER_WIDTH:
                sendResponse(window.outerWidth);
                break;
            case REQUEST.WINDOW_PAGE_XOFFSET:
                sendResponse(window.scrollX);
                break;
            case REQUEST.WINDOW_PAGE_YOFFSET:
                sendResponse(window.scrollY);
                break;
            case REQUEST.WINDOW_SCREEN_LEFT:
                sendResponse(window.screenLeft);
                break;
            case REQUEST.WINDOW_SCREEN_TOP:
                sendResponse(window.screenTop);
                break;
            default:
                var element = getElement(request.elementId);
                if (element) {
                    switch (request.message) {
                        case REQUEST.UPLOAD:    // NOTE: attach a file to the upload button, sends the real file stored in browser, could cause memory issues?
                            var fileName = request.fileName;
                            var mimeType = request.mimeType || "application/octet-stream";
                            var base64Data = request.base64Data;

                            fetch("data:" + mimeType + ";base64," + base64Data)
                                .then(res => res.blob())
                                .then(blob => {
                                    var file = new File([blob], fileName, { type: mimeType });

                                    var dt = new DataTransfer();

                                    // Preserve existing files if any
                                    for (var i = 0; i < element.files.length; i++) {
                                        dt.items.add(element.files[i]);
                                    }

                                    // Add the new one
                                    dt.items.add(file);

                                    element.files = dt.files;

                                    element.dispatchEvent(new Event("change", { bubbles: true }));
                                    element.dispatchEvent(new Event("input", { bubbles: true }));

                                    sendResponse("OK");
                                })
                                .catch(err => {
                                    console.error("Failed to create file from base64", err);
                                    sendResponse(err);
                                });
                            retval = true;
                            break;
                        case REQUEST.FIRE_CHANGE_EVENT:
                            if (typeof element.change === 'function') { element.change(); }
                            sendResponse("OK");
                            break;
                        case REQUEST.FILL_IN_APPEND:
                            if (request.text == null) { sendResponse('NOTOK'); break; }
                            var tmpText = element.value + request.text; //might not be value field
                            setElementText(tmpText, element).then(() => sendResponse("OK"));
                            retval = true;
                            break;
                        case REQUEST.FILL_IN_INSERT:
                            if (request.text == null) { sendResponse('NOTOK'); break; }
                            tmpText = request.text + element.value; //might not be value field
                            setElementText(tmpText, element).then(() => sendResponse("OK"));
                            retval = true;
                            break;
                        case REQUEST.FILL_IN_OVERWRITE:
                            // null would blank the field (value IDL maps it to ""), undefined
                            // would write "undefined". "" is a legitimate fill, so let it pass.
                            if (request.text == null) { sendResponse('NOTOK'); break; }
                            setElementText(request.text, element).then(() => sendResponse("OK"));
                            retval = true;
                            break;
                        case REQUEST.FOCUS:
                            forceFocus(element);
                            sendResponse("OK");
                            break;
                        case REQUEST.GET_ATTRIBUTE:
                            sendResponse(getElementValue(element, request.attribute));
                            break;
                        case REQUEST.SET_ATTRIBUTE:
                            element.setAttribute(request.attribute, request.value);
                            sendResponse("OK");
                            break;
                        case REQUEST.SET_VALUE_FROM_ELEMENT:
                            var destElement = getElement(request.destSelector);
                            if (destElement) {
                                setElementText(element.value, destElement).then(() => sendResponse("OK"));
                                retval = true;
                            } else {
                                sendResponse("NOT OK");
                            }
                            break;
                        case REQUEST.GET_ELEMENT_ATTRIBUTE_HASH:
                            let attrs = element.attributes;
                            let attrList = [];
                            for (let attr of attrs) {
                                attrList.push(attr.name + '=' + attr.value);
                            }
                            attrList.sort();    // Sort attributes for consistent hashing
                            let str = attrList.join('|');
                            let hash = 0;
                            for (let i = 0; i < str.length; i++) {
                                hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
                            }
                            sendResponse(hash.toString());
                            break;
                        case REQUEST.ELEMENT_FROM_POINT: {
                            // who would receive a click at this point, which is not the same question as where
                            // this element is. a point inside its box that something else covers is a click that
                            // never reaches it, and the box alone cannot say so.
                            // a descendant counts: clicking the text inside a button is clicking the button
                            const hit = getSearchRootNode().elementFromPoint(request.x, request.y);

                            sendResponse(hit === element || true == element.contains(hit) ? "true" : "false");
                            break;
                        }
                        case REQUEST.GET_BOUNDING_CLIENT_RECT: {
                            const bcr = element.getBoundingClientRect();
                            // A fully-collapsed rect (0x0 at 0,0) means this frame's
                            // match isn't rendered -- typically a hidden/detached
                            // decoy with the same id/selector as the real element in
                            // another frame or shadow root. Yield (leave the port open
                            // for other frames) so the frame with the actually-
                            // rendered element answers the broadcast, instead of this
                            // one shadowing it with all zeros.
                            if (bcr.width === 0 && bcr.height === 0 && bcr.top === 0 && bcr.left === 0) {
                                retval = true;
                            } else {
                                // toJSON gives the eight fields as a plain object. not encoded here: the
                                // background postMessages it to the native app, which encodes it once
                                sendResponse(bcr.toJSON());
                            }
                            break;
                        }
                        case REQUEST.GET_CONTENT_AND_CSS:
                            var div = element;
                            var allCss = getAllCss();
                            var elementCss = getElementCss(div);
                            const elementContent = div.outerHTML;
                            const cssContent = '<style>' + allCss + ' ' + elementCss + '</style>';
                            sendResponse("<html><head>" + cssContent + "</head><body>" + elementContent + "</body></html>");
                            break;
                        case REQUEST.GET_CSS_ATTRIBUTES:
                            // 1. Get the computed style object
                            const styles = window.getComputedStyle(element);
                            var props = {};

                            // 2. Values that are "noise" - we never want them in the result
                            const EMPTY_VALUES = new Set([
                                '', 'none', 'normal', 'inherit', 'initial', 'unset',
                                'auto', '0px', '0', 'transparent'
                            ]);

                            // 3. The only properties we ever care about
                            const RELEVANT = new Set([
                                'display', 'visibility', 'opacity', 'pointer-events', 'overflow', 'clip-path',
                                'position', 'top', 'left', 'right', 'bottom', 'z-index',
                                'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
                                'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
                                'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
                                'border', 'border-width', 'border-style', 'border-color', 'box-sizing',
                                'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
                                'justify-content', 'align-items', 'align-self', 'order',
                                'grid', 'grid-template', 'grid-area', 'grid-column', 'grid-row',
                                'transform', 'transform-origin', 'transition', 'animation',
                                'cursor', 'user-select', 'content', 'filter'
                            ]);

                            // 4. Iterate only the properties that exist on the style object
                            for (let i = 0; i < styles.length; i++) {
                                const prop = styles[i];                  // e.g. "display"
                                if (!RELEVANT.has(prop)) { continue; }   // skip everything else

                                const value = styles.getPropertyValue(prop).trim(); // "block", "0.5", etc.

                                // Skip empty / default values
                                if (!value || EMPTY_VALUES.has(value)) { continue; }

                                props[prop] = value;
                            }
                            sendResponse(props);
                            break;
                        case REQUEST.GET_DOM_ATTRIBUTES:
                            const attributes = element.attributes;
                            const domAttrs = {};
                            for (let i = 0; i < attributes.length; i++) {
                                const name = attributes[i].name;
                                const value = attributes[i].value;
                                if (name && value) {
                                    domAttrs[name] = value;
                                }
                            }
                            sendResponse(domAttrs);
                            break;
                        case REQUEST.GET_DOM_PROPERTIES:
                            var props = {};

                            if ("textContent" in element) props.textContent = element.textContent;
                            if ("innerHTML" in element) props.innerHTML = element.innerHTML;
                            if ("innerText" in element) props.innerText = element.innerText;
                            if ("outerHTML" in element) props.outerHTML = element.outerHTML;
                            if ("className" in element) props.className = element.className;
                            if ("disabled" in element) props.disabled = element.disabled;

                            sendResponse(props);
                            break;
                        case REQUEST.GET_PARENT_NODE:
                            sendResponse([createGPALElementJson(element.parentElement)]);
                            break;
                        case REQUEST.GET_SHADOW_ROOT:
                            sendResponse(createGPALElementJson(element.shadowRoot));
                            break;
                        case REQUEST.HIDE_ELEMENT:
                            element.style.display = 'none';
                            sendResponse("OK");
                            break;
                        case REQUEST.HOVER:
                            var evObj = new MouseEvent('mouseover', {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            });
                            dispatchResults = dispatchResults = element.dispatchEvent(evObj);
                            sendResponse("OK");
                            break;
                        case REQUEST.DRAG_AND_DROP:
                            dispatchResults = dispatchDragAndDrop(element, request.deltaX, request.deltaY, request.offsetX, request.offsetY).then(() => sendResponse('OK'));
                            retval = true;
                            break;
                        case REQUEST.IS_CLICKABLE:
                            const style = window.getComputedStyle(element);
                            const rect = element.getBoundingClientRect();

                            var isClickable =
                                style.visibility !== 'hidden' &&
                                style.display !== 'none' &&
                                style.pointerEvents !== 'none' &&
                                rect.width > 0 &&
                                rect.height > 0 &&
                                !element.disabled;

                            sendResponse(isClickable);
                            break;
                        case REQUEST.IS_DISPLAYED:
                            var isDisplayed = !!element && element.offsetParent !== null && (() => {
                                try {
                                    const style = window.getComputedStyle(element);
                                    const rect = element.getBoundingClientRect();
                                    return (
                                        style.visibility !== 'hidden' &&
                                        style.display !== 'none' &&
                                        rect.width > 0 &&
                                        rect.height > 0
                                    );
                                } catch (e) {
                                    return false; // Return false if any error occurs (e.g., detached element, browser quirk)
                                }
                            })();
                            sendResponse(isDisplayed);
                            break;
                        case REQUEST.IS_ENABLED:
                            var isEnabled = !!element && !element.disabled;
                            sendResponse(isEnabled);
                            break;
                        case REQUEST.IS_VISIBLE_IN_VIEWPORT:
                            const rect2 = element.getBoundingClientRect();
                            sendResponse(
                                rect2.top >= 0 &&
                                rect2.left >= 0 &&
                                rect2.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                                rect2.right <= (window.innerWidth || document.documentElement.clientWidth)
                            );
                            break;
                        case REQUEST.LEFT_CLICK:
                            (async () => {
                                await dispatchMouseEvent(element, 'click');
                                sendResponse('OK');
                            })();
                            retval = true;
                            break
                        case REQUEST.LEFT_DOUBLE_CLICK:
                            dispatchResults = dispatchMouseEvent(element, 'dblclick').then(() => sendResponse('OK'));
                            retval = true;
                            break;
                        case REQUEST.MIDDLE_CLICK:
                            (async () => {
                                // Opening a background tab is a browser default action,
                                // and Firefox only performs those for genuinely trusted
                                // input -- our synthetic events (isTrusted faked on the
                                // object, not in the browser) silently do nothing there.
                                // Hand the link's href back so the background can open
                                // the tab directly. Chrome/Edge honour the synthetic
                                // event, so they keep the normal path.
                                if (IS_FIREFOX) {
                                    const link = element.closest ? element.closest('a[href]') : null;
                                    if (link && link.href) {
                                        sendResponse({ openInNewTab: link.href });
                                        return;
                                    }
                                }
                                await dispatchMouseEvent(element, 'middleclick');
                                sendResponse('OK');
                            })();
                            retval = true;
                            break;
                        case REQUEST.RIGHT_CLICK:
                            dispatchResults = dispatchMouseEvent(element, 'contextmenu').then(() => sendResponse('OK'));
                            retval = true;
                            break;
                        case REQUEST.SELECT_CLICK:
                            // in gpal, clicking on an 'option' selector, under the covers results in determining the parent 'select' element of the option and setting the 'option' 'clicked'
                            if (request.selectIndex)
                                selectByIndex(element, request.selectIndex);
                            else if (request.selectValue)
                                selectByValue(element, request.selectValue);
                            else
                                sendResponse('NOTOK');
                            sendResponse('OK');
                            break;
                        case REQUEST.MOVE_TO:
                            element.scrollIntoView();
                            element.focus();
                            sendResponse("OK");
                            break;
                        case REQUEST.SCROLL_INTO_VIEW:
                            function scrollIntoViewIfNeeded(el) {
                                return new Promise(resolve => {
                                    const io = new IntersectionObserver(([entry]) => {
                                        io.disconnect();
                                        if (entry.intersectionRatio < 1) {
                                            el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
                                        }
                                        resolve();
                                    }, { threshold: 1 });
                                    io.observe(el);
                                });
                            }

                            scrollIntoViewIfNeeded(element);
                            break;
                        case REQUEST.SCROLL_ELEMENT:
                            element.scroll(request.hPixels, request.vPixels, { behavior: "instant" });
                            sendResponse("OK");
                            break;
                        case REQUEST.SET_RANGE:
                            element.value = request.rangeValue;
                            element.dispatchEvent(new Event('input', { bubbles: true }));
                            element.dispatchEvent(new Event('change', { bubbles: true }));
                            sendResponse("OK");
                            break;
                        case REQUEST.SWITCH_TO_ELEMENT:
                            if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') {
                                // Can't descend into an iframe from here (cross-origin
                                // blocks contentDocument). Report it so the background
                                // resolves the child frameId and targets that frame.
                                // index disambiguates duplicate/about:blank srcs.
                                const frames = Array.from(elementSearchRoot.querySelectorAll('iframe, frame'));
                                sendResponse({ iframe: { src: element.src || '', index: frames.indexOf(element) } });
                            } else {
                                elementSearchRoot = element;
                                Globals.closedShadowHost = null;
                                sendResponse("OK");
                            }
                            break;
                        case REQUEST.SWITCH_TO_SHADOW_ROOT:
                            if (element.shadowRoot) {
                                // Open shadow root -- search inside it as usual.
                                elementSearchRoot = element.shadowRoot;
                                Globals.closedShadowHost = null;
                            } else {
                                // Closed shadow root: shadowRoot is null and its
                                // contents are unreachable from page JS. The host is
                                // the only object we can find, so keep it as the search
                                // root and remember it -- a query inside then returns
                                // the host so GPAL can click relative to its corner.
                                // Still report OK per the OK/NOTOK switch contract.
                                elementSearchRoot = element;
                                Globals.closedShadowHost = element;
                            }
                            sendResponse("OK");
                            break;
                    }
                }
                else {
                    // Action endpoints answer the same either way, so log the miss
                    if (persistence?.settings?.debugMessages)
                        console.warn(`[${request.message}]: frame [${Globals.currentContentID}] found no element for [${request.elementId}]`);
                    sendResponse([]);
                }
        }

        // noisy, only add for debugging
            Messaging.sendMessageToBackground({
                message: REQUEST.AUDIT_LOG,
                source: `tabId [${Globals.currentTabID}] frameId [${Globals.currentContentID}]`,
                target: 'audit-log',
                type: `rcv'd ${request.message}`,
            });

        void BROWSER.runtime.lastError;
        return retval;
    }

    static isElementContainedInIframe(elementRect, iframeRect) {
        return (
            elementRect.left >= iframeRect.left &&
            elementRect.top >= iframeRect.top &&
            elementRect.width <= iframeRect.width &&
            elementRect.height <= iframeRect.height
        );
    }
}

/////////////////////////////
// _background script HELPERS
/////////////////////////////

function getActiveTabId() {
    return new Promise((resolve, reject) => {
        BROWSER.tabs.query({ active: true }, (tabs) => {
            if (tabs && tabs.length > 0) {
                resolve(tabs[0].id);
            } else {
                reject('No active tab found');
            }
        });
    });
}

/**
 * Resolves an <iframe> element (identified by its parent frame + src/index) to the
 * child content frame's frameId, so the background can target that frame directly.
 * Works cross-origin: webNavigation exposes every frame's url/parent to the
 * extension even when the page itself can't reach across the boundary.
 *
 * @param {number} tabId
 * @param {number} parentFrameId - the frame that contains the <iframe> (0 = main)
 * @param {string} src - the iframe's src
 * @param {number} index - the iframe's position among its siblings (tie-break)
 * @returns {Promise<number|null>} the child frameId, or null if unresolved
 */
function resolveChildFrameId(tabId, parentFrameId, src, index) {
    return new Promise((resolve) => {
        try {
            BROWSER.webNavigation.getAllFrames({ tabId }, (frames) => {
                void BROWSER.runtime.lastError;
                if (!frames || !frames.length) { resolve(null); return; }
                const children = frames.filter(f => f.parentFrameId === parentFrameId);
                // Prefer a url match (src can redirect, so try both directions);
                // fall back to DOM order for duplicate/about:blank srcs.
                let match =
                    (src && children.find(f => f.url === src)) ||
                    (src && children.find(f => f.url && (f.url.startsWith(src) || src.startsWith(f.url)))) ||
                    null;
                if (!match && Number.isInteger(index) && index >= 0 && index < children.length) {
                    match = children[index];
                }
                resolve(match ? match.frameId : null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

/**
 * Steps the tab's history via CDP, addressing the destination entry by id.
 *
 * The back/forward *buttons* -- and tabs.goBack/goForward, which are the same
 * traversal -- obey Chromium's history-manipulation intervention: entries whose
 * page never received real user input are skipped, and under automation that is
 * most of them. Going straight to the entry sidesteps the whole rule, and the
 * entry list hands us the destination URL before we move.
 *
 * @function navigateHistoryViaDebugger
 * @param {number} tabId
 * @param {string} direction - 'back' or 'forward'.
 * @returns {Promise<string|null|undefined>} the destination URL; null when there
 * is no entry that way; undefined when the debugger isn't usable (Firefox, or
 * already attached) so the caller falls back to tabs.goBack/goForward.
 */
async function navigateHistoryViaDebugger(tabId, direction) {
    if (tabId == null || !BROWSER.debugger) return undefined;

    try {
        await new Promise((res, rej) => {
            BROWSER.debugger.attach({ tabId }, "1.2", () => {
                if (BROWSER.runtime.lastError) rej(BROWSER.runtime.lastError); else res();
            });
        });
    } catch (e) {
        return undefined;   // already attached / not permitted -> caller falls back
    }

    try {
        const history = await sendDebuggerCommand(tabId, "Page.getNavigationHistory");
        const entries = history?.entries || [];
        const target = history.currentIndex + ('forward' === direction ? 1 : -1);
        if (target < 0 || target >= entries.length) { return null; }   // nothing that way

        await sendDebuggerCommand(tabId, "Page.navigateToHistoryEntry", { entryId: entries[target].id });
        return entries[target].url;
    } catch (e) {
        return undefined;   // couldn't drive it -> caller falls back
    } finally {
        // Detaching doesn't cancel a navigation already issued.
        await new Promise((res) => {
            BROWSER.debugger.detach({ tabId }, () => { void BROWSER.runtime.lastError; res(); });
        });
    }
}

/**
 * Drives a history navigation from the background and resolves with the URL the
 * tab actually landed on.
 *
 * This can't be done from content: history.back() destroys the document holding
 * the pending response, and popstate never fires for a cross-document traversal
 * anyway. The background survives the navigation and onCommitted does fire, so
 * the wait belongs here.
 *
 * @function navigateHistory
 * @param {number} tabId - the tab to navigate.
 * @param {string} direction - 'back' or 'forward'.
 * @param {number} [timeoutMs] - give up if nothing commits.
 * @returns {Promise<string|null>} The committed URL, or null if nothing committed.
 */
function navigateHistory(tabId, direction, timeoutMs = 5000) {
    return new Promise((resolve) => {
        let done = false;
        let timer = null;
        let plannedUrl = null;   // where CDP told us we were heading, before we got there

        // Scoped to this tab's main frame. The implementation this replaces used a
        // single global flag, so any unrelated navigation could emit the response.
        const onCommitted = (details) => {
            if (details.tabId !== tabId || details.frameId !== 0) { return; }
            finish(details.url);
        };

        const finish = (url) => {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            try { BROWSER.webNavigation.onCommitted.removeListener(onCommitted); } catch (e) { void e; }
            // If the commit never showed up but CDP had already accepted the
            // navigation, the entry's own URL is still the right answer.
            resolve(url ?? plannedUrl ?? null);
        };

        // Listen before navigating so a fast commit isn't missed.
        BROWSER.webNavigation.onCommitted.addListener(onCommitted);
        // Never leave the order-paired native pipe waiting on a nav that stalls.
        timer = setTimeout(() => finish(null), timeoutMs);

        (async () => {
            const target = await navigateHistoryViaDebugger(tabId, direction);

            if (target === null) { finish(null); return; }          // no entry that way
            if (target !== undefined) { plannedUrl = target; return; }   // moving; wait for the commit

            // No debugger available (Firefox) -- fall back to the buttons, which
            // do obey the skip rule but are all we have there.
            try {
                const go = 'forward' === direction ? BROWSER.tabs.goForward : BROWSER.tabs.goBack;
                go.call(BROWSER.tabs, tabId, () => {
                    // No entry that way -- settle now instead of waiting out the
                    // timeout for a navigation that is never going to happen.
                    if (BROWSER.runtime.lastError) { finish(null); }
                });
            } catch (e) {
                void e;
                finish(null);
            }
        })();
    });
}

function ensureHttps(url) {
    const trimmed = url.trim();
    const lower = trimmed.toLowerCase();

    // Already HTTPS - return unchanged
    if (lower.startsWith("https://")) {
        return trimmed;
    }

    // Explicit HTTP - honor it. Upgrading here used to manufacture certificate
    // interstitials on http-only sites (the cert is for some other host), and a
    // caller that typed the scheme has already made the choice.
    if (lower.startsWith("http://")) {
        return trimmed;
    }

    // Protocol-relative URL (//youtube.com)
    if (lower.startsWith("//")) {
        return "https:" + trimmed;
    }

    // Any other scheme the browser understands is the caller's choice, not a bare
    // domain waiting for one: file:, data:, blob:, view-source:, chrome:, moz-extension:.
    // Prefixing https to file:///C:/page.html produced https://file:///C:/page.html,
    // which the browser read as the host "file" and failed with ERR_NAME_NOT_RESOLVED.
    // A digit after the colon is a port on a bare host (localhost:8080), not a scheme.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) {
        return trimmed;
    }

    // Bare domain/path - add HTTPS (skip about:blank)
    if (trimmed !== "about:blank") {
        return "https://" + trimmed;
    }

    return trimmed;
}

function stripUrlPrefix(url) {
    return url
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '');
}
// Whether a cookie belongs to a domain: the name itself, or anything sitting under it. A cookie bound to one
// host records no leading dot and one that named a domain records a dot, so comparing the two strings for
// equality drops every host-only cookie, which is what a session cookie almost always is.
// the active tab of the last focused window, falling back through the windows that do not have focus and
// then any tab at all. headless firefox has no focused window, so that first query answers nothing and
// every storage handler that took tabs[0].id from it threw inside its own callback and answered nothing
function queryStorageTab(callback) {
    BROWSER.tabs.query({ active: true, lastFocusedWindow: true }, (focused) => {
        if (focused && focused.length) {
            callback(focused);
            return;
        }

        BROWSER.tabs.query({ active: true }, (active) => {
            if (active && active.length) {
                callback(active);
                return;
            }

            BROWSER.tabs.query({}, (all) => callback(all));
        });
    });
}

function cookieDomainMatches(cookieDomain, domain) {
    if (isNullEmptyOrWhitespace(domain) || isNullEmptyOrWhitespace(cookieDomain)) return true;

    const bare = value => value.trim().replace(/^https?:\/\//i, '').replace(/^\./, '').toLowerCase();
    const wanted = bare(domain);
    const held = bare(cookieDomain);

    return held === wanted || held.endsWith("." + wanted);
}
function sendToPopup(command) {
    try {
        BROWSER.runtime.sendMessage(command);
    } catch (err) {
        Globals.LogMessage(LOG_TYPE.ERROR, err);
    }
}
function isNullEmptyOrWhitespace(str) {
    return str === null || str === undefined || (typeof str === 'string' && str.trim().length === 0);
}
// the stealth referrer makes the first page the workflow goes to look like a click from a google search, and an
// override-referrer gives the next page the workflow goes to the referrer it asked for. the header
// goes on that page's own request only, not on its iframes or anything it loads, and comes off once that navigation
// commits. a session rule on chromium, so it never outlives the browser the way a dynamic rule would
const ONE_NAVIGATION_REFERRER_RULE = 2;
let oneNavigationReferrerListener = null;
let oneNavigationReferrerCommitted = null;

async function setOneNavigationReferrer(referrerUrl) {
    const isFirefox = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");

    await endOneNavigationReferrer();

    if (isFirefox) {
        oneNavigationReferrerListener = (details) => {
            const headers = details.requestHeaders.filter(h => h.name.toLowerCase() !== "referer");
            headers.push({ name: "Referer", value: referrerUrl });
            return { requestHeaders: headers };
        };
        BROWSER.webRequest.onBeforeSendHeaders.addListener(
            oneNavigationReferrerListener,
            { urls: ["<all_urls>"], types: ["main_frame"] },
            ["blocking", "requestHeaders"]
        );
    } else {
        await BROWSER.declarativeNetRequest.updateSessionRules({
            addRules: [{
                id: ONE_NAVIGATION_REFERRER_RULE,
                priority: 2,
                action: {
                    type: "modifyHeaders",
                    requestHeaders: [{ header: "Referer", operation: "set", value: referrerUrl }]
                },
                condition: { urlFilter: "*", resourceTypes: ["main_frame"] }
            }],
            removeRuleIds: [ONE_NAVIGATION_REFERRER_RULE]
        });
    }

    // the blank page the browser opens on commits too, so only a web page ends it. redirects come before the commit
    // and keep the header, as a real click's do
    oneNavigationReferrerCommitted = (details) => {
        if (0 === details.frameId && /^https?:/i.test(details.url))
            endOneNavigationReferrer();
    };
    BROWSER.webNavigation.onCommitted.addListener(oneNavigationReferrerCommitted);
}

async function endOneNavigationReferrer() {
    const isFirefox = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");

    if (oneNavigationReferrerCommitted) {
        try { BROWSER.webNavigation.onCommitted.removeListener(oneNavigationReferrerCommitted); } catch (e) { void e; }
        oneNavigationReferrerCommitted = null;
    }

    if (isFirefox) {
        if (oneNavigationReferrerListener) {
            try { BROWSER.webRequest.onBeforeSendHeaders.removeListener(oneNavigationReferrerListener); } catch (e) { void e; }
            oneNavigationReferrerListener = null;
        }
    } else {
        try { await BROWSER.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ONE_NAVIGATION_REFERRER_RULE] }); } catch (e) { void e; }
    }
}

// set the User-Agent header used by set-useragent
let activeUserAgentListener = null;

function setUserAgentRule(userAgent) {
    const isFirefox = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");

    // Remove any existing listeners/rules first
    if (isFirefox && activeUserAgentListener) {
        BROWSER.webRequest.onBeforeSendHeaders.removeListener(activeUserAgentListener);
        activeUserAgentListener = null;
    } else if (!isFirefox) {
        BROWSER.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [2] });
    }

    if (isNullEmptyOrWhitespace(userAgent)) {
        return;
    }

    if (isFirefox) {
        activeUserAgentListener = (details) => {
            let found = false;
            for (const header of details.requestHeaders) {
                if (header.name.toLowerCase() === "user-agent") {
                    header.value = userAgent;
                    found = true;
                    break;
                }
            }
            if (!found) {
                details.requestHeaders.push({ name: "User-Agent", value: userAgent });
            }
            return { requestHeaders: details.requestHeaders };
        };
        BROWSER.webRequest.onBeforeSendHeaders.addListener(
            activeUserAgentListener,
            { urls: ["<all_urls>"] },
            ["blocking", "requestHeaders"]
        );
    } else {
        BROWSER.declarativeNetRequest.updateDynamicRules({
            addRules: [{
                id: 2,
                priority: 1,
                action: {
                    type: "modifyHeaders",
                    requestHeaders: [{
                        header: "User-Agent",
                        operation: "set",
                        value: userAgent
                    }]
                },
                condition: {
                    urlFilter: "*",
                    resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
                }
            }],
            removeRuleIds: [2]
        });
    }
}
// check network idle - get consensus from the tab's contents
const idleResponseTrackers = new Map(); // Map<messageId, { resolve, timeoutId, consensus, numberOfResponses, responseTracker, responseSent }>

function checkTabIdleStatus(tabId, timeoutMs = 500, maxConnections = 0, pruneMs = 3000) {
    return new Promise((resolve) => {
        const messageId = `check-network-idle-content-${Date.now()}`;
        const tracker = {
            resolve: () => {
                if (!tracker.responseSent) {
                    tracker.responseSent = true;
                    clearTimeout(tracker.timeoutId);
                    idleResponseTrackers.delete(messageId);
                        Globals.LogMessage(`Consensus idle state: ${tracker.consensus}, Responses: ${tracker.numberOfResponses}, messageId=${messageId}`);
                    // resolve({ isIdle: tracker.consensus, responsesReceived: tracker.numberOfResponses });    // debug
                    for (const [id] of idleResponseTrackers) { // One-liner to clear all trackers for this tab
                        if (id.includes(`check-network-idle-content`) && idleResponseTrackers.get(id).tabId === tabId) idleResponseTrackers.delete(id);
                    }
                    resolve(tracker.consensus ? "idle" : "busy");
                }
            },
            // The page took the message and did not answer: its check failed or it is too busy to answer, so busy. A
            // page with no content script to take it (chrome://, the pdf viewer) fails the send instead, below, and
            // stays idle, since there is nothing there to wait on.
            timeoutId: setTimeout(() => {
                    Globals.LogMessage(`Idle check timeout: Received ${tracker.numberOfResponses} responses for messageId=${messageId}`);
                if (0 === tracker.numberOfResponses)
                    tracker.consensus = false;
                tracker.resolve();
            }, timeoutMs),
            consensus: true,
            numberOfResponses: 0,
            responseTracker: new Map(),
            responseSent: false
        };

        idleResponseTrackers.set(messageId, tracker);

        Messaging.messageATab(tabId, 0, {
            message: REQUEST.CHECK_NETWORK_IDLE_CONTENT,
            timeoutMs: timeoutMs,
            maxConnections: maxConnections,
            pruneMs: pruneMs,
            messageId: messageId
        }, () => {
            if (BROWSER.runtime.lastError) {
                // console.warn(`Error sending idle check to tab ${tabId}: ${BROWSER.runtime.lastError.message}`);
                if (!tracker.responseSent) {
                    tracker.resolve();
                }
            }
        });
    });
}

async function sendDebuggerCommand(tabId, method, params) {
    return new Promise((resolve, reject) => {
        BROWSER.debugger.sendCommand({ tabId }, method, params, (result) => {
            if (BROWSER.runtime.lastError) reject(BROWSER.runtime.lastError);
            else resolve(result);
        });
    });
}

/**
 * Performs a trusted native HTML5 drag-and-drop via the CDP debugger, the same way
 * Puppeteer's dragAndDrop works. Synthetic DOM DragEvents are isTrusted:false and
 * don't engage Chromium's DnD, and even trusted mouse press/move/release don't
 * reliably start a native drag. The reliable path is:
 *   1. Input.setInterceptDrags(true) -- the browser starts the drag but hands us
 *      its real DragData via the Input.dragIntercepted event instead of doing an
 *      OS drag.
 *   2. Press + move on the source to trigger that interception and capture data.
 *   3. Input.dispatchDragEvent dragEnter/dragOver/drop at the target with that data.
 *   4. Release.
 * Coordinates are main-frame viewport CSS pixels. Chrome/Edge only -- returns false
 * where BROWSER.debugger is unavailable (Firefox) so the caller falls back.
 *
 * @param {number} tabId
 * @param {number} x1 @param {number} y1 - grab point (viewport px)
 * @param {number} x2 @param {number} y2 - drop point (viewport px)
 * @returns {Promise<boolean>} true if the trusted drag completed
 */
/**
 * A real (isTrusted) mouse click at viewport coordinates via the CDP debugger --
 * the input path bot-detection can't distinguish from a human. Supports an optional
 * press-and-hold and left/middle/right buttons. Chrome/Edge only; returns false when
 * BROWSER.debugger is unavailable (Firefox) so the caller can fall back to synthetic.
 *
 * @param {number} tabId
 * @param {number} x @param {number} y - viewport CSS pixels
 * @param {'left'|'middle'|'right'} [button='left']
 * @param {number} [holdMs=0] - ms held between press and release
 * @returns {Promise<boolean>} true if the trusted click was dispatched
 */
async function performTrustedClick(tabId, x, y, button = 'left', holdMs = 0) {
    if (tabId == null || !BROWSER.debugger) return false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mask = button === 'middle' ? 4 : (button === 'right' ? 2 : 1);

    try {
        await new Promise((res, rej) => {
            BROWSER.debugger.attach({ tabId }, "1.2", () => {
                if (BROWSER.runtime.lastError) rej(BROWSER.runtime.lastError); else res();
            });
        });
    } catch (e) {
        return false;   // already attached / not permitted -> caller falls back
    }

    let ok = false;
    try {
        // Move the pointer to the target first -- CDP won't register the click as a
        // real interaction without it (Puppeteer does move -> down -> up).
        await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 0, x, y });
        await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button, buttons: mask, x, y, clickCount: 1 });
        if (holdMs > 0) await sleep(holdMs);
        await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button, buttons: 0, x, y, clickCount: 1 });
        ok = true;
    } catch (e) {
        ok = false;
    } finally {
        await new Promise((res) => {
            BROWSER.debugger.detach({ tabId }, () => { void BROWSER.runtime.lastError; res(); });
        });
    }
    return ok;
}

async function performTrustedDrag(tabId, x1, y1, x2, y2) {
    if (tabId == null || !BROWSER.debugger) return false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    try {
        await new Promise((resolve, reject) => {
            BROWSER.debugger.attach({ tabId }, "1.2", () => {
                if (BROWSER.runtime.lastError) reject(BROWSER.runtime.lastError);
                else resolve();
            });
        });
    } catch (e) {
        return false;   // already attached / not permitted -> let caller fall back
    }

    const mouse = (type, x, y, extra = {}) =>
        sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
    const dragEvent = (type, x, y, data) =>
        sendDebuggerCommand(tabId, "Input.dispatchDragEvent", { type, x, y, data });

    // The browser reports the real drag payload here once the drag is intercepted.
    let dragData = null;
    const onEvent = (source, method, params) => {
        if (source.tabId === tabId && method === "Input.dragIntercepted" && !dragData) {
            dragData = params.data;
        }
    };

    let ok = false;
    try {
        BROWSER.debugger.onEvent.addListener(onEvent);
        await sendDebuggerCommand(tabId, "Input.setInterceptDrags", { enabled: true });

        await mouse("mousePressed", x1, y1, { buttons: 1, clickCount: 1 });

        // Move all the way to the target with the button held (like Puppeteer).
        // The first move triggers Input.dragIntercepted (carrying DragData); we keep
        // moving so the drag pointer actually reaches the drop zone before we drop.
        const STEPS = 5;
        for (let i = 1; i <= STEPS; i++) {
            const x = x1 + (x2 - x1) * i / STEPS;
            const y = y1 + (y2 - y1) * i / STEPS;
            await mouse("mouseMoved", x, y, { buttons: 1 });
            await sleep(16);
        }
        // Wait for the intercept event if it hasn't landed yet.
        for (let i = 0; i < 30 && !dragData; i++) await sleep(16);
        if (!dragData) throw new Error("drag not intercepted");

        // Drive the HTML5 drag to the drop point with the captured data.
        await dragEvent("dragEnter", x2, y2, dragData);
        await dragEvent("dragOver", x2, y2, dragData);
        await sleep(80);
        await dragEvent("drop", x2, y2, dragData);
        await mouse("mouseReleased", x2, y2, { buttons: 0, clickCount: 1 });
        ok = true;
    } catch (e) {
        ok = false;
    } finally {
        try { BROWSER.debugger.onEvent.removeListener(onEvent); } catch (e) { void e; }
        try { await sendDebuggerCommand(tabId, "Input.setInterceptDrags", { enabled: false }); } catch (e) { void e; }
        await new Promise((resolve) => {
            BROWSER.debugger.detach({ tabId }, () => { void BROWSER.runtime.lastError; resolve(); });
        });
    }
    return ok;
}

function selectByValue(selectElement, value) {
    selectElement.value = value;
    selectElement.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectByIndex(selectElement, index) {
    if (index >= 0 && index < selectElement.options.length) {
        selectElement.selectedIndex = index;
        selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// fallback for setting the value of an input for things like react or other frameworks
// it's ok if this fails, it's the fallback...
function setElementText(text, element) {
    return new Promise(resolve => {

        try {

            // Typing order: keydown/keypress see the old value, keyup the new one.
            // Key is the last character filled, Backspace when clearing.
            const isClearing = !(typeof text === 'string' && 0 < text.length);
            const keyInit = { key: isClearing ? 'Backspace' : text.slice(-1), bubbles: true, cancelable: true };

            // Some fields only take the write once focused; also scrolls into view.
            if (element) { forceFocus(element); }

            element?.dispatchEvent(new KeyboardEvent('keydown', keyInit));
            if (!isClearing) { element?.dispatchEvent(new KeyboardEvent('keypress', keyInit)); }   // keypress skips non-printing keys

            let nativeSetter = null;

            if (element instanceof HTMLInputElement) {
                nativeSetter = Object.getOwnPropertyDescriptor(
                    HTMLInputElement.prototype,
                    'value'
                )?.set;
            }
            else if (element instanceof HTMLTextAreaElement) {
                nativeSetter = Object.getOwnPropertyDescriptor(
                    HTMLTextAreaElement.prototype,
                    'value'
                )?.set;
            }

            if (nativeSetter) {
                nativeSetter.call(element, text);
            }
            else if (element?.isContentEditable) {
                element.textContent = text;
            }
            else if (element) {
                element.value = text;
            }

            // Hidden tabs never paint, so a timer races the frame -- rAF alone would
            // never resolve and the caller answers the native app from this promise.
            let settled = false;
            const fireEvents = () => {
                if (settled) { return; }
                settled = true;

                try {
                    element?.dispatchEvent(new Event('input', { bubbles: true }));
                    element?.dispatchEvent(new Event('change', { bubbles: true }));
                    element?.dispatchEvent(new KeyboardEvent('keyup', keyInit));
                }
                catch { }

                resolve();
            };

            requestAnimationFrame(fireEvents);
            setTimeout(fireEvents, 50);
        }
        catch {
            resolve();
        }
    });
}

let workflowTimeout = null;
let workflowRunning = false;

function updateWorkflowState() {
    // Paint it once and leave it lit -- every later message only pushes the
    // inactivity timer out, rather than re-setting a badge that's already there.
    if (!workflowRunning) {
        workflowRunning = true;

        BROWSER.action.setBadgeBackgroundColor({
            color: [46, 125, 50, 255]
        });

        BROWSER.action.setBadgeText({
            text: "RUN"   // the badge fits 3 characters
        });
    }

    // Restart inactivity timer
    clearTimeout(workflowTimeout);

    //Block runs when "workflow timer" expires
    workflowTimeout = setTimeout(() => {

        workflowRunning = false;

        BROWSER.action.setBadgeBackgroundColor({
            color: [0, 0, 0, 0]
        });

        BROWSER.action.setBadgeText({
            text: ""
        });

    }, 15 * 1000);
}

function formatLogTimestamp() {
    const now = new Date();
    return (
        String(now.getMonth() + 1).padStart(2, '0') + '/' +
        String(now.getDate()).padStart(2, '0') + '/' +
        String(now.getFullYear()).slice(-2) + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0') + '.' +
        String(now.getMilliseconds()).padStart(3, '0')
    );
}

// Neither log ever keeps more than this many entries, whatever auditMaxEntries says, so storage and memory
// cannot grow without bound however long the extension runs.
const LOG_HARD_LIMIT = 999;

// The most entries at the end of the audit log one write can change: a repeat collapse rewrites up to two runs of
// AUDIT_MAX_CYCLE entries plus the counted row.
const LOG_TAIL_REWRITE = 9;

/* One log, kept as one storage key per entry ("audit.12" is the 12th entry ever written), so a write stores only
   what it changed, whatever the log's length. storage.local.set replaces a key whole, which is why the logs no
   longer live inside persistence: there, every entry re-saved the whole log and everything else with it, and
   each request got slower as the log grew. The background keeps the entries in memory for repeat suppression
   and trimming; only the background writes. */
class StoredLog {
    constructor(prefix) {
        this.prefix = prefix;      // "audit." or "error."
        this.entries = [];
        this.first = 0;            // the key number of entries[0]
        this.loaded = null;
    }

    // Reads what an earlier run of the background left, once, before the first write.
    load() {
        this.loaded ??= BROWSER.storage.local.get(null).then(all => {
            const numbers = Object.keys(all)
                .filter(key => key.startsWith(this.prefix))
                .map(key => Number(key.slice(this.prefix.length)))
                .sort((a, b) => a - b);

            this.first = numbers.length ? numbers[0] : 0;
            this.entries = numbers.map(n => all[this.prefix + n]);
        });
        return this.loaded;
    }

    // Stores the end of the log after the caller added to it or changed its last entries: drops the oldest past
    // the limit, rewrites the last LOG_TAIL_REWRITE entries, and removes keys past an end that got shorter.
    save(lengthBefore) {
        const keep = Math.min(persistence.settings.auditMaxEntries, LOG_HARD_LIMIT);
        const removeKeys = [];
        const setKeys = {};

        for (let i = this.entries.length; i < lengthBefore; i++)
            removeKeys.push(this.prefix + (this.first + i));

        if (this.entries.length > keep) {
            const drop = this.entries.length - keep;

            for (let i = 0; i < drop; i++)
                removeKeys.push(this.prefix + (this.first + i));
            this.entries.splice(0, drop);
            this.first += drop;
        }

        for (let i = Math.max(0, this.entries.length - LOG_TAIL_REWRITE); i < this.entries.length; i++)
            setKeys[this.prefix + (this.first + i)] = this.entries[i];

        if (removeKeys.length)
            BROWSER.storage.local.remove(removeKeys);
        BROWSER.storage.local.set(setKeys);
    }

    // Removes every key with this prefix in storage, which is what the popup shows, not only the ones in memory
    clear() {
        this.entries = [];
        this.first = 0;
        return BROWSER.storage.local.get(null).then(all =>
            BROWSER.storage.local.remove(Object.keys(all).filter(key => key.startsWith(this.prefix))));
    }
}

const auditLog = new StoredLog("audit.");
const errorLog = new StoredLog("error.");

// Empties both logs. The background owns them, so the popup asks for this with REQUEST.CLEAR_LOGS.
async function clearLogs() {
    await auditLog.load();
    await errorLog.load();
    auditCycle = null;
    await auditLog.clear();
    await errorLog.clear();
}

// Runs only in the background (content forwards errors via REQUEST.LOG_ERROR).
async function logError(err) {
    // lineno/colno are frequently 0 in service-worker and content error events;
    // recover the real position from the top stack frame when they're missing.
    const loc = parseStackLocation(err.stack);

    const entry = {
        ...err,
        file: err.file || loc.file,
        line: err.line || loc.line,
        column: err.column || loc.column,
        timestamp: formatLogTimestamp(),
    };

    // An error can come before persistence has loaded, or after loading it failed; the log's limit is a setting,
    // so it goes to the console then.
    if (!persistence) {
        console.warn('error before persistence loaded:', entry);
        return;
    }

    // A page or the popup has its own copy of the log and would number its entries over the background's. Pages
    // forward their errors with REQUEST.LOG_ERROR; what still lands here outside the background is a failure to
    // reach the background, so it goes to the console.
    if (true !== Globals.inBackground) {
        console.warn('error outside the background:', entry);
        return;
    }

    try {
        await errorLog.load();
        const lengthBefore = errorLog.entries.length;

        errorLog.entries.push(entry);
        errorLog.save(lengthBefore);
        Globals.LogMessage('error log:', entry);
    } catch (e) {
        console.warn('saving Error log failed:', e);
    }
}

// Repeat suppression for the audit log. A polled request and its reply are logged
// as separate entries (Messaging.js inbound, _background.js outbound), so the log
// repeats as a cycle -- 'get-ready-status', 'loading', 'get-ready-status', ... --
// and never as back-to-back duplicates. Comparing against the previous entry alone
// would therefore collapse nothing, so we look for a repeating run at the tail
// instead. One copy of the run is kept and the repeats become a single counted
// row; the count stops the moment any different entry is logged.
const AUDIT_MAX_CYCLE = 4;
const AUDIT_SUPPRESS_PREFIX = 'Suppressing repeat message';
let auditCycle = null;   // { keys, index, pending, count, label }

function auditKey(entry) {
    return `${entry.source} ${entry.target} ${entry.message}`;
}

function isAuditSuppressEntry(entry) {
    return typeof entry?.message === 'string' && entry.message.startsWith(AUDIT_SUPPRESS_PREFIX);
}

function auditSuppressText(cycle) {
    return `${AUDIT_SUPPRESS_PREFIX} [${cycle.label}] x${cycle.count}`;
}

// The log round-trips through storage between calls, so confirm the tail we
// collapsed is still there before counting against it (it won't be after a clear).
function auditCycleIntact(log) {
    const len = auditCycle.keys.length;
    if (log.length < len + 1) return false;
    if (!isAuditSuppressEntry(log[log.length - 1])) return false;
    for (let i = 0; i < len; i++) {
        if (auditKey(log[log.length - 1 - len + i]) !== auditCycle.keys[i]) return false;
    }
    return true;
}

// Looks for the tail of the log ending in two identical runs of 1..AUDIT_MAX_CYCLE
// entries. On a hit the newer run is dropped and replaced by a counted row.
function detectAuditCycle(log) {
    for (let len = 1; len <= AUDIT_MAX_CYCLE; len++) {
        if (log.length < len * 2) break;

        const newer = log.length - len;
        const older = log.length - len * 2;
        let same = true;
        for (let i = 0; i < len; i++) {
            if (isAuditSuppressEntry(log[older + i]) || auditKey(log[newer + i]) !== auditKey(log[older + i])) {
                same = false;
                break;
            }
        }
        if (!same) continue;

        const dropped = log.splice(newer, len);
        const cycle = {
            keys: log.slice(log.length - len).map(auditKey),
            index: 0,
            pending: [],
            count: 1,
            label: log[log.length - len].message,
        };
        log.push({
            timestamp: dropped[dropped.length - 1].timestamp,
            source: 'background.js',
            target: 'audit-log',
            message: auditSuppressText(cycle),
        });
        return cycle;
    }
    return null;
}

// Writes an audit entry. Only ever runs in the background: the native handler
// and the AUDIT_LOG message handler call it there, and content forwards via
// REQUEST.AUDIT_LOG.
async function logAuditTrail(source, target, message) {
    if (!persistence?.settings?.auditLog)
        return;
    if ('favicon.ico' == message)
        return;

    const entry = {
        timestamp: formatLogTimestamp(),
        source,
        target,
        message,
    };

    try {
        await auditLog.load();
        const log = auditLog.entries;
        const lengthBefore = log.length;

        if (auditCycle && !auditCycleIntact(log))
            auditCycle = null;

        if (auditCycle) {
            if (auditKey(entry) === auditCycle.keys[auditCycle.index]) {
                auditCycle.pending.push(entry);
                auditCycle.index++;
                if (auditCycle.index >= auditCycle.keys.length) {   // whole cycle seen again: count it, keep no entries
                    auditCycle.index = 0;
                    auditCycle.pending.length = 0;
                    auditCycle.count++;
                    const marker = log[log.length - 1];
                    marker.message = auditSuppressText(auditCycle);
                    marker.timestamp = entry.timestamp;
                    auditLog.save(lengthBefore);
                }
                return;
            }
            log.push(...auditCycle.pending);   // broke mid-cycle: those entries did happen, so keep them
            auditCycle = null;
        }

        log.push(entry);
        auditCycle = detectAuditCycle(log);
        auditLog.save(lengthBefore);
        Globals.LogMessage('audit log:', entry);
    } catch (err) {
        console.warn('Audit trail log failed:', err);
    }
}