let persistence;
// NOTE: _background.js keeps its own copy of reloadPersistence only (the class one hung when called
// from the background). Change that method here and mirror it there. Everything else on this class is
// imported and called by the background directly, so it does not need mirroring.
class Persistence {
    constructor() {
        this.settings = new Settings();
        this.Workflow = [];
        this.indices = {};

        this.viewMode = "";

        //local storage object to see if previous element is in same dom as past
        this.prevDOM = {
            InIframe: null,
            InShadow: null
        };

        //stores unique selectorSets, used to reuse selectors
        this.selectorSets = [];
        this.variables = [];

        try {
            this.pageURL = "_content.js: " + window.location.href;
        } catch (error) {
            try {
                this.pageURL = "_content.js: " + document.URL;
            } catch (error) {
                this.pageURL = 'Persistence constructor: unable to get';
            }
        }
        
        // Which port the GPAL REST API landed on, pushed over the native pipe (REQUEST.SET_PORT) whenever the
        // native app brings a listener up, and null while it has none. It rides in persistence so every context
        // gets it through the reload it already does, rather than through a second key with its own plumbing.
        // Not knowable ahead of time -- the native side walks upward past collisions -- so nothing hardcodes 3000.
        this.serverPort = null;

        this.savedByID = null;
        this.timestamp = Date().toLocaleString();
        this.getOneSelector = false;
        this.firstStartup = true;
    }

    // Loads the persistence object from storage into memory. Storage is
    // authoritative: the background owns the in-memory copy and is the only log
    // writer, and no context keeps unsaved changes, so a reload always takes
    // storage as-is. Triggered on startup and on change events, never in a write
    // path.
    static reloadPersistence() {
        async function reload() {
            try {
                return await new Promise((resolve, reject) => {
                    BROWSER.storage.local.get("persistence", function (data) {
                        if (BROWSER.runtime.lastError) {
                            reject(BROWSER.runtime.lastError);
                        } else {
                            resolve(data);
                        }
                    });
                });
            } catch (error) {
                Globals.LogMessage(`Ottomatic reloaded?\n PLEASE REFRESH PAGE')}`);
                Globals.LogMessage(`UNABLE to get data.`, error);
            }
        }

        async function pruit() {
            const objectResult = await reload();
            if (!objectResult) {
                return;
            }
            if (!objectResult.persistence) {
                persistence = new Persistence();
                Persistence.savePersistence();
                return;
            }
            persistence = objectResult.persistence;
        }

        return pruit();
    }

    //method to save persistence object
    static savePersistence(functionaAndThen) {
        const callback = functionaAndThen;
        async function save() {
            try {
                return new Promise(function (resolve, reject) {
                    persistence.savedByID = Globals.contentId;
                    persistence.timestamp = Date().toLocaleString();
                    BROWSER.storage.local.set({ "persistence": persistence }, function () {
                        if (BROWSER.runtime.lastError) {
                            if (true == BROWSER.runtime.lastError.toString().includes('Extension context invalidated'))
                                Globals.LogMessage(`OttoMagic reloaded?<br> PLEASE REFRESH PAGE`);
                            else if (BROWSER.runtime.lastError.message.includes('QUOTA')) {
                                Globals.LogMessage(`Audit Logs Are TOO BIG}<br>Unable to save more.`);
                                reject(BROWSER.runtime.lastError);
                            } else {
                                Globals.LogMessage("An error occurred while saving persistence:", BROWSER.runtime.lastError.message);
                                reject(BROWSER.runtime.lastError);
                            }
                        } else {
                            Globals.LogMessage("saving persistence");
                            resolve();
                        }
                    });
                }).catch(error => {
                    if (BROWSER.runtime.lastError) {
                        if (true == BROWSER.runtime.lastError.message.toString().includes('Extension context invalidated'))
                            Globals.LogMessage(`OttoMagic reloaded?<br>PLEASE REFRESH PAGE`);
                        else if (BROWSER.runtime.lastError.message.includes('QUOTA'))
                            Globals.LogMessage(`'WORKFLOW TOO BIG'<br>Unable to save more.`);
                        else
                            Globals.LogMessage(`Error while saving persistence.<br> PLEASE REFRESH PAGE`, BROWSER.runtime.lastError.message);
                    } else
                        Globals.LogMessage(`Error while saving persistence.<br> PLEASE REFRESH PAGE`);
                });
            } catch (error) {
                Globals.LogMessage(`Error while saving persistence.<br>PLEASE REFRESH PAGE`, BROWSER.runtime.lastError.message);
            }
        }

        async function pruit() {
            await save();

            if (typeof callback === "function")
                return callback();
        }

        return pruit();
    }

    // Reconciles what storage holds against the current Persistence/Settings schema. A user who has been
    // running an older build has a stored object missing whatever properties we have added since, and those
    // read back undefined rather than defaulting -- so we build a fresh instance, layer the stored values
    // over it, and write back only when the key sets actually differ. Runs from onInstalled when the reason
    // is 'update', the only point at which the schema can have moved.
    // NOTE: MUST KEEP IN SYNC WITH OTTOMATIC.
    static async migratePersistenceSchema() {
        try {
            const objectResult = await new Promise((resolve, reject) => {
                BROWSER.storage.local.get("persistence", function (data) {
                    if (BROWSER.runtime.lastError) {
                        reject(BROWSER.runtime.lastError);
                    } else {
                        resolve(data);
                    }
                });
            });

            // Nothing exists yet.
            if (!objectResult || !objectResult.persistence) {
                persistence = new Persistence();
                await Persistence.savePersistence();
                return;
            }

            const storedPersistence = objectResult.persistence;

            // Current schema.
            const currentPersistence = new Persistence();

            mergeIntoCurrentSchema(
                currentPersistence,
                storedPersistence
            );

            const currentSettings = new Settings();

            mergeIntoCurrentSchema(
                currentSettings,
                storedPersistence.settings
            );

            currentPersistence.settings = currentSettings;

            persistence = currentPersistence;

            // Determine whether Persistence changed.
            const persistenceKeys = Object.keys(currentPersistence);
            const storedPersistenceKeys = Object.keys(storedPersistence);

            const persistenceAdded = persistenceKeys.some(
                key => !storedPersistenceKeys.includes(key)
            );

            const persistenceRemoved = storedPersistenceKeys.some(
                key => !persistenceKeys.includes(key)
            );

            const persistenceChanged =
                persistenceAdded || persistenceRemoved;

            // Determine whether Settings changed.
            const settingsKeys = Object.keys(currentSettings);

            const storedSettingsKeys = storedPersistence.settings
                ? Object.keys(storedPersistence.settings)
                : [];

            const settingsAdded = settingsKeys.some(
                key => !storedSettingsKeys.includes(key)
            );

            const settingsRemoved = storedSettingsKeys.some(
                key => !settingsKeys.includes(key)
            );

            const settingsChanged =
                settingsAdded || settingsRemoved;

            if (persistenceChanged || settingsChanged) {
                await Persistence.savePersistence();
            }

        } catch (error) {
            Globals.LogMessage(
                LOG_TYPE.ERROR,
                "Unable to migrate Persistence schema.",
                error
            );
        }
        function mergeIntoCurrentSchema(current, stored) {
            if (!stored) {
                return current;
            }

            for (const key of Object.keys(current)) {
                if (Object.prototype.hasOwnProperty.call(stored, key)) {
                    current[key] = stored[key];
                }
            }

            return current;
        }
    }
    static async getStorageUsed() {
        return new Promise((resolve, reject) => {
            // Get the storage bytes in use
            BROWSER.storage.local.getBytesInUse(null, function (bytesInUse) {
                const message = `  Storage used/allocated: ${bytesInUse}/${BROWSER.storage.local.QUOTA_BYTES}`;
                Globals.LogMessage(message);
                resolve(message);
            });
        });
    }

}

class Variable {
    name;
    type;
    value;

    constructor(name, type, value) {
        this.name = name;
        this.type = type;
        this.value = value;
    }

    static AddVariable(variable) {
        if (false == Variable.FindVariable(variable.name))
            persistence.variables.push(variable);
    }

    static FindVariable(variableName) {
        var variableFound = false;
        persistence.variables.forEach((variable) => {
            if (variableName === variable.name)
                variableFound = true;
        });
        return variableFound;
    }

    static DeleteVariable(variableName) {
        persistence.variables = persistence.variables.filter((variable) => {
            return variableName !== variable.name;
        });
    }
}