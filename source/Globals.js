class Globals {
    static debug = false;
    static showContentStartMessage = true;
    static currentContentID;
    static currentTabID;
    static currentEvent;
    static currentContextMenuEvent;
    static lastChangeEvent;
    static tabOrEnterPressed;
    static keypressEvent;
    static responseTracker = {};
    static lastWorkflowStep;
    static ignoreNextGoto;
// count of modifiers pressed
    static modifierKeysPressed = 0;
    static ancestorActions;
    static currentUrl;
    static nonce;
    static simplifiedXPath;
    
    static dragAndDropInProgress = false;
    static draggedElement = null;
    static dragAndDropStartRecorded = false;
    static startX = 0;
    static startY = 0;
    static ignoreClickEvent = false;
    static contextMenu = {};
    static contextMenuOpen = false;
    static currentContextMenu = null;

    static selectedText = '';

    // what this run registered, and what everything we have ever registered is called. the ids are only good
    // while this service worker lives; the prefix is what finds registrations it never saw
    static injectedScriptIds = [];
    static injectedScriptPrefix = 'gpal-injected-';

    static serverStatusCode;

    // Why the last top-level navigation failed outright, or null when the page is fine. A page that never loads
    // runs no content script, so nothing can answer get-ready-status and the caller would poll a dead tab until it
    // gave up. This is how that caller is told instead, and it is cleared the moment a main frame loads.
    static navError = null;

    // Which frame the background is currently targeting. 0 = main frame. Set to a
    // child frameId by InIframe (switch-to-element on an <iframe>), reset to 0 by
    // InMainDom (switch-to-default-content). Element ops/queries always go to this
    // frame rather than broadcasting to all frames (the framework model, which kills
    // the multi-frame "which one answers first" race). The only remaining broadcast
    // is the switch-to-default-content reset, which passes frameId null explicitly.
    static activeFrameId = 0;

    // global object to record if a modifier key was pressed
    static modifierKeys = {
        Alt: false,
        Control: false,
        Shift: false,
        Meta: false,
    }

    static LogMessage(message, ...data) {
        if (!persistence?.settings?.debugMessages)
            return;

        const formattedData = data.map(item =>
            typeof item === 'string'
                ? item
                : JSON.stringify(item, null, 2)
        );

        console.log(message, ...formattedData);
    }

    static removeQuotesIfExist(inputString) {
        // Check if the input string has at least two characters and starts and ends with double quotes
        if (inputString)
            if (inputString.length >= 2
                && (
                    (inputString.startsWith('"') && inputString.endsWith('"'))
                    || (inputString.startsWith("'") && inputString.endsWith("'"))
                )) {
                // Remove the first and last character (i.e., the double quotes)
                return inputString.slice(1, -1);
            }

        // If there are no double quotes at the beginning and end, return the original string
        return inputString;
    }
    // don't think we want this...
    static removeCurlyBracesIfExist(inputString) {
        // Check if the input string has at least two characters and starts and ends with double quotes
        if (inputString)
            if (inputString.length >= 2 && (inputString.startsWith('{') && inputString.endsWith('}'))) {
                // Remove the first and last character (i.e., the double quotes)
                return inputString.slice(1, -1);
            }

        // If there are no double quotes at the beginning and end, return the original string
        return inputString;
    }
    static copyObjectClassToClipboard(objectToCopy, objectName, propertyName) {

        // Convert the object class to a string representation (JSON)
        var objClassString;
        var jsonString;
        if (!propertyName)
            jsonString = JSON.stringify(objectToCopy, null, 2);
        else
            jsonString = JSON.stringify(objectToCopy[propertyName], null, 2);
        
        objClassString = `${objectName ? 'var ' + objectName + ' = ' : ''}${objectName ? jsonString : this.removeQuotesIfExist(jsonString)}`;
        Messaging.sendMessageToBackground({ message: REQUEST.COPY_TO_CLIPBOARD, data: objClassString });
    }

    static async copyToClipboard(text) {
        try {
            if (true /*await checkClipboardPermissionSync()*/) {
                navigator.clipboard.writeText(text)
                    .then(() => {
                        Globals.LogMessage(LOG_TYPE.NOTICE, `Selector [${text.substring(2, 20)} ...]\nCopied to clipboard`);
                    })
                    .catch(err => {
                        const textarea = document.createElement('textarea');
                        textarea.value = text;
                        document.body.appendChild(textarea);

                        // Select the contents of the textarea
                        textarea.select();
                        // Copy the selected text to the clipboard
                        document.execCommand('copy');

                        // Remove the temporary textarea
                        document.body.removeChild(textarea);
                    });
            } else {
                Globals.LogMessage(LOG_TYPE.NOTICE, 'Clipboard access is not allowed on this page or has not been granted.');
            }
        } catch (error) {
            Globals.LogMessage(LOG_TYPE.NOTICE, `UNABLE to copy Selector [${text.substring(2, 20)} ...]\n[${error}]`);
            void BROWSER.runtime.lastError;
        }
    }

    // needs to run in background or somewhere else... 
    // throws an exception
    static async checkClipboardPermissionSync() {
        return new Promise((resolve, reject) => {
            BROWSER.permissions.getAll(permissions => {
                if (BROWSER.runtime.lastError) {
                    // Handle error
                    console.error('Error querying clipboard permissions:', BROWSER.runtime.lastError);
                    reject(BROWSER.runtime.lastError);
                } else {
                    // Check if the extension has the "clipboardRead" permission.
                    const hasClipboardReadPermission = permissions.permissions.includes("clipboardRead");

                    // Check if the extension has the "clipboardWrite" permission.
                    const hasClipboardWritePermission = permissions.permissions.includes("clipboardWrite");

                    resolve(hasClipboardReadPermission && hasClipboardWritePermission);
                }
            });
        });
    }

    static generateNonce(length) {
        var text = "";
        var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (var i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    // take our bse64 encoded audio string
    // convert it to a byte array, convert to a blob, then create a 'local' url to access the audio blob, akin to embedding it on the webpage
    // however, some CSP disallow any audio at all and this will still not play - 
    static beep() {
        let base64string = RECORDED_SOUND[persistence.settings.recordedSound].value.split(',')[1];

        // Decode the base64 string to a Uint8Array
        const binaryString = window.atob(base64string);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Create a Blob from the Uint8Array
        const blob = new Blob([bytes.buffer], { type: 'audio/wav' });

        // Create a Blob URL from the Blob
        const blobUrl = URL.createObjectURL(blob);

        // Create a new Audio element with the Blob URL
        const audio = new Audio(blobUrl);

        audio.addEventListener('error', () => {
            Globals.LogMessage(LOG_TYPE.NOTICE, 'Audio playback disallowed on website');
            // Handle the error and provide feedback to the user.
        });


        // Play the audio
        audio.play();
    }
}