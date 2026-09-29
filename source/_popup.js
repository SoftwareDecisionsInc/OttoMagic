/*
In summary, this code below retrieves a value from local storage, creates a new object and stores it in
local storage if the retrieved value is null or undefined, and updates various parts of the UI based
on the value of the persistence object.
*/
Globals.currentContentID = 'popup';	// Math.random().toString(36).substring(2);
const body = document.querySelector('#body');

function init() {
	Persistence.reloadPersistence(true).then(() => {
		if (true == persistence.settings.darkMode)
			darkModeOn();
		else
			darkModeOff();
		body.classList.remove("hidden");
		//Messaging.sendMessageToBackground(REQUEST.GET_MY_FRAME_ID, (response) => {
		//	Globals.currentContentID = response;

		//	BROWSER.tabs.query({ active: true }, function (tabs) {
		//		try {
		//			if (0 < tabs.length && tabs[0].url) {
		//				var startupURL = tabs[0].url;
		//			}
		//		} catch (error) {
		//			LogMessage(LOG_TYPE.DEBUG, "error in getting url in popup.js:", error);
		//		}
		//		LogMessage(LOG_TYPE.DEBUG, "popup.js starting up", startupURL, Globals.currentContentID);
		//	});
		//});

		Globals.nonce = Globals.generateNonce();

		updateViewState();
		updateSettings();
		updateAuditLog();
		updateErrorLog();
		updateServerPort();

		Persistence.getStorageUsed().then(message => {
			const manifest = BROWSER.runtime.getManifest();

			easteregg.innerHTML =
				'Thanks for choosing GPAL!!<br>' +
				'OttoMagic v' + manifest.version + '<br>' +
				message;
		});
	});

	// add click event listener
	buttonAuditLog.addEventListener("click", openAuditLog, false);
	// add click event listener
	buttonErrorLog.addEventListener("click", openErrorLog, false);
	// add click event listener
	buttonSettings.addEventListener("click", openSettings, false);
	buttonClearInjected.addEventListener("click", clearInjectedScripts, false);
	// add click event listener
	buttonController.addEventListener("click", openController, false);
	// add event listener to clear audit and error logs
	buttonEraseAll.addEventListener("click", eraseAllOutput, false);
	//add event listener for download button to call ZIP download function
	buttonDownload.addEventListener("click", zipUpAllTheThings, false);
	// add link to SDI website
	buttonSDI.addEventListener("click", goToCompanySite, false);
	//Add reload function to reload button
	buttonReload.addEventListener("click", reloadExtension, false);
	//add closeExtension function to 'X' button
	buttonClose.addEventListener("click", closeExtension, false);
	//update-settings function runs on change
	sectionSettings.addEventListener("change", updateSettingsInterface, true);

	hideDevelopmentOnlyControls();
};

// The reload button tears down and rebuilds the extension, which is something we do while working on it and
// not something to hand a user. installType is the authoritative answer and the only one that holds in both
// browsers: 'development' is an unpacked load in Chrome or a temporary one in Firefox, and every other value --
// 'normal' from a store, 'sideload' for an XPI dropped into the profile, 'admin' for policy -- is somebody
// running the thing rather than building it.
async function hideDevelopmentOnlyControls() {
	let isDevelopment = false;

	try {
		const me = await BROWSER.management.getSelf();
		isDevelopment = 'development' === me?.installType;
	} catch (error) {
		// getSelf is the one management call that needs no permission, but if it is ever unavailable fall back to
		// the store's own marker: Chrome injects update_url into a web store install and an unpacked one has none.
		// Firefox never injects it, so the fallback only errs toward leaving the button visible.
		isDevelopment = !BROWSER.runtime.getManifest().update_url;
	}

	if (false === isDevelopment)
		buttonReload.classList.add("hidden");
}

// Shows the port the GPAL REST API reported over the native pipe. Empty until the native app connects and pushes
// it, which is a real state rather than an error -- the browser can be up before the REST server is.
function updateServerPort() {
	const port = persistence.serverPort;
	spanServerPort.textContent = port ? port : "--";
	spanServerPort.classList.toggle("disconnected", !port);
}

BROWSER.storage.onChanged.addListener(async (changes, area) => {
	//if (persistence.settings.debugMessages) {
	//	console.log("storage changed");
	//}
	if (area === "local" && changes.persistence) {
		//if (persistence.settings.debugMessages) {
		//	console.log("local persistence changed");
		//}
		await Persistence.reloadPersistence(true);
		updateSettings();
		updateAuditLog();
		updateErrorLog();
		updateServerPort();
	}
});


//Function below opens controller webbage
async function openController(objectEvent) {
	updateServerPort();
	const CONTROLLER_PAGE = `localhost:${spanServerPort.textContent}/controller`;
	BROWSER.tabs.create({ url: CONTROLLER_PAGE });
}
//Function below toggles chrome extension between settings and output
async function openSettings(objectEvent) {
	await Persistence.reloadPersistence(true);
	persistence.viewMode = "settings";
	updateSettings();
	updateInjectedScripts();
	updateViewState();
	Persistence.savePersistence();
}

// what this extension has registered to run on every document. a registration is kept by the profile rather than
// by the browser that asked for it, so it outlives that browser and every later one until something takes it
// away. nothing else shows them, which is the reason this panel exists
async function updateInjectedScripts() {
	const status = document.getElementById("injectedStatus");
	const list = document.getElementById("injectedList");

	list.innerHTML = "";

	if (!BROWSER.userScripts) {
		status.textContent = "User scripts are not allowed for this extension";
		return;
	}

	let registered = [];

	try {
		registered = await BROWSER.userScripts.getScripts();
	} catch (err) {
		status.textContent = "Could not read what is registered: " + err.message;
		return;
	}

	status.textContent = registered.length
		? registered.length + " registered"
		: "None registered";

	registered.forEach(script => {
		const item = document.createElement("li");
		const code = (script.js || []).map(source => source.code || source.file || "").join("\n");

		item.className = "dotnet-method";
		item.textContent = [script.id, script.world, script.runAt, (script.matches || []).join(" ")]
			.filter(part => part).join("  ");

		// the source itself is too long for the list and is what says which run left it here
		item.title = code;

		list.appendChild(item);
	});
}

// only what we registered, since the ids are ours and no extension can see another's scripts anyway
async function clearInjectedScripts(objectEvent) {
	if (!BROWSER.userScripts) return;

	const registered = await BROWSER.userScripts.getScripts();
	const ours = registered
		.filter(script => 0 === script.id.indexOf(Globals.injectedScriptPrefix))
		.map(script => script.id);

	if (ours.length > 0)
		await BROWSER.userScripts.unregister({ ids: ours });

	updateInjectedScripts();
}

async function openAuditLog(objectEvent) {
	await Persistence.reloadPersistence(true);
	persistence.viewMode = "audit-log";
	updateAuditLog();
	updateViewState();
	Persistence.savePersistence();
}

async function openErrorLog(objectEvent) {
	await Persistence.reloadPersistence(true);
	persistence.viewMode = "error-log";
	updateErrorLog();
	updateViewState();
	Persistence.savePersistence();
}

//effect should be called onCLick
// This function erases all output data after asking for confirmation from the user

function eraseAllOutput(objectEvent) {

	// Call presentDialog() to display a dialog box with the prompt message and two options - confirm and cancel
	presentDialog({
		prompt: "Are you sure you want to clear Audit and Error Logs?",
		confirm: {
			// If the user confirms the action, call an anonymous function that does the following:
			effect: eraseAllConfirmed,
			// Display a warning message on the confirm button
			warning: "CLEAR ALL",
		},
		// If the user cancels the action, set the effect property to null and display "NEVER MIND" on the cancel button
		cancel: {
			effect: null,
			text: "NEVER MIND",
		},
	});
}

//the prompt didn't want to call the erase function in the effect attribute so this was created to delete all ouput after confitming erase all
async function eraseAllConfirmed() {
	await Persistence.reloadPersistence(true);
	persistence.auditLog = [];
	persistence.errorLog = [];
	Persistence.savePersistence();
	refreshPopup();
	Messaging.sendMessageToBackground(REQUEST.RELOAD_PERSISTENCE);
}

//Function sends user to company website
function goToCompanySite(objectEvent) {
	//const SDI_SITE = "https://gpal.sditx.com/";
	//BROWSER.tabs.create({ url: SDI_SITE });
	const companyBox = document.getElementById("companyBox");

	const isHidden = getComputedStyle(companyBox).display === "none";

	companyBox.style.display = isHidden ? "block" : "none";

	// sync button state here
	document.getElementById("sectionButtons")
		.classList.toggle("company-open", isHidden);
}

/*

The method below reloads the background scripts of the extension, but it does not affect any content scripts
that may be running on web pages.

*/
function reloadExtension(objectEvent) {
	presentDialog({
		prompt: "<h2>Are you sure you want to reload?<br><br>Be sure to refresh the page afterwards.</h2>",
		confirm: {
			effect: () => {

				//Save settings before reloading
				Persistence.savePersistence();
				
				//Reset badge icon to default status
				BROWSER.action.setBadgeBackgroundColor({
					color: [0, 0, 0, 0]
				});
				BROWSER.action.setBadgeText({
					text: ""
				});

				// Kill the native app; the background reloads the extension once the
				// app is actually gone (its disconnect is the signal).
				Messaging.sendMessageToBackground('die');

				
			},
			warning: "RELOAD",
		},
		cancel: {
			effect: null,
			text: "NEVER MIND",
		},
	});
}


//function to close browser extension
function closeExtension(objectEvent) {
	window.close();
}

// This function updates the settings based on user input
function updateSettingsInterface(objectEvent) {
	// Switch statement checks the type of input element and updates the persistence object accordingly
	Persistence.reloadPersistence(true).then(() => {
		switch (objectEvent.target.type) {
			case "checkbox":
				persistence.settings[objectEvent.target.id] = objectEvent.target.checked;
				if ('darkMode' === objectEvent.target.id)
					toggleDarkMode();
				else {
					//updateViewState();
					updateSettings();
					//updateOutput();
				}
				break;
			case "number":
				switch (objectEvent.target.id) {
					case "truncateTextTo":
						persistence.settings.truncateTextTo =
							objectEvent.target.value;
						break;

					case "marginSize":
						persistence.settings.marginSize =
							objectEvent.target.value;
						break;

					case "compressionPercent":
						persistence.settings.compressionPercent =
							objectEvent.target.value;
						break;

					case "waitForHover":
						persistence.settings.waitForHover =
							objectEvent.target.value;
						break;

					case "auditMaxEntries":
						persistence.settings.auditMaxEntries = Math.max(
							1,
							Math.min(999, Number(objectEvent.target.value))
						);

						objectEvent.target.value =
							persistence.settings.auditMaxEntries;
						break;
				}
				break;
		}
		Persistence.savePersistence();
	});
}

/*
The purpose of this code below is to check if the user has given permission to record their activity on
open tabs, and if any tabs have declined to be recorded. If all tabs have given permission to be recorded,
or if there are no tabs open, the function calls actuallyStartDoingTheThings() to begin recording user
activity.

*/

/*
The overall goal of the Messaging.messageAllTabs function is to send a message to all tabs in the current window,
and optionally execute a function after each tab has responded to the message.
*/
function messageAllTabs(message, callback) {
	// Query all tabs in the current window
	BROWSER.tabs.query({ lastFocusedWindow: true }, (tabs) => {
		// For each tab
		for (const tab of tabs) {
			try {
				if (REQUEST.CAN_WE_COMMUNICATE === message)	// prepare to track the replies
					Globals.responseTracker[tab.id] = {
						responded: false
					};
				// Send the message to the tab
				BROWSER.tabs.sendMessage(
					tab.id,
					message,
					{},
					(response) => {
						// If a callback function is provided, execute it with the response as the argument
						if (typeof callback === "function") {
							callback(tab.id, response);
						}

						// Ignore any runtime errors
						void BROWSER.runtime.lastError;
					}
				);
			} catch (error) {
				// Handle different types of errors that can occur when sending messages to tabs
				switch (error.message) {
					// If the message context or extension context is invalidated, log a warning message
					case "Message context invalidated.":
					case "Extension context invalidated.":
						Globals.LogMessage(LOG_TYPE.DEBUG,
							"Ottomatic has been reloaded since the recording began, and tab ID " +
								tab.id +
								" is now stale."
						);
						break;

					// If the receiving end of the message does not exist (i.e., the tab has closed), log a warning message
					case "Could not establish connection. Receiving end does not exist.":
						Globals.LogMessage(LOG_TYPE.DEBUG,
							"Tab ID " +
								tab.id +
								" has closed since recording began."
						);
						break;

					// Otherwise, re-throw the error
					default:
					case "The message port was closed before a response was received.":
						Globals.LogMessage(LOG_TYPE.DEBUG, error);
				}
			}
		}
	});
}

/**
 *
 This function creates a ZIP archive of the aduit logs
 */
async function zipUpAllTheThings() {

	// Convert and flatten audit log
	const auditCSV = arrayToCsv(persistence.auditLog);

	// Convert and flatten error log
	const errorCSV = arrayToCsv(persistence.errorLog);


	// Create a new JSZip object to create the ZIP archive.
	const zip = new JSZip();

	zip.file("audit-log.csv", auditCSV);
	zip.file("error-log.csv", errorCSV);

	const zipBlob = await zip.generateAsync({ type: "blob" });
	const url = URL.createObjectURL(zipBlob);

	BROWSER.downloads.download({
		url,
		filename: "OttoMagic.logs.zip",
		saveAs: false // set true if you want the user to choose location
	});
}

function arrayToCsv(array) {
	if (!array.length) return "";

	// Flatten all objects
	const flattenedArray = array.map(item => flattenObject(item));

	// Get all headers (keys) from first item
	const headers = Object.keys(flattenedArray[0]);

	// Build CSV rows
	const rows = flattenedArray.map(item =>
		headers.map(h => `"${String(item[h] ?? "").replace(/"/g, '""')}"`).join(",")
	);

	return [headers.join(","), ...rows].join("\n");
}

/*
Function below:

_ Toggles the appearance of certain buttons and sections based on whether
the application is in recording mode or not, and whether there are any recorded actions or not.
- Sets the badge text and color for the browser extension depending on whether the application is in
recording mode or not.
*/

// updates the view based on the current state of the application
function updateViewState() {
	// Remove active state from all page buttons first
	buttonAuditLog.classList.remove("active");
	buttonErrorLog.classList.remove("active");
	buttonSettings.classList.remove("active");

	switch (persistence.viewMode) {

		default:
		case "audit-log":
			buttonSettings.classList.remove("rotating");
			buttonReload.disabled = false;

			sectionErrorLog.classList.add("hidden");
			sectionSettings.classList.add("hidden");
			sectionAuditLog.classList.remove("hidden");

			// Audit is active
			buttonAuditLog.classList.add("active");
			break;

		case "settings":
			buttonSettings.classList.add("rotating");
			buttonReload.disabled = false;

			sectionAuditLog.classList.add("hidden");
			sectionErrorLog.classList.add("hidden");
			sectionSettings.classList.remove("hidden");

			// Settings is active
			buttonSettings.classList.add("active");
			break;

		case "error-log":
			buttonSettings.classList.remove("rotating");
			buttonReload.disabled = false;

			sectionSettings.classList.add("hidden");
			sectionAuditLog.classList.add("hidden");
			sectionErrorLog.classList.remove("hidden");

			// Errors is active
			buttonErrorLog.classList.add("active");
			break;
	}
}
//The overall goal of this code is to update the settings UI with the values from the persistence.settings object
function updateSettings() {
	document.querySelectorAll("input[type='checkbox']").forEach((checkBox) => {
		checkBox.checked = persistence.settings[checkBox.id];
	});

	const auditMaxEntriesInput =
		document.getElementById("auditMaxEntries");

	if (auditMaxEntriesInput) {
		auditMaxEntriesInput.value =
			persistence.settings?.auditMaxEntries ?? 25;
	}
}

let sortState = {
	column: "timestamp",
	ascending: true
};

let maxEntries = 999;

// Clears any active text selection and marks up all element actions based on the current settings.
async function updateAuditLog() {
	// Force a fresh reload every time the UI is updated
	await Persistence.reloadPersistence(true);   // fire-and-forget is fine here

	const table = document.querySelector(".table-scroll table");
	if (!table) return;

	// Tail-follow: keep the newest entry in view after the rebuild when the user
	// was already parked at that end (watching live). Only timestamp columns are
	// sortable, so a descending sort puts the latest row at the top; otherwise
	// the latest is at the bottom. If the user has scrolled away to read history,
	// leave their position alone. An empty log counts as pinned so the first
	// entries snap into view.
	const scroller = document.querySelector(".table-scroll");
	const latestAtTop = !!sortState.column && !(persistence?.settings?.auditAscending ?? true);
	const wasPinned = !scroller || (latestAtTop
		? scroller.scrollTop <= 4
		: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4);

	const thead = table.querySelector("thead");
	const tbody = table.querySelector("tbody");

	thead.innerHTML = "";
	tbody.innerHTML = "";

	if (!persistence?.auditLog?.length) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");

		cell.textContent = "The audit log is currently empty.";
		cell.colSpan = 999;
		cell.classList.add("audit-empty");

		row.appendChild(cell);
		tbody.appendChild(row);

		return;
	}

	maxEntries = persistence.settings?.auditMaxEntries ?? persistence.auditLog.length;

	let workingData = persistence.auditLog.slice(-maxEntries);

	sortState.ascending = persistence.settings?.auditAscending ?? true;

	if (sortState.column) {
		workingData.sort((a, b) => {
			const aVal = flattenObject(a)[sortState.column];
			const bVal = flattenObject(b)[sortState.column];

			if (sortState.column.toLowerCase().includes("timestamp")) {
				const dateA = new Date(aVal || 0);
				const dateB = new Date(bVal || 0);
				return sortState.ascending ? dateA - dateB : dateB - dateA;
			}

			const strA = String(aVal ?? "");
			const strB = String(bVal ?? "");
			return sortState.ascending
				? strA.localeCompare(strB)
				: strB.localeCompare(strA);
		});
	}

	const flattenedData = workingData.map(item => flattenObject(item));

	const allKeys = new Set();
	flattenedData.forEach(item => {
		Object.keys(item).forEach(key => allKeys.add(key));
	});

	const columns = Array.from(allKeys).sort((a, b) => a.localeCompare(b));

	// Header
	const headerRow = document.createElement("tr");

	// Row number column
	const numberHeader = document.createElement("th");
	numberHeader.textContent = "#";
	numberHeader.classList.add("row-number");
	headerRow.appendChild(numberHeader);

	columns.forEach(col => {
		const th = document.createElement("th");
		th.textContent = col;

		if (col.toLowerCase().includes("timestamp")) {
			th.style.cursor = "pointer";
			th.addEventListener("click", () => handleSort(col));

			if (sortState.column === col) {
				th.textContent += sortState.ascending ? " ▲" : " ▼";
			}
		}

		headerRow.appendChild(th);
	});

	thead.appendChild(headerRow);

	// Rows
	flattenedData.forEach((item, index) => {
		const row = document.createElement("tr");

		const numberCell = document.createElement("td");
		numberCell.textContent = sortState.ascending
			? index + 1
			: flattenedData.length - index;
		numberCell.classList.add("row-number");
		row.appendChild(numberCell);

		columns.forEach(key => {
			const td = document.createElement("td");
			td.textContent = item[key] ?? "--";
			row.appendChild(td);
		});

		tbody.appendChild(row);
	});

	table.classList.toggle("hide-row-numbers", !persistence.settings.auditLineNumbers);

	// Keep the newest row in view when the user was already parked at its end.
	if (wasPinned && scroller) {
		scroller.scrollTop = latestAtTop ? 0 : scroller.scrollHeight;
	}
}

async function handleSort(column) {
	await Persistence.reloadPersistence(true);
	if (sortState.column === column) {
		sortState.ascending = !sortState.ascending;
		persistence.settings.auditAscending = sortState.ascending;
		Persistence.savePersistence();
//			Persistence.reloadPersistence(true);
	} else {
		sortState.column = column;
		sortState.ascending = true;
	}

	refreshPopup();
}

async function updateErrorLog() {
	// Force a fresh reload every time the UI is updated
	await Persistence.reloadPersistence(true);   // fire-and-forget is fine here

	const table = document.querySelector(".errtable-scroll table");
	if (!table) return;

	// Tail-follow: keep the newest entry in view after the rebuild when the user
	// was already parked at that end (watching live). Only timestamp columns are
	// sortable, so a descending sort puts the latest row at the top; otherwise
	// the latest is at the bottom. If the user has scrolled away to read history,
	// leave their position alone. An empty log counts as pinned so the first
	// entries snap into view.
	const scroller = document.querySelector(".errtable-scroll");
	const latestAtTop = !!sortState.column && !(persistence?.settings?.auditAscending ?? true);
	const wasPinned = !scroller || (latestAtTop
		? scroller.scrollTop <= 4
		: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4);

	const thead = table.querySelector("thead");
	const tbody = table.querySelector("tbody");

	thead.innerHTML = "";
	tbody.innerHTML = "";

	if (!persistence?.errorLog?.length) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");

		cell.textContent = "The error log is currently empty.";
		cell.colSpan = 999;
		cell.classList.add("error-empty");

		row.appendChild(cell);
		tbody.appendChild(row);

		return;
	}

	maxEntries = persistence.settings?.auditMaxEntries ?? persistence.errorLog.length;

	let workingData = persistence.errorLog.slice(-maxEntries);

	sortState.ascending = persistence.settings?.auditAscending ?? true;

	if (sortState.column) {
		workingData.sort((a, b) => {
			const aVal = flattenObject(a)[sortState.column];
			const bVal = flattenObject(b)[sortState.column];

			if (sortState.column.toLowerCase().includes("timestamp")) {
				const dateA = new Date(aVal || 0);
				const dateB = new Date(bVal || 0);
				return sortState.ascending ? dateA - dateB : dateB - dateA;
			}

			const strA = String(aVal ?? "");
			const strB = String(bVal ?? "");
			return sortState.ascending
				? strA.localeCompare(strB)
				: strB.localeCompare(strA);
		});
	}

	const flattenedData = workingData.map(item => flattenObject(item));

	const allKeys = new Set();
	flattenedData.forEach(item => {
		Object.keys(item).forEach(key => allKeys.add(key));
	});

	const columns = Array.from(allKeys).sort((a, b) => a.localeCompare(b));

	// Header
	const headerRow = document.createElement("tr");

	// Row number column
	const numberHeader = document.createElement("th");
	numberHeader.textContent = "#";
	numberHeader.classList.add("row-number");
	headerRow.appendChild(numberHeader);

	columns.forEach(col => {
		const th = document.createElement("th");
		th.textContent = col;

		if (col.toLowerCase().includes("timestamp")) {
			th.style.cursor = "pointer";
			th.addEventListener("click", () => handleSort(col));

			if (sortState.column === col) {
				th.textContent += sortState.ascending ? " ▲" : " ▼";
			}
		}

		headerRow.appendChild(th);
	});

	thead.appendChild(headerRow);

	// Rows
	flattenedData.forEach((item, index) => {
		const row = document.createElement("tr");

		const numberCell = document.createElement("td");
		numberCell.textContent = sortState.ascending
			? index + 1
			: flattenedData.length - index;
		numberCell.classList.add("row-number");
		row.appendChild(numberCell);

		columns.forEach(key => {
			const td = document.createElement("td");
			td.textContent = item[key] ?? "--";
			row.appendChild(td);
		});

		tbody.appendChild(row);
	});

	table.classList.toggle("hide-row-numbers", !persistence.settings.auditLineNumbers);

	// Keep the newest row in view when the user was already parked at its end.
	if (wasPinned && scroller) {
		scroller.scrollTop = latestAtTop ? 0 : scroller.scrollHeight;
	}
}

function flattenObject(obj, parentKey = "", result = {}) {
	for (const key in obj) {
		const newKey = parentKey ? `${parentKey}.${key}` : key;

		if (
			typeof obj[key] === "object" &&
			obj[key] !== null &&
			!Array.isArray(obj[key])
		) {
			flattenObject(obj[key], newKey, result);
		} else {
			const finalKey = newKey === "message.message" ? "message" : newKey;
			result[finalKey] = obj[key];
		}
	}
	return result;
}
// Displays a dialog box based on the provided objectDialog
function presentDialog(objectDialog) {
	if (objectDialog) {
		turnTheLightsDown(objectDialog);
	}
	// Turns the lights down, sets the dialog box content and event listeners
	// "turn the lights down" is also used as a metaphorical phrase to refer to the action of displaying the dialog box and dimming the rest of the UI.
	function turnTheLightsDown() {
		divPrompt.innerHTML = objectDialog.prompt;
		if (objectDialog.confirm) {
			if (objectDialog.confirm.text) {
				buttonConfirm.innerText = objectDialog.confirm.text;
				buttonConfirm.classList.remove("warning");
			}
			if (objectDialog.confirm.warning) {
				buttonConfirm.innerText = objectDialog.confirm.warning;
				buttonConfirm.classList.add("warning");
			}
			buttonConfirm.classList.remove("hidden");
			buttonConfirm.addEventListener("click", handleClickConfirm);
		} else {
			buttonConfirm.classList.add("hidden");
		}
		if (objectDialog.cancel) {
			buttonCancel.innerText = objectDialog.cancel.text;
			buttonCancel.classList.remove("hidden");
			buttonCancel.addEventListener("click", handleClickCancel);
		} else {
			buttonCancel.classList.add("hidden");
		}
		sectionDialog.classList.remove("hidden");
		divOverlay.classList.remove("hidden");
		divOverlay.addEventListener("click", handleClickCancel);
	}

	// Turns the lights up, clears the dialog box content and event listeners
	// "turn the lights up" is used as a metaphorical phrase to refer to the action of closing the dialog box and returning the UI to its original state.
	function turnTheLightsUp() {
		divOverlay.removeEventListener("click", handleClickCancel);
		divOverlay.classList.add("hidden");
		sectionDialog.classList.add("hidden");
		if (objectDialog.confirm) {
			buttonConfirm.innerText = "";
			buttonConfirm.removeEventListener("click", handleClickConfirm);
		}
		if (objectDialog.cancel) {
			buttonCancel.innerText = "";
			buttonCancel.removeEventListener("click", handleClickCancel);
		}
		divPrompt.innerHTML = "";
	}

	// Handles the click event on the confirm button and calls the corresponding function if provided
	function handleClickConfirm() {
		turnTheLightsUp(objectDialog);
		if (
			objectDialog.confirm &&
			typeof objectDialog.confirm.effect === "function"
		) {
			objectDialog.confirm.effect();
		}
	}

	// Handles the click event on the cancel button and calls the corresponding function if provided
	function handleClickCancel() {
		turnTheLightsUp(objectDialog);
		if (
			objectDialog.cancel &&
			typeof objectDialog.cancel.effect === "function"
		) {
			objectDialog.cancel.effect();
		}
	}
}
function darkModeOn() {
	body.classList.add('dark-mode');
	renderingOutput.classList.add('dark-mode');
}

function darkModeOff() {
	body.classList.remove('dark-mode');
	renderingOutput.classList.remove('dark-mode');
}

function toggleDarkMode() {
	body.classList.toggle('dark-mode');
	renderingOutput.classList.toggle('dark-mode');
}

async function refreshPopup() {
	await Persistence.reloadPersistence(true);
	if (true == persistence.settings.darkMode)
		darkModeOn();
	else
		darkModeOff();
	body.classList.remove("hidden");
	//Messaging.sendMessageToBackground(REQUEST.GET_MY_FRAME_ID, (response) => {
	//	Globals.currentContentID = response;

	//	BROWSER.tabs.query({ active: true }, function (tabs) {
	//		try {
	//			if (0 < tabs.length && tabs[0].url) {
	//				var startupURL = tabs[0].url;
	//			}
	//		} catch (error) {
	//			LogMessage(LOG_TYPE.DEBUG, "error in getting url in popup.js:", error);
	//		}
	//		LogMessage(LOG_TYPE.DEBUG, "popup.js starting up", startupURL, Globals.currentContentID);
	//	});
	//});


	updateViewState();
	updateSettings();
	updateAuditLog();
	updateErrorLog();

	Persistence.getStorageUsed().then(message => {
		const manifest = BROWSER.runtime.getManifest();

		easteregg.innerHTML =
			'Thanks for choosing GPAL!!<br>' +
			'OttoMagic v' + manifest.version + '<br>' +
			message;
	});
}

/***************************
 * Iniitalize persistence, and handlers
 ***************************/
init();