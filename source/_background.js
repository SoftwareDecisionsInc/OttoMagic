const contentId = 'background'; //Math.random().toString(36).substring(2);

try {
    importScripts('Globals.js', './Settings.js', './Constants.js', './Persistence.js', './Messaging.js', './SelectorSet.js', './CallRecorder.js');
} catch (error) {
    Globals.LogMessage('Background error', error);
    logError({ type: 'startup-error', message: `Background error ${error}` });
    //console.error('Background error:', error);
}

var port;
// Set when we are deliberately taking the native app down ahead of an extension
// reload. The reload brings up a fresh one, so the disconnect that follows must
// not be treated as a failure to recover from.
var nativeAppShuttingDown = false;
var manifest = BROWSER.runtime.getManifest();
var extensionVersion = manifest.version;

let tcpServer;
const clients = [];

var alreadyInited = false;

/**
 * Extracts file, line, and column from the top frame of a V8 stack trace.
 * Service-worker `error`/`unhandledrejection` events usually report lineno/colno
 * as 0, but the stack string still carries the real location, e.g.:
 *   "    at fn (chrome-extension://<id>/source/file.js:123:45)"
 *
 * @param {string} [stack]
 * @returns {{file: (string|null), line: number, column: number}}
 */
function parseStackLocation(stack) {
    const empty = { file: null, line: 0, column: 0 };
    if (!stack) { return empty; }
    // First frame containing a :line:column suffix (with or without parens).
    const match = stack.match(/(?:\(|at\s+)?([^\s(]+):(\d+):(\d+)\)?/);
    if (!match) { return empty; }
    return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

/**
 * Initializes the extension's background service and registers all required
 * event listeners.
 *
 * Registered listeners include:
 * - Runtime startup and installation events
 * - Context menu creation and click handling
 * - Runtime suspension cleanup
 * - Background message handling
 * - Tab update monitoring
 * - Main-frame web request completion tracking
 *
 * @async
 * @function init
 * @returns {Promise<void>} A promise that resolves when one-time initialization
 * has completed and all event listeners have been registered.
 */
async function init() {
    // Listeners are registered here once per service-worker instance: init() runs
    // during the synchronous top-level evaluation (see bottom of file), which
    // re-runs on every wake. init() must NOT register itself on onStartup/
    // onInstalled — doing so re-ran init() within a single instance and attached
    // duplicate listeners (duplicate message handling / races).
    // Clear audit + error logs at the start of a new browser session when enabled.
    // onStartup fires once per browser launch, unlike init() which re-runs on every
    // service-worker wake, so the logs are cleared once per session rather than repeatedly.
    BROWSER.runtime.onStartup.addListener(clearLogsOnStartIfEnabled);
    // Create the context menu item
    BROWSER.runtime.onInstalled.addListener(async (details) => {
        BROWSER.contextMenus.create({
            id: "openWebsite",
            title: "GPAL Website",
            contexts: ["all"],
        });

        if (details.reason === "update") {
            await Persistence.migratePersistenceSchema();
        }
    });

    // Handle clicks on the context menu
    BROWSER.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === "openWebsite") {
            // Open a website in a new tab
            BROWSER.tabs.create({ url: "https://gpal.sditx.com/" });
        }
    });
    BROWSER.runtime.onSuspend.addListener(function () {
        sendToNativeApp('die');
    });

    // hook into our background messages from content scripts and potentially popup at some point
    BROWSER.runtime.onMessage.addListener(Messaging.handleMessageForBackground);

    if (false == alreadyInited) {
        alreadyInited = true;
        await reloadPersistence();
        
        nativeInit();
        // make the last operation status code available to GPAL via endpoint - get-status-code
        BROWSER.webRequest.onCompleted.addListener(
            (details) => {
                if (details.type === "main_frame") {
                    Globals.serverStatusCode = details.statusCode;
                    // A main-frame load completed -- the pending goto (if any) made
                    // it, so clear it: a later, unrelated nav error must not retry a
                    // stale target.
                    Globals.pendingGoto = null;
                    // and a page that loads is the end of whatever failed before it
                    Globals.navError = null;
                }
            },
            { urls: ["<all_urls>"] }
        );
        // Recover automation when a top-level navigation fails outright -- site
        // down, ERR_HTTP2_PROTOCOL_ERROR, DNS failure, connection refused, etc.
        // The page never loads, so no content script runs and GPAL would poll
        // get-ready-status forever with nothing driving it. Move the tab to a
        // known-good page so OttoMagic stays alive, and record why.
        BROWSER.webNavigation.onErrorOccurred.addListener(handleNavigationError);
        // A top-level navigation tears down every frame and mints new frameIds, so
        // the background's frame target from the old page is stale. Reset to the main
        // frame when the driven tab's main frame commits a new document -- otherwise
        // the first query after navigating targets a dead frame.
        BROWSER.webNavigation.onCommitted.addListener((details) => {
            if (details.frameId === 0 && (Globals.currentTabID == null || details.tabId === Globals.currentTabID)) {
                Globals.activeFrameId = 0;
            }
        });
        void BROWSER.runtime.lastError;
    }
}

/**
 * True when a navigation failure produced a *user-actionable interstitial*
 * rather than a dead page -- a certificate warning ("Accept the Risk and
 * Continue"), an HTTPS-Only mode block ("Continue to HTTP Site"), a Safe
 * Browsing block ("ignore the risk"), or an authentication prompt the operator
 * has yet to satisfy. These look like navigation errors to webNavigation, but
 * the page is alive and one click clears it, so recovering to Google destroys
 * the only way past them.
 *
 * The authentication case is the same shape: a site behind basic, digest or
 * proxy auth puts up a dialog, and cancelling it or getting the password wrong
 * is reported as ERR_INVALID_AUTH_CREDENTIALS. The operator signs in and
 * carries on, so steering the tab away is precisely the wrong move.
 *
 * Chrome names the error (net::ERR_CERT_*). Firefox usually reports a bare
 * nsresult, so match the security module range too: 0x805A0000-0x805AFFFF
 * covers every SEC_ERROR_* / SSL_ERROR_* / MOZILLA_PKIX_* code.
 *
 * @function isUserActionableInterstitial
 * @param {string} error - the raw webNavigation error string.
 * @returns {boolean}
 */
function isUserActionableInterstitial(error) {
    // Named forms (Chrome always; Firefox when it can resolve the nsresult).
    if (/ERR_CERT_|ERR_SSL_OBSOLETE|SEC_ERROR_|SSL_ERROR_|MOZILLA_PKIX_|HTTPS_ONLY|PHISHING_URI|MALWARE_URI|UNWANTED_URI|HARMFUL_URI|ERR_INVALID_AUTH_CREDENTIALS|ERR_PROXY_AUTH/i.test(error)) {
        return true;
    }

    // Firefox numeric form: "Error code 2153390067" (SEC_ERROR_UNKNOWN_ISSUER).
    const match = /-?\d{6,}/.exec(error);
    if (match) {
        let code = Number(match[0]);
        if (code < 0) code += 0x100000000;          // normalize a signed nsresult
        if (code >= 0x805A0000 && code <= 0x805AFFFF) return true;
    }

    return false;
}

/**
 * Detects a failed top-level navigation and steers the driven tab to a
 * known-good page so automation doesn't stall on a dead (content-script-less)
 * error page. Only acts while GPAL is connected and only on the active tab, so
 * it never hijacks the user's own browsing.
 *
 * @async
 * @function handleNavigationError
 * @param {object} details - webNavigation.onErrorOccurred details
 *   ({ tabId, url, frameId, error, ... }).
 * @returns {Promise<void>}
 */
async function handleNavigationError(details) {
    // Subframe/ad failures don't take down the page -- main frame only.
    if (details.frameId !== 0) return;

    // Only step in while GPAL is actually driving.
    if (port == null) return;

    // Aborted / superseded navigations are normal (a new navigation replaced this
    // one, a download, the user hitting stop), not page failures -- ignore them.
    // Chrome reports 'net::ERR_ABORTED' / 'NS_BINDING_ABORTED'; Firefox reports a
    // numeric nsresult with no name, so match those too:
    //   2152398850 = 0x804B0002 NS_BINDING_ABORTED   (superseded load)
    //   2152398851 = 0x804B0003 NS_BINDING_REDIRECTED (benign redirect)
    // Without this a normal startup abort bounces the tab to Google.
    const error = String(details.error || '');
    if (/abort/i.test(error) || error.includes('2152398850') || error.includes('2152398851')) return;

    const failedUrl = details.url || '';

    // Only report the tab automation is on, not some background tab erroring.
    try {
        const activeId = await getActiveTabId();
        if (details.tabId !== activeId) return;
    } catch (e) {
        void e;   // no active tab -- nothing to recover
        return;
    }

    const detail = `[${error}] ${failedUrl.slice(0, 200)}`;

    // Security interstitials are not the failure this guard exists for. The
    // guard protects against pages that never load and so never run a content
    // script; a cert / HTTPS-Only / Safe Browsing warning is a live page waiting
    // on a human. Leave it up so the operator can click through (or back out),
    // and just record it. Retrying would only re-show the same warning.
    if (isUserActionableInterstitial(error)) {
        await Persistence.reloadPersistence(true);
        logAuditTrail('background.js', `tabId [${details.tabId}]`, `nav-interstitial, awaiting user decision ${detail}`);
        await Persistence.savePersistence();
        return;
    }

    // The target is genuinely dead. Say so and leave the tab exactly where it
    // failed: steering it to a known-good page destroyed the evidence, and worse,
    // it was indistinguishable from a navigation that worked, so the caller
    // carried on running its next steps against whatever we had moved it to.
    // Recording it here is what lets get-ready-status answer, and what makes
    // every request that needs a live page answer NOTOK until a page loads.
    // Refresh persistence before logging: this handler runs out of band from the
    // serial native loop, so a stale/undefined copy would drop the entry.
    Globals.navError = detail;

    await Persistence.reloadPersistence(true);
    logError({ type: 'nav-error', message: `navigation failed, page not loaded ${detail}` });
    logAuditTrail('background.js', `tabId [${details.tabId}]`, `nav-error, page not loaded ${detail}`);
    await Persistence.savePersistence();
}

/**
 * Clears the audit and error logs when the "Clear Logs on Start" setting is
 * enabled. Invoked from runtime.onStartup so it runs once per new browser
 * session, leaving only the current session's history visible.
 *
 * @async
 * @function clearLogsOnStartIfEnabled
 * @returns {Promise<void>}
 */
async function clearLogsOnStartIfEnabled() {
    await reloadPersistence();
    if (persistence?.settings?.clearLogsOnStart) {
        persistence.auditLog = [];
        persistence.errorLog = [];
        await Persistence.savePersistence();
    }
}

/**
 * Establishes a connection to the native messaging host and registers
 * communication and error-handling listeners.
 *
 * @function nativeInit
 * @returns {void}
 */
function nativeInit() {
        if (port == null) {
            try {
                //Globals.LogMessage(
                //    LOG_TYPE.NOTICE,
                //    `OttoMagic v${extensionVersion} Starting native connection...`
                //);

                port = BROWSER.runtime.connectNative('gpal.rest.api.nativeapp');

                // Immediate check for connection failure (most common when app is not installed)
                if (!port) {
                    handleNativeConnectFailure();
                    return;
                }

                port.onMessage.addListener(Messaging.readFromNativeApp);
                port.onDisconnect.addListener(restartRestServer);

                self.addEventListener("error", (event) => {
                    logError({
                        type: "error",
                        message: event.message,
                        stack: event.error?.stack,
                        file: event.filename,
                        line: event.lineno,
                        column: event.colno,
                    });
                });

                self.addEventListener("unhandledrejection", (event) => {
                    logError({
                        type: "unhandledrejection",
                        message: event.reason?.message || String(event.reason),
                        stack: event.reason?.stack,
                    });
                });

            } catch (e) {
                Globals.LogMessage(
                    LOG_TYPE.WARN,
                    "Failed to start native connection."
                );
            }
        }
    }

/**
* Handles missing GPAL REST API when connecting to the native messaging host.
*
* @function handleNativeConnectFailure
* @returns {void}
*/
function handleNativeConnectFailure() {
        console.warn("Native app not found or failed to connect. Redirecting to website.");

        Globals.LogMessage(
            LOG_TYPE.WARN,
            "Native app not installed. Opening GPAL website..."
        );

        // Open the website in a new tab
        BROWSER.tabs.create({
            url: "https://gpal.sditx.com/gpal-rest-api"
        }).catch(err => {
            console.error("Failed to open tab:", err);
            // Fallback
            window.open("https://gpal.sditx.com/gpal-rest-api", "_blank");
        });
}

/**
* Handles unexpected native messaging disconnections by cleaning up the
* existing connection and attempting to reconnect.
*
* @function restartRestServer
* @returns {void}
*/
function restartRestServer() {

    // The port died with the process. Drop it now rather than let the popup keep showing a number that no longer
    // answers -- the replacement process pushes its own the moment it has a listener, and it may not be the same
    // one (StartRestServer walks upward past whatever is holding the old port).
    persistence.serverPort = null;
    Persistence.savePersistence();

    const err = BROWSER.runtime.lastError;
    // We asked the native app to die so we could reload. Its disconnect means the
    // process is actually gone -- reload now rather than reconnect. Doing it here
    // instead of on the 'die' ack guarantees the old app is out before the reload
    // brings up a new one.
    if (nativeAppShuttingDown) {
        BROWSER.runtime.reload();
        return;
    }

    

    const isHostMissing =
        err?.message === 'Specified native messaging host not found.';

    // Clean up old port safely (Firefox may already have it gone)
    try {
        port?.onMessage?.removeListener(Messaging.readFromNativeApp);
        port?.onDisconnect?.removeListener(restartRestServer);
    } catch (_) { }

    // Chrome-style explicit error (rare in Firefox)
    if (isHostMissing) {
        Globals.LogMessage(
            LOG_TYPE.WARN,
            `GPAL REST API Native App not installed!`
        );

        BROWSER.tabs.create({
            url: "https://gpal.sditx.com/",
            active: true
        });

        port = null;
        return;
    }

    // Firefox reality: disconnect usually = unknown failure
    try {
        port = BROWSER.runtime.connectNative('gpal.rest.api.nativeapp');

        port.onMessage.addListener(Messaging.readFromNativeApp);
        port.onDisconnect.addListener(restartRestServer);

    } catch (e) {
        // connectNative can still throw in some Firefox cases
        console.warn("Native reconnect failed:", e);

        Globals.LogMessage(
            LOG_TYPE.WARN,
            "Native app connection failed."
        );

        port = null;
        return;
    }

    // DO NOT rely on lastError in Firefox
}

/**
 * Sends a message to the connected native messaging host.
 *
 * @function sendToNativeApp
 * @param {*} command - The command or payload to send to the native messaging
 * host. The expected format depends on the native application's messaging
 * protocol.
 * @param isBackground - Is this from the background or the current tab/content (frame) = default = false
 * @returns {void}
 */
// set when a reply for the request being handled has gone out, so an unhandled throw answers with the
// reason instead of leaving the client to wait out its timeout, and never answers twice
var requestAnswered = false;

function sendToNativeApp(command, isBackground = false) {
    // the request being handled has now answered, so the catch-all in readFromNativeApp does not answer it
    // a second time. one request, one reply, whichever path got there first
    requestAnswered = true;

    // 'die' is a deliberate shutdown -- stop onDisconnect from respawning it.
    if ('die' === command) {
        nativeAppShuttingDown = true;
        reloadPersistence();
    }
    try {
        var who = true == isBackground ? 'background.js' : `tabId [${Globals.currentTabID}] frameId [${Globals.currentContentID}]`;
        // Log what actually goes to the client. Full payload to the console
        // (gated by debug mode); a concise summary into the audit CSV so it
        // sits in the same timeline as the inbound native-app / frame rows.
        Globals.LogMessage('sent to client:', command);
        if ('OK' !== command || ('OK' === command && persistence?.settings?.debugMessages)) {   // 'OK' is a ubiquitous ack, not worth logging except to debug
            logAuditTrail(who, 'native-app', summarizeSentToClient(command));
        }
        port.postMessage(command);
    } catch (err) {
        Globals.LogMessage(LOG_TYPE.ERROR, err);
    }
    void BROWSER.runtime.lastError;
}

function sendToNativeAppFromBackground(command) {
    sendToNativeApp(command, true);
}

/**
 * Produces a short, size-bounded description of a payload sent to the client,
 * suitable for the audit log. Distinguishes empty from populated responses
 * (the common "why did I get [] ?" question) without dumping huge element arrays.
 *
 * @param {*} command - The payload passed to sendToNativeApp.
 * @returns {string}
 */
function summarizeSentToClient(command) {
    try {
        if (command == null) return String(command);            // null / undefined
        if (typeof command === 'string') {
            // Short strings are control tokens ('OK', 'complete', 'die') or
            // small values -- log them as-is. Large ones are content responses;
            // the browser renders everything (even .txt/.xml/.json files) inside
            // an <html> wrapper, so classify by real content kind rather than
            // calling it all 'html', then summarize by kind + size.
            if (command.length <= 150) return command;
            return `${classifyContentString(command)} [${command.length} chars]`;
        }
        if (Array.isArray(command)) return command.length === 0 ? 'empty []' : `array [${command.length}]`;
        const s = JSON.stringify(command);
        return s.length <= 100 ? s : `object [${s.length} chars]`;
    } catch (e) {
        return '[unserializable payload]';
    }
}

/**
 * Classifies a large content payload as 'html', 'xml', 'json', or 'text'.
 *
 * The browser wraps everything it displays in an <html> document, so a plain
 * text / XML / JSON file rendered in a tab still arrives starting with <html>.
 * This mirrors GPAL's non-HTML detection (which keys off the URL extension) but
 * works from the payload alone by recognizing the browser's render wrappers.
 * Only a bounded prefix is inspected -- every marker sits at the top of the
 * document -- so the body is never scanned regardless of size.
 *
 * @param {string} str - The content string sent to the client.
 * @returns {string} One of 'html', 'xml', 'json', 'text'.
 */
function classifyContentString(str) {
    const head = str.slice(0, 1024).replace(/^[\s﻿]+/, '').toLowerCase();
    if (head === '') return 'text';

    // Raw data/markup whose document root is not <html>.
    if (head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed')
        || head.startsWith('<svg') || (head.startsWith('<!doctype') && !head.startsWith('<!doctype html')))
        return 'xml';
    if (head[0] === '{' || head[0] === '[') return 'json';

    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
        // Browsers wrap non-HTML files in an <html> shell -- detect the shells.
        if (head.includes('webkit-xml-viewer-source-xml')) return 'xml';   // Chrome XML viewer
        if (head.includes('plaintext.css')) return 'text';                 // Firefox plain text
        if (/<body[^>]*>\s*<pre[\s>]/.test(head)) return 'text';           // Chrome plain text (body>pre)
        return 'html';
    }
    if (head[0] === '<') return 'xml';   // some other markup root
    return 'text';                       // no markup at all
}

/////////////
// HELPERS
/////////////

//method to reload persistence object
// unable to use one in Persistence. it seems to hang
async function reloadPersistence() {
    async function reload() {
        let objectResult = await BROWSER.storage.local.get("persistence");
        /* checks if 'persistence' object exists */
        if (objectResult.persistence) {
            persistence = objectResult.persistence;
            /* checks if 'isRecording' property is true or false */
            //to do: isrecording should not be persistant, by setting it to false, should be implemented in background js
            //if (objectResult.persistence.isRecording) {
            //    /* sets the badge background color to red */
            //    BROWSER.action.setBadgeBackgroundColor({ color: [255, 0, 0, 255] });

            //    /* sets the badge text to 'REC' */
            //    BROWSER.action.setBadgeText({ text: "REC" });
            //} else
            {
                
                const action = BROWSER.action || BROWSER.browserAction;

                if (action?.setBadgeBackgroundColor) {
                    /* sets the badge background color to transparent */
                    action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] });
                    /* sets the badge text to an empty string */
                    action.setBadgeText({ text: "" });
                }
            }
        } else {
            persistence = new Persistence();
            persistence.savedByID = contentId;
            Persistence.savePersistence();
        }
    }

    async function pruit() {
        return await reload();
    }

    function doit2it() {
        return pruit();
    }

    return doit2it();
};

init();