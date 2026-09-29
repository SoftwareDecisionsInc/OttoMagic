// Records what the page asks for, so a workflow can read an endpoint off a site rather than guess at it.
//
// webRequest is the extension's answer to what Puppeteer gets over CDP. It sees every request the browser
// makes, not only the ones page script issued through fetch or XMLHttpRequest, it sees them across origins,
// and it sees them without touching the page: nothing is injected, so there is nothing for a site to notice.
//
// The listeners are registered once, at load, and do nothing until capture is turned on. Registering them
// on demand would not survive the service worker going to sleep, because a worker that wakes only replays
// what was registered at the top level.

const CallRecorder = (function () {

    // a busy page makes thousands of requests. keep the newest and count what fell off, so a workflow that
    // finds nothing can tell "the page never called it" from "it scrolled past"
    const MAX_CALLS = 2000;

    let capturing = false;
    let urlFilter = null;
    let calls = [];
    let byRequestId = new Map();
    let dropped = 0;

    function wanted(url) {
        return isNullEmptyOrWhitespace(urlFilter) || (!!url && url.indexOf(urlFilter) !== -1);
    }

    // the body as the page sent it. chrome hands it over raw, or already split into form fields when it
    // recognised the encoding
    function bodyOf(requestBody) {
        let retVal = null;

        if (!requestBody) return retVal;

        try {
            if (requestBody.raw && requestBody.raw.length && requestBody.raw[0].bytes) {
                retVal = new TextDecoder('utf-8').decode(new Uint8Array(requestBody.raw[0].bytes));
            }
            else if (requestBody.formData) {
                retVal = Object.keys(requestBody.formData)
                    .map(name => name + '=' + requestBody.formData[name].join(','))
                    .join('&');
            }
        } catch (err) {
            retVal = null;
        }

        return retVal;
    }

    function remember(details) {
        const call = {
            url: details.url,
            method: details.method,
            type: details.type,
            postData: bodyOf(details.requestBody),
            initiator: details.initiator || details.documentUrl || 'browser',
            status: 0,
            requestId: details.requestId,
            headers: {}
        };

        calls.push(call);
        byRequestId.set(details.requestId, call);

        while (calls.length > MAX_CALLS) {
            const oldest = calls.shift();

            byRequestId.delete(oldest.requestId);
            dropped++;
        }
    }

    BROWSER.webRequest.onBeforeRequest.addListener(
        (details) => {
            if (true === capturing && true === wanted(details.url)) remember(details);
        },
        { urls: ["<all_urls>"] },
        ["requestBody"]
    );

    // the headers the page actually sent, which is the part a request rebuilt by hand leaves out.
    // extraHeaders is Chrome's way of also reporting the ones it otherwise keeps back, and Firefox rejects
    // the whole call for not knowing the word, so it is asked for only where it exists
    const isFirefox = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");
    const headerSpec = isFirefox ? ["requestHeaders"] : ["requestHeaders", "extraHeaders"];

    BROWSER.webRequest.onSendHeaders.addListener(
        (details) => {
            if (false === capturing) return;

            const call = byRequestId.get(details.requestId);

            if (!call || !details.requestHeaders) return;

            details.requestHeaders.forEach(header => { call.headers[header.name] = header.value; });
        },
        { urls: ["<all_urls>"] },
        headerSpec
    );

    // what the site answered the page with, which is how a workflow tells an endpoint worth calling from one
    // the page is failing at too
    BROWSER.webRequest.onCompleted.addListener(
        (details) => {
            if (false === capturing) return;

            const call = byRequestId.get(details.requestId);

            if (call) call.status = details.statusCode;
        },
        { urls: ["<all_urls>"] }
    );

    BROWSER.webRequest.onErrorOccurred.addListener(
        (details) => {
            if (false === capturing) return;

            const call = byRequestId.get(details.requestId);

            if (call) call.error = details.error;
        },
        { urls: ["<all_urls>"] }
    );

    return {
        /**
         * Starts recording, optionally only the calls whose url holds the given fragment.
         * Starting again with a different filter keeps what was already recorded.
         *
         * @param {string} [filter] - Record only urls holding this
         */
        start: function (filter) {
            urlFilter = isNullEmptyOrWhitespace(filter) ? null : filter;
            capturing = true;
        },

        /** Stops recording. What was recorded stays until it is cleared. */
        stop: function () {
            capturing = false;
        },

        /** Forgets everything recorded so far. */
        clear: function () {
            calls = [];
            byRequestId = new Map();
            dropped = 0;
        },

        /**
         * Everything recorded so far, oldest first, as plain objects GPAL turns into GPALCall.
         *
         * @returns {{capturing: boolean, filter: string, dropped: number, calls: Array}}
         */
        snapshot: function () {
            return {
                capturing: capturing,
                filter: urlFilter,
                dropped: dropped,
                calls: calls.map(call => ({
                    url: call.url,
                    method: call.method,
                    type: call.type,
                    postData: call.postData,
                    initiator: call.initiator,
                    status: call.status,
                    headers: call.headers
                }))
            };
        }
    };
})();
