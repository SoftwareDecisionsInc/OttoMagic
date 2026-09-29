//////////////////////////
// _content script HELPERS
//////////////////////////

var elementSearchRoot = document;

var modifiersHeld = {
    Shift: false,
    Control: false,
    Alt: false
};

/**
 * Attempts to locate a DOM element using either a CSS selector or an XPath expression.
 *
 * This function first verifies that the search root (`elementSearchRoot`) exists.
 * It then tries to find an element using a CSS selector via `getCssElement()`.
 * If that fails, it falls back to an XPath lookup via `getXpathElement()`.
 *
 * The first successful match is returned; if no element is found, `null` is returned.
 *
 * @function getElement
 * @param {string} selector - A CSS selector or XPath expression used to locate the element.
 * @returns {Element|null} The found DOM element, or `null` if no match exists or the search root is unavailable.
 */
function getElement(selector) {
    if (getCssElement(selector) != null) { return getCssElement(selector); }
    if (getXpathElement(selector) != null) { return getXpathElement(selector); }
    // Inside a closed shadow root we can't pierce, the target is unreachable and the
    // host is the only object we can find -- resolve to it so element endpoints can
    // work relative to its corner instead of failing.
    if (Globals.closedShadowHost) { return Globals.closedShadowHost; }
    return null;
}
function getCssElement(selector) {
    try {
        const cssElement = elementSearchRoot.querySelector(selector);
        if (cssElement != null) {
            return cssElement;
        }
    } catch (e) { }
    return null;
}
// elementSearchRoot is a Document, a ShadowRoot or an Element (SwitchToElement).
// elementFromPoint and activeElement live on the first two, evaluate only on a Document.
function getSearchRootNode() {
    return elementSearchRoot instanceof Element ? elementSearchRoot.getRootNode() : elementSearchRoot;
}
function getSearchDocument() {
    return elementSearchRoot.ownerDocument ?? elementSearchRoot;   // Document.ownerDocument is null
}
// XPath cannot cross a shadow boundary, so an xpath asked for while switched into a
// shadow root matches nothing. Callers answer the empty set without running the query,
// which also keeps evaluate() from throwing on a DocumentFragment context node.
function canEvaluateXpath() {
    return !(elementSearchRoot instanceof ShadowRoot);
}
function getXpathElement(selector) {
    try {
        const xpathResult = getSearchDocument().evaluate(
            selector,
            elementSearchRoot,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        );
        const xpathElement = xpathResult.singleNodeValue;
        if (xpathElement != null) {
            return xpathElement;
        }
    } catch (e) { }
    return null;
}
/**
 * Programmatically dispatches a synthetic mouse/pointer interaction sequence
 * on a target DOM element.
 *
 * For more realistic behavior, the function:
 * - Computes randomized click coordinates within the element’s bounding box
 * - Selects the nearest clickable ancestor of the target element
 * - Dispatches full event sequences (pointerdown/up, mousedown/up, click, etc.)
 * - Optionally triggers focus, input, and change events where appropriate
 *
 * @async
 * @function dispatchMouseEvent
 * @param {Element} element - The DOM element to dispatch the event on.
 * @param {string} eventType - The type of interaction to simulate. Supported
 * values include: `"click"`, `"dblclick"`, `"contextmenu"`, and `"middleclick"`.
 * Any other value is treated as a direct event dispatch fallback.
 * @returns {Promise<boolean>} Resolves to `true` if the event sequence was
 * dispatched successfully, otherwise `false`.
 */
function dispatchMouseEvent(element, eventType) {
    return new Promise(resolve => {
        try {
            if (!element) return resolve(false);

            const clickable = getRealClickableAncestor(getClickableTextNode(element));
            const rect = clickable.getBoundingClientRect();
            const x = Math.round(rect.left + rect.width * (0.1 + Math.random() * 0.8));
            const y = Math.round(rect.top + rect.height * (0.1 + Math.random() * 0.8));

            const base = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x, clientY: y,
                screenX: x + window.screenX,
                screenY: y + window.screenY,
                pageX: x + window.scrollX,
                pageY: y + window.scrollY,
                pointerType: 'mouse',
                isPrimary: true,
                button: 0,
                buttons: 1,
                shiftKey: !!modifiersHeld.Shift,
                ctrlKey: !!modifiersHeld.Control,
                altKey: !!modifiersHeld.Alt,
                metaKey: false
            };

            const dispatch = (type, extra = {}) => {
                const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                const ev = new Ev(type, { ...base, ...extra });
                try { Object.defineProperty(ev, 'isTrusted', { get: () => true }); } catch (_) { }
                return clickable.dispatchEvent(ev);
            };

            // === SINGLE CLICK ===
            if (eventType === 'click') {
                dispatch('pointerdown');
                dispatch('mousedown');
                dispatch('pointerup');
                dispatch('mouseup');
                dispatch('click');
                if (clickable.focus) clickable.focus({ preventScroll: true });
                clickable.dispatchEvent(new Event('input', { bubbles: true }));
                clickable.dispatchEvent(new Event('change', { bubbles: true }));
                return resolve(true);
            }

            // === DOUBLE CLICK ===
            if (eventType === 'dblclick') {
                const doClick = () => {
                    dispatch('pointerdown');
                    dispatch('mousedown');
                    dispatch('pointerup');
                    dispatch('mouseup');
                    dispatch('click');
                };

                doClick();
                setTimeout(() => {
                    doClick();
                    dispatch('dblclick', { detail: 2 });
                    resolve(true);
                }, 100);
                return;
            }

            // === CONTEXT MENU ===
            if (eventType === 'contextmenu') {
                const rightBase = { ...base, button: 2, buttons: 2 };
                const d = (type) => dispatch(type, rightBase);

                d('pointerdown');
                d('mousedown');
                setTimeout(() => {
                    d('pointerup');
                    d('mouseup');
                    d('contextmenu');
                    resolve(true);
                }, 100);
                return;
            }


            // === MIDDLE CLICK (eBay pop-under via trusted overlay) ===
            if (eventType === 'middleclick') {
                const middle = { ...base, button: 1, buttons: 4 };
                const d = (type, extra = {}) => dispatch(type, { ...middle, ...extra });

                d('pointerdown');
                d('mousedown');
                d('auxclick');           //  THIS is what eBay listens to
                d('click');              //  some sites still need this
                setTimeout(() => {
                    d('pointerup');
                    d('mouseup');
                    resolve(true);
                }, 10 + Math.random() * 20);
                return;
            }

            // === FALLBACK ===
            const ok = dispatch(eventType);
            resolve(ok);

        } catch (err) {
            console.error("dispatchMouseEvent error:", err);
            resolve(false);
        }
    });
}


/**
 * Simulates a drag-and-drop interaction between pointer events across the DOM.
 *
 * performs a drag from the center of element to (center + deltaX, center + deltaY)
 * dispatches both pointer/mouse move sequences (for libraries that implement their own
 * drag handling) and native HTML5 drag events with a synthetic DataTransfer (for
 * elements using the browser's built-in drag-and-drop)
 *
 * The simulation includes intermediate movement steps to better mimic real
 * user interaction and to trigger `dragover`, `mousemove`, and `pointermove`
 * listeners along the path.
 *
 * Two knobs if you need to tune for a specific surface:
 *  - STEP_DELAY_MS (16) — bigger = slower, calmer drag.
 *  - the 80ms settle before release — this is the main lever against inertia. 
 * @async 
 * @function dispatchDragAndDrop
 * @param {Element} element - The DOM element to initiate the drag from.
 * @param {number} deltaX - Horizontal distance to drag (in pixels).
 * @param {number} deltaY - Vertical distance to drag (in pixels).
 * @returns {Promise<boolean>} Resolves to `true` if the drag sequence was
 * dispatched successfully, otherwise `false`.
 */
async function dispatchDragAndDrop(element, deltaX, deltaY, offsetX, offsetY) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        if (!element) return false;

        const startRect = element.getBoundingClientRect();
        // Grab at the recorded offset within the element (where the user actually
        // picked it up) so release = grab+delta reproduces the exact drop point.
        // Fall back to the element center when no usable offset was recorded/sent --
        // 0 counts as "not provided" (the SelectorSet default; a real grab is
        // essentially never exactly the top-left corner), so a stale/absent offset
        // grabs the center instead of the corner.
        const startX = offsetX ? startRect.left + offsetX : startRect.left + startRect.width / 2;
        const startY = offsetY ? startRect.top + offsetY : startRect.top + startRect.height / 2;
        const endX = startX + (deltaX || 0);
        const endY = startY + (deltaY || 0);

        const mk = (type, x, y, extra = {}) => {
            const Ev = type.startsWith('pointer') ? PointerEvent : (type.startsWith('drag') || type === 'drop' ? DragEvent : MouseEvent);
            const ev = new Ev(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x, clientY: y,
                screenX: x + window.screenX, screenY: y + window.screenY,
                pointerType: 'mouse',
                isPrimary: true,
                button: 0,
                ...extra
            });
            return ev;
        };

        // native HTML5 drag-and-drop uses a DataTransfer carried on dragstart/dragover/drop/dragend.
        // The resolved element may be a child of the draggable node (e.g. an <img>
        // inside a draggable wrapper), so walk up to the nearest draggable ancestor;
        // without it isNativeDrag is false and we'd fire only mouse events, which
        // native DnD ignores -> the element never moves.
        let dragEl = element;
        while (dragEl && dragEl.draggable !== true) dragEl = dragEl.parentElement;
        const isNativeDrag = !!(dragEl && dragEl.draggable === true);
        if (!isNativeDrag) dragEl = element;

        // Chromium ignores synthetic DragEvents for real HTML5 DnD (isTrusted:false,
        // no drag session). For a native draggable, ask the background to drive the
        // drag through the CDP debugger (Input.dispatchMouseEvent), which is trusted
        // and engages the real DnD machinery. Only the main frame's viewport coords
        // map cleanly to CDP, so restrict to the top frame; on success we're done,
        // otherwise (Firefox, no debugger, iframe, failure) fall through to the
        // synthetic sequence below.
        if (isNativeDrag && window.top === window) {
            const trusted = await new Promise((resolve) => {
                try {
                    Messaging.sendMessageToBackground(
                        { message: REQUEST.TRUSTED_DRAG, startX, startY, endX, endY },
                        (resp) => resolve(resp === 'OK')
                    );
                } catch (e) { resolve(false); }
            });
            if (trusted) return true;
        }

        const dataTransfer = isNativeDrag ? new DataTransfer() : null;

        element.dispatchEvent(mk('pointerdown', startX, startY, { buttons: 1 }));
        element.dispatchEvent(mk('mousedown', startX, startY, { buttons: 1 }));

        if (dataTransfer)
            dragEl.dispatchEvent(mk('dragstart', startX, startY, { dataTransfer }));

        // step toward the drop point so listeners that key off dragover/mousemove see intermediate positions
        const STEPS = 10;
        const STEP_DELAY_MS = 16;   // NOTE: hard coded value - ~1 frame between moves
        let dropTarget = element;
        for (let i = 1; i <= STEPS; i++) {
            const x = startX + (endX - startX) * i / STEPS;
            const y = startY + (endY - startY) * i / STEPS;
            dropTarget = getSearchRootNode().elementFromPoint(x, y) || element;

            dropTarget.dispatchEvent(mk('pointermove', x, y, { buttons: 1 }));
            dropTarget.dispatchEvent(mk('mousemove', x, y, { buttons: 1 }));

            if (dataTransfer) {
                dropTarget.dispatchEvent(mk('dragenter', x, y, { dataTransfer }));
                dropTarget.dispatchEvent(mk('dragover', x, y, { dataTransfer }));
            }

            // Spread the moves over real time. Dispatched back-to-back in one tick
            // they carry no elapsed time, so momentum/inertia handlers (e.g. Leaflet
            // maps) compute a huge release velocity and fling far past the target.
            await sleep(STEP_DELAY_MS);
        }

        // Let the pointer "rest" at the end before releasing so velocity decays to
        // ~0 and inertial surfaces don't keep gliding after the drop.
        await sleep(80);   // NOTE: hard coded value

        if (dataTransfer) {
            dropTarget.dispatchEvent(mk('drop', endX, endY, { dataTransfer }));
            dragEl.dispatchEvent(mk('dragend', endX, endY, { dataTransfer }));
        }

        dropTarget.dispatchEvent(mk('pointerup', endX, endY, { buttons: 0 }));
        dropTarget.dispatchEvent(mk('mouseup', endX, endY, { buttons: 0 }));

        return true;
    } catch (err) {
        console.error("dispatchDragAndDrop error:", err);
        return false;
    }
}

/**
 * Initializes a PerformanceObserver to track network resource activity and
 * maintain a rolling list of recent resource timing entries.
 *
 * @function initNetworkIdleObserver
 * @returns {{ entries: Array<{startTime: number, duration: number}> }}
 * An object containing the live entries array representing observed network
 * resource timing data.
 */
function initNetworkIdleObserver() {
    const entries = [];
    const observer = new PerformanceObserver(list => {
        const now = performance.now();
        list.getEntries().forEach(e => {
            if (e.entryType === 'resource') {
                entries.push({ startTime: e.startTime, duration: e.duration });
                lastActivity = now;
            }
        });
        const cutoff = now - 10000;
        while (entries.length && entries[0].startTime < cutoff) entries.shift();
    });
    observer.observe({ entryTypes: ['resource'] });
    return { entries };
}
/**
 * Determines whether the network is currently "idle" based on recent
 * PerformanceObserver resource entries.
 *
 * The network is considered idle when:
 * - The number of recent resource entries is less than or equal to
 *   `maxConnections`, AND
 * - No resource activity has occurred within `timeoutMs`.
 *
 * @function queryNetworkIdle
 * @param {number} timeoutMs - Minimum idle duration required (in milliseconds)
 * before the network is considered idle.
 * @param {number} maxConnections - Maximum allowed number of concurrent or
 * recent resource entries.
 * @param {number} pruneMs - Time window (in milliseconds) used to filter out
 * older network entries.
 * @returns {boolean} `true` if the network is considered idle, otherwise `false`.
 */
function queryNetworkIdle(timeoutMs, maxConnections, pruneMs) {
    const entries = window.networkIdleObserver.entries
        .filter(e => e.startTime > performance.now() - pruneMs);
    //entries.forEach((entry, index) => {
    if (persistence.settings.debugMessages) {
        console.log(`Entry ${index}:`, entry);
    }
    //});
    const count = entries.length;
    const lastTime = count ? Math.max(...entries.map(e => e.startTime + e.duration)) : 0;
    return count <= maxConnections && performance.now() - lastTime >= timeoutMs;
}

/**
 * Resolves the most appropriate clickable target within or around an element,
 * with special handling for anchor (`<a>`) elements.
 *
 * @function getClickableTextNode
 * @param {Element} element - The DOM element to evaluate.
 * @returns {Element|null} The most suitable clickable element, or the original
 * element if no alternative is found.
 */
function getClickableTextNode(element) {
    if (element && element.tagName && element.tagName.toLowerCase() === 'a') {
        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                return element; // Use <a> if text node found
            } else if (node.nodeType === Node.ELEMENT_NODE && node.textContent.trim()) {
                return node; // Use child element (e.g., <span>) if it has text
            }
        }
    }
    return element; // Fallback to original element
}
/**
 * Traverses up the DOM tree to find the nearest "real" clickable ancestor
 * of a given element.
 *
 * This function walks from the provided element upward toward `document.body`
 * and returns the first ancestor that is likely to be interactive based on
 * common heuristics, including:
 * - Semantic elements like `<button>` and `<a>`
 * - Elements with `role="button"`
 * - Elements with an inline `onclick` handler
 * - Elements styled with `cursor: pointer`
 *
 * @function getRealClickableAncestor
 * @param {Element} el - The DOM element to start searching from.
 * @returns {Element} The closest clickable ancestor, or the original element
 * if none is found.
 */
function getRealClickableAncestor(el) {
    let n = el;
    while (n && n !== document.body) {
        const cs = getComputedStyle(n);

        if (
            n.tagName === "BUTTON" ||
            n.tagName === "A" ||
            n.getAttribute("role") === "button" ||
            typeof n.onclick === "function" ||
            cs.cursor === "pointer"
        ) {
            if (persistence.settings.debugMessages) {
                console.log("getRealClickableAncestor: found clickable:", n);
            }
            return n;
        }

        n = n.parentElement;
    }
    if (persistence.settings.debugMessages) {
        console.log("getRealClickableAncestor: falling back to original element:", el);
    }
    return el;
}
/**
 * Retrieves the value of a DOM element property or attribute, with normalization
 * for common HTML attribute-to-DOM property name differences.
 *
 * @function getElementValue
 * @param {Element} element - The DOM element to read from.
 * @param {string} attr - The attribute or property name to retrieve.
 * @returns {*} The resolved property or attribute value, or `null` if not present.
 */
function getElementValue(element, attr) {
    const attrToPropMap = {
        // Reserved words or renamed
        class: 'className',
        for: 'htmlFor',

        // Case mismatches (camelCase in DOM)
        readonly: 'readOnly',
        maxlength: 'maxLength',
        minlength: 'minLength',
        tabindex: 'tabIndex',
        colspan: 'colSpan',
        rowspan: 'rowSpan',
        accesskey: 'accessKey',
        contenteditable: 'contentEditable',
        usemap: 'useMap',
        formnovalidate: 'formNoValidate',
        formaction: 'formAction',
        formenctype: 'formEnctype',
        formmethod: 'formMethod',
        formtarget: 'formTarget',

        // Media
        playsinline: 'playsInline',

        // iframe
        allowfullscreen: 'allowFullscreen',
        frameborder: 'frameBorder',
    };
    const propName = attrToPropMap[attr] || attr;

    // Check if the property exists and is not undefined/null
    if (propName in element && element[propName] !== undefined && element[propName] !== null) {
        return element[propName];
    }

    return element.getAttribute(attr);
}
/**
 * Extracts and concatenates all accessible CSS rules from the document's
 * stylesheets into a single string.
 *
 * @function getAllCss
 * @returns {string} A concatenated string containing all accessible CSS rule
 * text from the document.
 */
function getAllCss() {
    {
        var css = '';
        var stylesheets = document.styleSheets;
        for (var i = 0; i < stylesheets.length; i++) {
            {
                try {
                    {
                        var rules = stylesheets[i].cssRules;
                        for (var j = 0; j < rules.length; j++) {
                            {
                                css += rules[j].cssText + ' ';
                            }
                        }
                    }
                } catch (e) { { /* Ignore cross-origin stylesheet errors */ } }
            }
        }
        return css;
    }
}
function getElementCss(element) {
    {
        var css = '';
        var style = window.getComputedStyle(element);
        for (var i = 0; i < style.length; i++) {
            {
                css += style[i] + ': ' + style.getPropertyValue(style[i]) + '; ';
            }
        }
        return css;
    }
}

/**
 * Simulates pressing one or more modifier keys and updates internal modifier
 * state tracking.
 *
 * Supported modifier keys include:
 * - Control
 * - Shift
 * - Alt
 * - Windows/Meta
 * - Scroll Lock
 * - Application/Context Menu key
 *
 * @function pressModifierKey
 * @param {number} modifierKeys - Bitmask representing the modifier keys to
 * simulate as being pressed.
 * @returns {void}
 */
function pressModifierKey(modifierKeys) {
    if (0 != modifierKeys && (ModifierKeys.Control & modifierKeys) == ModifierKeys.Control) {
        const controlLEvent = {
            key: "Control",    // e.g., "a"
            code: "ControlLeft",  // e.g., "KeyA"
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        };
        const controlREvent = {
            key: "Control",    // e.g., "a"
            code: "ControlRight",  // e.g., "KeyA"
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', controlLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', controlREvent));
        modifiersHeld.Control = true;
    }

    if (0 != modifierKeys && (ModifierKeys.Shift & modifierKeys) == ModifierKeys.Shift) {
        const shiftLEvent = {
            key: "Shift",    // e.g., "a"
            code: "ShiftLeft",  // e.g., "KeyA"
            shiftKey: true,
            bubbles: true,
            cancelable: true
        };
        const shiftREvent = {
            key: "Shift",    // e.g., "a"
            code: "ShiftRight",  // e.g., "KeyA"
            shiftKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', shiftLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', shiftREvent));
        modifiersHeld.Shift = true;
    }

    if (0 != modifierKeys && (ModifierKeys.Alt & modifierKeys) == ModifierKeys.Alt) {
        const altLEvent = {
            key: "Alt",    // e.g., "a"
            code: "AltLeft",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        const altREvent = {
            key: "Alt",    // e.g., "a"
            code: "AltRight",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', altLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', altREvent));
        modifiersHeld.Alt = true;
    }

    if (0 != modifierKeys && (ModifierKeys.Windows & modifierKeys) == ModifierKeys.Windows) {
        const windowsLEvent = {
            key: "Meta",    // e.g., "a"
            code: "MetaLeft",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        const windowsREvent = {
            key: "Meta",    // e.g., "a"
            code: "MetaRight",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', windowsLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', windowsREvent));
    }

    if (0 != modifierKeys && (ModifierKeys.ScrollLock & modifierKeys) == ModifierKeys.ScrollLock) {
        const scrollLockEvent = {
            key: "ScrollLock",    // e.g., "a"
            code: "ScrollLock",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };

        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', scrollLockEvent));
    }

    if (0 != modifierKeys && (ModifierKeys.Application & modifierKeys) == ModifierKeys.Application) {
        const contextMenuEvent = {
            key: "ContextMenu",    // e.g., "a"
            code: "ContextMenu",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };

        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keydown', contextMenuEvent));
    }
}
/**
 * Simulates releasing one or more modifier keys and updates internal modifier
 * state tracking.
 *
 * Supported modifier keys include:
 * - Control
 * - Shift
 * - Alt
 * - Windows/Meta
 * - Scroll Lock
 * - Application/Context Menu key
 *
 * @function releaseModifierKey
 * @param {number} modifierKeys - Bitmask representing the modifier keys to
 * simulate as being released.
 * @returns {void}
 */
function releaseModifierKey(modifierKeys) {
    if (0 != modifierKeys && (ModifierKeys.Control & modifierKeys) == ModifierKeys.Control) {
        const controlLEvent = {
            key: "Control",    // e.g., "a"
            code: "ControlLeft",  // e.g., "KeyA"
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        };
        const controlREvent = {
            key: "Control",    // e.g., "a"
            code: "ControlRight",  // e.g., "KeyA"
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', controlLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', controlREvent));
        modifiersHeld.Control = false;
    }

    if (0 != modifierKeys && (ModifierKeys.Shift & modifierKeys) == ModifierKeys.Shift) {
        const shiftLEvent = {
            key: "Shift",    // e.g., "a"
            code: "ShiftLeft",  // e.g., "KeyA"
            shiftKey: true,
            bubbles: true,
            cancelable: true
        };
        const shiftREvent = {
            key: "Shift",    // e.g., "a"
            code: "ShiftRight",  // e.g., "KeyA"
            shiftKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', shiftLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', shiftREvent));
        modifiersHeld.Shift = false;
    }

    if (0 != modifierKeys && (ModifierKeys.Alt & modifierKeys) == ModifierKeys.Alt) {
        const altLEvent = {
            key: "Alt",    // e.g., "a"
            code: "AltLeft",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        const altREvent = {
            key: "Alt",    // e.g., "a"
            code: "AltRight",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', altLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', altREvent));
        modifiersHeld.Alt = false;
    }

    if (0 != modifierKeys && (ModifierKeys.Windows & modifierKeys) == ModifierKeys.Windows) {
        const windowsLEvent = {
            key: "Meta",    // e.g., "a"
            code: "MetaLeft",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        const windowsREvent = {
            key: "Meta",    // e.g., "a"
            code: "MetaRight",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', windowsLEvent));
        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', windowsREvent));
    }

    if (0 != modifierKeys && (ModifierKeys.ScrollLock & modifierKeys) == ModifierKeys.ScrollLock) {
        const scrollLockEvent = {
            key: "ScrollLock",    // e.g., "a"
            code: "ScrollLock",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };

        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', scrollLockEvent));
    }

    if (0 != modifierKeys && (ModifierKeys.Application & modifierKeys) == ModifierKeys.Application) {
        const contextMenuEvent = {
            key: "ContextMenu",    // e.g., "a"
            code: "ContextMenu",  // e.g., "KeyA"
            altKey: true,
            bubbles: true,
            cancelable: true
        };

        //dispatchResults = document.dispatchEvent(new KeyboardEvent('keyup', contextMenuEvent));
    }
}

// helpers for string manipulation
function isNullEmptyOrWhitespace(str) {
    return str === null || str === undefined || (typeof str === 'string' && str.trim().length === 0);
}


// Helper methods for scrolling behavior
function scrollPage(direction) {
    try {
        const isDown = direction === 'down';
        const scrollAmount = isDown ? window.innerHeight : -window.innerHeight;
        const keyName = isDown ? 'PageDown' : 'PageUp';
        const keyCode = isDown ? 34 : 33;
        let scrollMethod = 'none';
        let scrollPosition = 0;
        let elementClass = 'none';

        // Step 1: Check overflow property
        const overflow = getComputedStyle(document.documentElement).overflow;

        // Step 2: Try window.scrollBy if overflow is not 'hidden'
        const initialScrollY = window.scrollY;
        if (overflow !== 'hidden') {
            window.scrollBy({ top: scrollAmount, behavior: 'instant' });
            if (window.scrollY !== initialScrollY) {
                scrollMethod = 'window.scrollBy';
                scrollPosition = window.scrollY;
                return {
                    status: 'success',
                    method: scrollMethod,
                    scrollPosition,
                    elementClass: 'window'
                };
            }
        }

        // Step 3: Try scrolling the scrollable element
        const scrollable = Array.from(document.querySelectorAll('*')).find(
            el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'hidden'
        ) || document.body;
        const initialScrollTop = scrollable.scrollTop;
        scrollable.scrollBy({ left: 0, top: scrollAmount, behavior: 'instant' });
        elementClass = scrollable.className || 'body';

        if (scrollable.scrollTop !== initialScrollTop) {
            scrollMethod = 'element.scrollBy';
            scrollPosition = scrollable.scrollTop;
            return {
                status: 'success',
                method: scrollMethod,
                scrollPosition,
                elementClass
            };
        }

        // Step 4: Fallback to Page Up/Down key press
        scrollable.focus();
        const event = new KeyboardEvent('keydown', {
            key: keyName,
            code: keyName,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true
        });
        scrollable.dispatchEvent(event);

        // Verify scroll
        if (scrollable.scrollTop !== initialScrollTop) {
            scrollMethod = `${keyName}`;
            scrollPosition = scrollable.scrollTop;
            return {
                status: 'success',
                method: scrollMethod,
                scrollPosition,
                elementClass
            };
        }

        // Step 5: No scroll method worked
        return {
            status: 'failed',
            message: 'No scroll method worked',
            scrollPosition: scrollable.scrollTop,
            elementClass
        };
    } catch (error) {
        return {
            status: 'error',
            message: error.message,
            scrollPosition: 0,
            elementClass: 'none'
        };
    }
}
function scrollToPosition(position) {
    try {
        const isEnd = position === 'end';
        const scrollTarget = isEnd ? document.body.scrollHeight : 0;
        const keyName = isEnd ? 'End' : 'Top';
        const keyCode = isEnd ? 35 : 36;
        let scrollMethod = 'none';
        let scrollPosition = 0;
        let elementClass = 'none';

        // Step 1: Check overflow property
        const overflow = getComputedStyle(document.documentElement).overflow;

        // Step 2: Try window.scrollTo if overflow is not 'hidden'
        const initialScrollY = window.scrollY;
        if (overflow !== 'hidden') {
            window.scrollTo({ left: 0, top: scrollTarget, behavior: 'instant' });
            if (window.scrollY !== initialScrollY) {
                scrollMethod = 'window.scrollTo';
                scrollPosition = window.scrollY;
                return {
                    status: 'success',
                    method: scrollMethod,
                    scrollPosition,
                    elementClass: 'window'
                };
            }
        }

        // Step 3: Try scrolling the scrollable element
        const scrollable = Array.from(document.querySelectorAll('*')).find(
            el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'hidden'
        ) || document.body;
        const initialScrollTop = scrollable.scrollTop;
        const elementScrollTarget = isEnd ? scrollable.scrollHeight : 0;
        scrollable.scrollTo({ left: 0, top: elementScrollTarget, behavior: 'instant' });
        elementClass = scrollable.className || 'body';

        if (scrollable.scrollTop !== initialScrollTop) {
            scrollMethod = 'element.scrollTo';
            scrollPosition = scrollable.scrollTop;
            return {
                status: 'success',
                method: scrollMethod,
                scrollPosition,
                elementClass
            };
        }

        // Step 4: Fallback to Home/End key press
        scrollable.focus();
        const event = new KeyboardEvent('keydown', {
            key: keyName,
            code: keyName,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true
        });
        scrollable.dispatchEvent(event);

        // Verify scroll
        if (scrollable.scrollTop !== initialScrollTop) {
            scrollMethod = keyName;
            scrollPosition = scrollable.scrollTop;
            return {
                status: 'success',
                method: scrollMethod,
                scrollPosition,
                elementClass
            };
        }

        // Step 5: No scroll method worked
        return {
            status: 'failed',
            message: 'No scroll method worked',
            scrollPosition: scrollable.scrollTop,
            elementClass
        };
    } catch (error) {
        return {
            status: 'error',
            message: error.message,
            scrollPosition: 0,
            elementClass: 'none'
        };
    }
}

/**
 * Serializes a DOM element into a structured JSON string containing metadata
 * useful for identification, automation, and replay of UI interactions.
 *
 * This function extracts a wide range of properties from the given element,
 * including:
 * - Basic attributes (tag name, id, name, value, etc.)
 * - Visibility and layout information (bounding rectangle, display state)
 * - Interaction-related properties (disabled, selected, multiple, type)
 * - Derived locators (XPath, full XPath, CSS selector, and heuristic XPaths)
 * - Page context (current URL)
 *
 * It also computes multiple XPath strategies and deduplicates them to provide
 * a robust set of element locators for automation purposes.
 *
 * The result is returned as a JSON string. If the element is null or undefined,
 * the function returns null.
 *
 * @function createGPALElementJson
 * @param {Element} element - The DOM element to serialize.
 * @returns {string|null} A JSON string representing the element metadata, or
 * null if the input element is falsy.
 */
function createGPALElementJson(element, overrideCss, overrideXPath) {
    if (!element) { return null; }
    var rect = element.getBoundingClientRect();
    var xpaths = [
        getElementWithId(element),
        findAnchorAndCreateRelativeXPath(element),
        getElementByPosition(element),
        getElementByText(element),
        getElementWithAttributes(element),
    ].filter(item => item && typeof item.xpath !== 'undefined' && item.xpath !== null);
    xpaths = [...new Map(xpaths.map(v => [v.xpath, v])).values()];
    var isGPALElementDisplayed = !!element && (() => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0
        );
    })();
    // Normalize whitespace in returned text/values: collapse any run of
    // whitespace (spaces, tabs, CR/LF) to a single space and trim the ends,
    // so source-formatting newlines don't leak into matches. Non-strings
    // (null/undefined) pass through untouched so "absent" stays absent.
    const cleanText = (v) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
    const gpalElement = {
        Attributes: {
            //attributeName: element.getAttribute("data-attribute-name") || "", // Custom attribute, adjust as needed
            tagName: element.tagName.toLowerCase(),
            text: cleanText(element.innerText || ""),
            enabled: !element.disabled, // Check if element is not disabled
            // a checkbox says checked and an option says selected, and GPALElement.Selected is one question
            // over both of them, the way the selenium and puppeteer reads answer it
            selected: element.checked === true || element.selected === true,
            // the third state of a checkbox, which GPALElement.Checked answers with null
            indeterminate: element.indeterminate === true,
            location: {
                X: Math.round(rect.left + window.scrollX),
                Y: Math.round(rect.top + window.scrollY)
            },
            size: {
                Width: Math.round(rect.width),
                Height: Math.round(rect.height)
            },
            displayed: isGPALElementDisplayed, // Basic visibility check
            href: getElementValue(element,"href"),
            src: getElementValue(element, "src"),
            value: cleanText(getElementValue(element, "value")),
            index: getElementValue(element, "index"),
            placeholder: cleanText(element.getAttribute("placeholder") || null),
            xpath: overrideXPath ?? generateXPath(element),
            xpaths: xpaths,
            css: overrideCss ?? SelectorSet.getCss(element),
            fullXPath: generateFullXPath(element), // Implement this for full XPath
            id: element.id,
            name: getElementValue(element, "name"),
            content: cleanText(getElementValue(element, "content")),
            multiple: element.multiple, // file input[type=file] - whether multiple files may be selected
            boundingRect: {
                top: rect.top,
                left: rect.left,
                bottom: rect.bottom,
                right: rect.right,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            },
            pageURL: window.location.href,
            length: this.files ? this.files.length : this.Length || '',  // for input[type=file] and others
            type: element.type,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
        },
        ElementHandle: this.css // Set to null or a unique identifier if needed
        // WrappedDriver is omitted as it cannot be serialized
    };
    return JSON.stringify(gpalElement);
}
function generateXPath(element) {
    if (!element || !element.tagName) return "";
    let path = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
        let index = 0;
        let siblings = current.parentNode ? current.parentNode.children : [];
        for (let sibling of siblings) {
            if (sibling === current) {
                path.unshift(`${current.tagName.toLowerCase()}[${index + 1}]`);
                break;
            }
            if (sibling.tagName === current.tagName) index++;
        }
        current = current.parentNode;
    }
    return path.length ? "/" + path.join("/") : "";
}
function generateFullXPath(element) {
    if (!element || !element.tagName) return "";
    let path = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
        path.unshift(current.tagName.toLowerCase());
        current = current.parentNode;
    }
    return path.length ? "/" + path.join("/") : "";
}

function getElementWithId(el) {
    try {
        const id = el.getAttribute('id');
        bestXPath = null;
        matchedElements = 999;

        if (id) {
            const xpath = `//*[@id='${id}']`;
            return findBestMatch(xpath, el);
        }
    } catch (error) { }
    return null;
}
function getElementWithAttributes(el) {
    try {
        const tag = el.tagName.toLowerCase();
        const attributes = ['class', 'name', 'data-*', 'aria-*', 'title', 'alt', 'value', 'placeholder'];    // 'class',     // TODO: make this order configurable, dynamic classes are not useful
        bestXPath = null;
        matchedElements = 999;

        for (const attr of attributes) {
            const value = el.getAttribute(attr);
            if (value && -1 === value.indexOf('gpal')) {
                const xpath = `//${tag}[contains(@${attr}, '${value}')]`;
                var retval = findBestMatch(xpath, el);
                if (null !== retval) {
                    bestXPath = retval.xpath;
                    matchedElements = retval.matchedElements;
                }
            }
        }

        if (matchedElements !== 999)
            return { xpath: bestXPath, matchedElements: matchedElements };
    } catch (error) { }
    return null;
}
function getElementByText(el) {
    try {
        const text = el.textContent.trim();
        const tag = el.tagName.toLowerCase();
        bestXPath = null;
        matchedElements = 999;

        if (text) {
            const xpath = `//${tag}[normalize-space()='${text}']`;
            return findBestMatch(xpath, el);
        }
    } catch (error) { }

    return null;
}
function getElementByPosition(el) {
    if (!el) {
        return null;
    }

    try {
        const tag = el.tagName.toLowerCase();
        const siblings = Array.from(el.parentElement ? el.parentElement.children : document.body.children);
        const index = siblings.indexOf(el) + 1;
        bestXPath = null;
        matchedElements = 999;

        if (index > 0 && index <= siblings.length) {
            const xpath = `//${el.tagName}[${index}]/${tag}`;
            return findBestMatch(xpath, el);
        }
    } catch (error) { }

    return null;
}
function findAnchorAndCreateRelativeXPath(targetElement) {
    if (!targetElement) {
        return null;
    }

    let anchorElement = null;
    let currentNode = targetElement.parentElement;
    //            let currentNode = targetElement.previousElementSibling;
    matchedElements = 999;

    while (currentNode) {
        if (currentNode.id || currentNode.name) {
            anchorElement = currentNode;
            break;
        }

        currentNode = currentNode.parentElement;
        //                currentNode = currentNode.previousElementSibling;
    }

    let relativeXPath = '';

    if (anchorElement) {
        const pathSegments = [];
        let tempNode = targetElement;

        while (tempNode !== anchorElement && tempNode !== document.documentElement) {
            if (tempNode.tagName) {
                const tagName = tempNode.tagName.toLowerCase();
                const index = Array.from(tempNode.parentNode.children).indexOf(tempNode) + 1;
                pathSegments.unshift(`${tagName}[${index}]`);
            }

            tempNode = tempNode.parentNode;
        }

        // CAVEAT: fidelity plan mamanger radio button errors getting xpath, not sure why
        // trap for now as it prevents the click from firing
        try {
            relativeXPath = `${getElementWithId(anchorElement).xpath}/${pathSegments.join('/')}`;
        } catch (error) {
            void BROWSER.runtime.lastError;
            return null;
        }
        return findBestMatch(relativeXPath, targetElement);
    }

    return null;
}
function findBestMatch(xpath, element) {
    var bestXPath;
    var matchedElements = 999;
    var matchingElements;
    try {
        matchingElements = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch (error) {
        return null;
    }
    for (let i = 0; i < matchingElements.snapshotLength; i++) {
        if (matchingElements.snapshotItem(i) === element) {
            if (matchingElements.snapshotLength < matchedElements) {
                bestXPath = xpath;
                matchedElements = matchingElements.snapshotLength;
            }
        }
    }
    if (matchedElements === 999) { return null; }
    return { xpath: bestXPath, matchedElements: matchedElements };
}

function reportError(errorObj) {
    // The window error/unhandledrejection handlers fire for the host page's own
    // JS too, not just our injected code. Drop only errors that positively look
    // like host-page errors (an http(s) source with no reference to our code);
    // keep anything from the extension or of ambiguous origin so we never lose a
    // real OttoMagic error.
    const extOrigin = BROWSER.runtime.getURL('/');
    const fromExtension =
        (errorObj.file && errorObj.file.startsWith(extOrigin)) ||
        (errorObj.stack && errorObj.stack.includes(extOrigin));
    const fromPage =
        (errorObj.file && /^https?:/i.test(errorObj.file)) ||
        (errorObj.stack && /\bhttps?:\/\//i.test(errorObj.stack));
    if (fromPage && !fromExtension) { return; }

    Messaging.sendMessageToBackground({
        message: REQUEST.LOG_ERROR,
        payload: errorObj,
    });
}

function forceFocus(el) {
    // Remember original state
    const wasDisabled = el.disabled;
    const originalTabIndex = el.getAttribute('tabindex');

    try {
        // 1. Enable if disabled
        if (wasDisabled) el.disabled = false;

        // 2. Make sure it can receive focus
        if (el.tabIndex === -1 || !el.hasAttribute('tabindex')) {
            el.setAttribute('tabindex', '0');
        }

        // 3. Bring it into view
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

        // 4. Focus it
        el.focus();

        // 5. Small delay + aggressive fallback (helps with buttons, React, Shadow DOM, etc.)
        setTimeout(() => {
            if (getSearchRootNode().activeElement !== el) {
                el.focus();

                // Dispatch synthetic focus events
                el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
                el.dispatchEvent(new FocusEvent('focus', { bubbles: false }));

                if (wasDisabled) el.disabled = true;
            }
        }, 0);

        // Final check
        return getSearchRootNode().activeElement === el;

    } catch (err) {
        if (Globals.debug)
            console.warn("forceFocus failed:", err);
        return false;
    } finally {
        // Restore original state
        if (wasDisabled) el.disabled = true;
        if (originalTabIndex !== null) {
            el.setAttribute('tabindex', originalTabIndex);
        } else if (el.getAttribute('tabindex') === '0') {
            el.removeAttribute('tabindex');
        }
    }
}

function isElementEditable(target) {
    if (!target || !(target instanceof Element)) {
        return false;
    }

    // Quick exit for disabled/readonly elements
    if (target.disabled || target.readOnly) {
        return false;
    }

    try {
        // 1. Native form controls
        if (target.tagName === 'INPUT') {
            const editableTypes = new Set([
                'text', 'email', 'password', 'search', 'number', 'url',
                'tel', 'date', 'datetime-local', 'month', 'time', 'week',
                'color' // debatable, but user can interact
            ]);
            return editableTypes.has(target.type);
        }

        if (target.tagName === 'TEXTAREA') {
            return true;
        }

        if (target.tagName === 'SELECT') {
            return true; // user can change value
        }

        // 2. Contenteditable (best way)
        if (target.isContentEditable === true) {
            return true;
        }

        // 3. Whole document is editable
        if (target.ownerDocument?.designMode === 'on') {
            return true;
        }

        // 4. CSS user-modify (older spec, still used sometimes)
        const style = window.getComputedStyle(target);
        if (style.userModify === 'read-write' ||
            style.webkitUserModify === 'read-write') {
            return true;
        }

        // 5. Cursor as a fallback (least reliable)
        if (style.cursor === 'text') {
            return true;
        }

        // 6. Common editable class names / attributes (configurable)
        const editableClasses = ['editable', 'content-editable', 'ck-editor', 'quill', 'tinymce'];
        for (const cls of editableClasses) {
            if (target.classList.contains(cls)) {
                return true;
            }
        }

        if (target.getAttribute('contenteditable') === 'true') {
            return true;
        }

    } catch (e) {
        // Security error or detached element
        return false;
    }

    return false;
}