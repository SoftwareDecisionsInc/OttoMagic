let toastContainer;

function toastStrong(message) {
    return `<strong class="gpaltoast-strong">${message}</strong>`;
}

// handle showing toast to the active tab and topmost document
// if any content or background page calls showToast that is not the topmost document (iframe)
//   then a message is sent to the background who then sends it to the current tab and the topmost content will display it
// there is a fallback for background to display a desktop notification if anything fails
async function showToast(title, message, fromBG = false) {
    const timestamp = '\n' + getTimestamp();

    //if ((true == persistence.settings.infoMessages && (LOG_TYPE.RECORDED === title || LOG_TYPE.NOTICE === title))    // info
    //    || (true == persistence.settings.warnMessages && (LOG_TYPE.WARN === title || LOG_TYPE.RECORDING === title ))    // warn
    //    || (true == persistence.settings.errorMessages && LOG_TYPE.ERROR === title)    // error
    //    || (true == persistence.settings.debugMessages && LOG_TYPE.DEBUG === title)    // debug
    //    || LOG_TYPE.CRITICAL === title) {
        try {   // are we in content or background?
            let isTop = false;
            try {
                toastContainer = document.getElementById('gpaltoast-container');
            } catch (error) {   // we have no 'document' so we are BG
                fromBG = true;
            }
            try {
                isTop = (window.self === window.top);   // if window is defined, we are a content script
            } catch (error) {
                fromBG = true;  // no window, we are background script
            }

            // on-page toast indicates whethere each content will display toast or only the topmost 'document'
            if (false == onPageToast && !isTop) {
                if (false == fromBG && !isTop)    // my content is requesting to showtoast, i'm not top doc, so send msg to background
                    Messaging.sendMessageToBackground({ message: REQUEST.SHOW_TOAST, title: `${title}`, contents: `${message}` });
                else if (true == fromBG) {  // from background asking to show toast, forward to current tab [Globals.currentContentID is not important here, only for context menu clicks]
                    Messaging.messageATab(Globals.currentTabID, Globals.currentContentID, { message: REQUEST.SHOW_TOAST, title: `${title}`, contents: `${message}` });
                } else if (isTop) {     // content script recv'd message to show content and we are topmost
                    showTheToast(title, message + timestamp);
                }
            } else if (isTop) {
                showTheToast(title, message + timestamp);
            }   // if onpagelogging
        } catch (error) {
            // background toast: document doesn't exist
            // "basic": For a basic notification, which is the default value.
            // "image": For a notification with an image.
            // "list": For a notification with a list of items.
            //// "progress": For a notification with a progress bar.
            //BROWSER.notifications.create({
            //    type: 'basic',
            //    iconUrl: BROWSER.runtime.getURL("../images/robot-128.png"),
            //    title: title,
            //    message: message.replaceAll('<strong class="gpaltoast-strong">', '').replaceAll('</strong>', '').replaceAll('<br>', '\n') + timestamp
            //});
        }
    }

// TODO: BUG: on last toast to show, remove the container, it blocks on-page elements
function showTheToast(title, message, data) {
    /************ content: on-page toast ***************************/
    if (!toastContainer) {
        // Create the toast container if it doesn't exist
        toastContainer = document.createElement('div');
        toastContainer.id = 'gpaltoast-container';
        toastContainer.classList.add('gpaltoast-container');
        toastContainer.classList.add('bottom-right');
        document.body.appendChild(toastContainer);

    }

    let toastElement = document.createElement('div');
    toastElement.classList.add('gpaltoast', 'fade-in');

    let iconElement = document.createElement('img');
    iconElement.src = robot128; // base64, embedded in code
    iconElement.classList.add('gpaltoast-icon');

    let titleElement = document.createElement('div');
    titleElement.classList.add('gpaltoast-title');
    titleElement.textContent = title;

    let contentContainerElement = document.createElement('div');
    contentContainerElement.classList.add('gpaltoast-content-container');

    let messageElement = document.createElement('div');
    messageElement.classList.add('gpaltoast-message');
    messageElement.style.cssText += "white-space: nowrap;";
    messageElement.innerHTML = message.toString().replace(/\n/g, '<br>');

    let dataElement;
    if (data) {
        dataElement = document.createElement('div');
        dataElement.classList.add('gpaltoast-data');
        dataElement.innerHTML = data.toString().replace(/\n/g, '<br>');
    }

    let closeElement = document.createElement('a');    // close x-box
    closeElement.id = 'xbox' + Math.random().toString(36).substring(2);
    closeElement.classList.add('gpaltoast-close');
    closeElement.innerHTML = '&times;';
    closeElement.addEventListener('click', () => {
        toastElement.remove();
    });

    let closeContainerElement = document.createElement('div');
    closeContainerElement.classList.add('gpaltoast-close-container');
    closeContainerElement.appendChild(closeElement);

    contentContainerElement.appendChild(titleElement);
    contentContainerElement.appendChild(messageElement);
    if (data)
        contentContainerElement.appendChild(dataElement);

    toastElement.appendChild(iconElement);
    toastElement.appendChild(contentContainerElement);
    toastElement.appendChild(closeContainerElement);

    // Fade out the toast when mouse leaves
    toastElement.addEventListener('mouseleave', (event) => {
        fadeTimeout.push(setTimeout(() => {
            event.target.classList.remove('fade-in');
            event.target.classList.add('fade-out');
            fadeTimeout.push(setTimeout(() => {
                event.target.remove();
            }, 1000));

            const previousToasts = document.querySelectorAll('.gpaltoast');
            if (previousToasts.length > 0) {
                // Add fade-out class to the previous toasts
                previousToasts.forEach((toastElement) => {
                    toastElement.classList.remove('fade-in');
                    toastElement.classList.add('fade-out');
                    fadeTimeout.push(setTimeout(() => {
                        toastElement.remove();
                    }, 1000));
                });
            }
        }, 3000));
    });

    // Automatically remove the toast after a certain duration (e.g., 3 seconds)
    fadeTimeout.push(setTimeout(() => {
        toastElement.classList.remove('fade-in');
        toastElement.classList.add('fade-out');

        // Remove the toast after the fade-out animation
        fadeTimeout.push(setTimeout(() => {
            toastElement.remove();
        }, 1000));
    }, 3000));

    // Freeze all toasts when mouse enters one
    toastElement.addEventListener('mouseenter', (event) => {
        event.target.classList.remove('fade-out');
        for (const timer of fadeTimeout)
            clearTimeout(timer);
        fadeTimeout.length = 0;

        const previousToasts = document.querySelectorAll('.gpaltoast');
        if (previousToasts.length > 0) {
            // Add fade-out class to the previous toasts
            previousToasts.forEach((toastElement) => {
                toastElement.classList.remove('fade-out');
            });
        }
    });

    // Add the new toast at the beginning
    toastContainer.prepend(toastElement);
    /************ on-page toast ************************** */

}

// Hide the toast container and its contents
function hideToastContainer() {
    const toastContainer = document.querySelector('.gpaltoast-container');
    if (toastContainer)
        toastContainer.classList.add('hidden');
}

// Show the toast container and its contents
function showToastContainer() {
    const toastContainer = document.querySelector('.gpaltoast-container');
    if (toastContainer)
        toastContainer.classList.remove('hidden');
}
