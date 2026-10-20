// Set BROWSER constant to chrome or browser object, depending on which is available
const BROWSER = globalThis.browser ?? globalThis.chrome;
// Firefox's extension pages are moz-extension:// and Chrome's and Edge's are chrome-extension://. A browser object no
// longer tells them apart, since Chromium now has one too. getURL works in content scripts as well.
const IS_FIREFOX = BROWSER.runtime.getURL("").startsWith("moz-extension:");

/* This constant defines the class name for the highlighted and dashed-outline css */
const HIGHLIGHTED_BOX_SHADOW_ELEMENT_CLASS = "gpal-box-shadow-line-element";

// Define constant object for different types of requests
const REQUEST = {
    RELOAD_PERSISTENCE: "reload persistence",
    CLEAR_LOGS: "clear logs",
    GET_TOP_LEVEL_URL: "get top level url",

    CAPTURE_VISIBLE_TAB: "capture-visible-tab",

    CHECK_NETWORK_IDLE: "check-network-idle",

    FULLSCREEN: "fullscreen",

    GET_MY_TAB_ID: 'get my tab id',
    GET_MY_FRAME_ID: 'get my frame id',

    SET_PORT: 'set-port',

    COPY_TO_CLIPBOARD: 'copy-to-clipboard',

    CHECK_NETWORK_IDLE_CONTENT: 'check-network-idle-content',
    CHECK_NETWORK_IDLE_RESPONSE: 'check-network-idle-response',

    BACK: 'back',
    FORWARD: 'forward',

    DELETE_STORAGE: 'delete-storage',
    GET_STORAGE: 'get-storage',
    SET_STORAGE: 'set-storage',

    EVALUATE: 'evaluate',
    EVALUATE_ALL: 'evaluate-all',
    EVALUATE_PERSISTENT: 'evaluate-persistent',
    EVALUATE_ALL_PERSISTENT: 'evaluate-all-persistent',

    FETCH: 'fetch',

    FILL_IN_APPEND: 'fill-in-append',
    FILL_IN_INSERT: 'fill-in-insert',
    FILL_IN_OVERWRITE: 'fill-in-overwrite',

    FIRE_CHANGE_EVENT: 'fire-change-event',

    GET_ATTRIBUTE: 'get-attribute',
    SET_ATTRIBUTE: 'set-attribute',
    GET_ELEMENT_ATTRIBUTE_HASH: 'get-element-attribute-hash',

    GET_CSS_ATTRIBUTES: 'get-css-attributes',
    GET_DOM_ATTRIBUTES: 'get-dom-attributes',
    GET_DOM_PROPERTIES: 'get-dom-properties',

    SET_VALUE_FROM_ELEMENT: 'set-value-from-element',

    GET_BOUNDING_CLIENT_RECT: 'get-bounding-client-rect',
    GET_CONTENT_AND_CSS: 'get-content-and-css',

    GET_CURRENT_URL: "get-current-url",
    GET_CURRENT_WINDOW: "get-current-window",
    GET_DOCUMENT_STAMP: "get-document-stamp",
    GET_HYDRATION_SCRIPTS: "get-hydration-scripts",

    GET_READY_STATUS: 'get-ready-status',

    GET_PARENT_NODE: 'get-parent-node',
    GET_SHADOW_ROOT: 'get-shadow-root',
    GET_LANGUAGES: 'get-languages',

    CAPTURE_CALLS: 'capture-calls',
    GET_CAPTURED_CALLS: 'get-captured-calls',

    GET_USERAGENT: 'get-useragent',

    GET_WINDOW_RECTANGLE: 'get-window-rectangle',

    GOTO: 'goto',
    GOTO_TAB: 'goto-tab',
    GOTO_WINDOW: 'goto-window',

    HIDE_ELEMENT: 'hide-element',

    FOCUS: 'focus',
    HOVER: 'hover',
    DRAG_AND_DROP: 'drag-and-drop',
    TRUSTED_DRAG: 'trusted-drag',   // internal: content asks background to run a trusted (CDP) drag

    INJECT_SCRIPT: 'inject-script',
    CLEAR_INJECTED_SCRIPTS: 'clear-injected-scripts',
    EXECUTE_JAVASCRIPT: 'execute-javascript',

    IS_CLICKABLE: 'is-clickable',
    IS_DISPLAYED: 'is-displayed',
    IS_ENABLED: 'is-enabled',

    IS_VISIBLE_IN_VIEWPORT: 'is-visible-in-viewport',
    IS_END_OF_PAGE: 'is-end-of-page',

    LEFT_CLICK: 'left-click',
    LEFT_DOUBLE_CLICK: 'left-double-click',
    MIDDLE_CLICK: 'middle-click',
    RIGHT_CLICK: 'right-click',
    TRUSTED_LEFT_CLICK: 'trusted-left-click',
    TRUSTED_MIDDLE_CLICK: 'trusted-middle-click',

    MAXIMIZE: 'maximize',
    MINIMIZE: 'minimize',
    NORMAL: 'normal',

    MOVE_TO: 'move-to',

    NEW_TAB: 'new-tab',
    CLOSE_TAB: "close-tab",
    NEXT_TAB: 'next-tab',
    PREVIOUS_TAB: 'previous-tab',

    OPEN_WINDOW: 'open-window',
    CLOSE_BROWSER: 'close-browser',
    CLOSE_WINDOW: 'close-window',
    NEXT_WINDOW: 'next-window',
    PREVIOUS_WINDOW: 'previous-window',

    OVERRIDE_REFERRER: 'override-referrer',
    GOOGLE_REFERRER: 'google-referrer',
    CLEAR_REFERRER: "clear-referrer",

    PAGE_UP: 'page-up',
    PAGE_DOWN: 'page-down',
    PAGE_END: 'page-end',
    PAGE_TOP: 'page-top',

    PRESS_MODIFIER_KEY: "press-modifier-key",
    RELEASE_MODIFIER_KEY: "release-modifier-key",

    QUERY_PERSISTENT_SELECTOR: 'query-persistent-selector',
    QUERY_PERSISTENT_SELECTORS: 'query-persistent-selectors',
    QUERY_SELECTOR: 'query-selector',
    QUERY_SELECTORS: 'query-selectors',

    REFRESH: 'refresh',
    RESTORE: 'restore',

    SCROLL_INTO_VIEW: 'scroll-into-view',
    SCROLL_ELEMENT: 'scroll-element',
    SCROLL_WINDOW: 'scroll-window',

    SELECT_CLICK: 'select-click',

    SEND_KEY: 'send-key',
    SEND_STRING: 'send-string',

    SET_DOWNLOAD_FILENAME: 'set-download-filename',
    LEFT_CLICK_DOWNLOAD: 'left-click-download',
    DOWNLOAD_URL: 'download-url',
    ELEMENT_FROM_POINT: 'element-from-point',

    SET_RANGE: 'set-range',

    SET_USERAGENT: 'set-useragent',

    SWITCH_TO_DEFAULT_CONTENT: 'switch-to-default-content',
    SWITCH_TO_ELEMENT: 'switch-to-element',
    SWITCH_TO_SHADOW_ROOT: 'switch-to-shadow-root',

    TAB_COUNT: 'tab-count',

    TOP_BROWSER: 'top-browser',

    WINDOW_INNER_HEIGHT: 'window-inner-height',
    WINDOW_OUTER_HEIGHT: 'window-outer-height',
    WINDOW_INNER_WIDTH: 'window-inner-width',
    WINDOW_OUTER_WIDTH: 'window-outer-width',

    WINDOW_PAGE_XOFFSET: 'window-page-xoffset',
    WINDOW_PAGE_YOFFSET: 'window-page-yoffset',
    WINDOW_SCREEN_LEFT: 'window-screen-left',
    WINDOW_SCREEN_TOP: 'window-screen-top',

    GET_PAGE_SOURCE: 'get-page-source',
    GET_STATUS_CODE: 'get-status-code',

    UPLOAD: 'upload',

    AUDIT_LOG: 'audit-log',
    LOG_ERROR: 'log-error'

}

//Define constant object for ModifierKeys
const ModifierKeys = {
    None: 0,
    Shift:  1,
    Control: 2,
    Alt:  4,
    Windows: 8,
    Application: 16,
    ScrollLock: 32
}

const LOG_TYPE = {
    NOTICE: "GPAL Notification",    // info
    ERROR: "GPAL Error",    // error
    DEBUG: "GPAL Debug",    // debug
    WARN: "GPAL Warning",   // warn
    CRITICAL: "GPAL Alert", // critical - can't block
}


