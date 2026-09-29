const onPageToast = false;  // for debugging, displays toast in each content script, or (false) bubbles it to the top document

function getTimestamp() {
    const options = {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    };
    const date = new Date();
    return date.toLocaleString(undefined, options).replace(',', '');
}
function LogMessage(logType, message, data, data2) {
    let newData = true == isString(data) ? data.toString() : JSON.stringify(data, null, 2); // too much data to stringify?
    let newData2 = true == isString(data2) ? data2.toString() : JSON.stringify(data2, null, 2); // too much data to stringify?
    let toastMessage = message;

    let newMessage = message.replaceAll('<strong class="gpaltoast-strong">', '').replaceAll('</strong>', '').replaceAll('<br>', '\n');
    if (true == Globals.debug)
        console.log(message, data, data2);
    //if (persistence)    // not sure why we would never have this set, but
    if (newData2) {
        /*if (LOG_TYPE.DEBUG === logType && persistence && true == persistence.settings.debugMessages)
            console.log(Globals.currentContentID + ': ' + (LOG_TYPE.RECORDED === logType ? 'RECORDED: ' : '') + newMessage, newData, newData2);

        if (LOG_TYPE.ERROR === logType || LOG_TYPE.CRITICAL === logType)
            console.error(Globals.currentContentID + ': ' + newMessage, newData, newData2);

        showToast(logType, toastMessage + `<br>[${newData}]<br>[${newData2}]` + (persistence && true == persistence.settings.debugMessages ? `<br>ContentID: ${Globals.currentContentID}` : ''));
    } else if (newData) {
        if (LOG_TYPE.DEBUG === logType && persistence && true == persistence.settings.debugMessages)
            console.log(Globals.currentContentID + ': ' + (LOG_TYPE.RECORDED === logType ? 'RECORDED: ' : '') + newMessage, newData);

        if (LOG_TYPE.ERROR === logType || LOG_TYPE.CRITICAL === logType)
            console.error(Globals.currentContentID + ': ' + newMessage, newData);

        showToast(logType, toastMessage + `<br>[${newData}]` + (persistence && true == persistence.settings.debugMessages ? `<br>ContentID: ${Globals.currentContentID}` : ''));
    } else {
        if (LOG_TYPE.DEBUG === logType && persistence && true == persistence.settings.debugMessages)
            console.log(Globals.currentContentID + ': ' + (LOG_TYPE.RECORDED === logType ? 'RECORDED: ' : '') + newMessage);

        if (LOG_TYPE.ERROR === logType || LOG_TYPE.CRITICAL === logType)
            console.error(Globals.currentContentID + ': ' + newMessage);

        showToast(logType, toastMessage + (persistence && true == persistence.settings.debugMessages ? `<br> ContentID: ${Globals.currentContentID}` : ''));*/
    }

    function isString(param) {
        return typeof param === 'string';
    }
}

function showNotification(title, message, type = 'basic') {
    // "basic": For a basic notification, which is the default value.
    // "image": For a notification with an image.
    // "list": For a notification with a list of items.
    // "progress": For a notification with a progress bar.
    // notifications are kinda lame, they are not stacking for some reason not yet coded... so stick to on-page, top level doc
    BROWSER.notifications.create({
        type: type,
        iconUrl: BROWSER.runtime.getURL("../images/robot-128.png"),
        title: title,
        message: message.replaceAll('<strong class="gpaltoast-strong">', '').replaceAll('</strong>', '').replaceAll('<br>', '\n')
    });
}

