/*
Code is used to create selctors, a pattern used to select elements in an HTML or XML document based
on their attributes, tag names, and relationships with other elements.
*/

class SelectorSet {
    css;
    xPaths;
    xPaths;
    fullXPath;
    simplifiedXPath;
    value;
    text;
    alt;    // for deag-n-drop items or items that reorder, the only diff MIGHT be ALT, possibly diff imagedata - so include this to identify uniqueness
    matchvalue;
    matchtext;
    matchhref;
    matchsrc;
    matchplaceholder;
    tagName; // HTML tag name
    selectorName; // Name of the selector
    imageData; // Image string data of element
    clientRects; // Parent coordinates of element
    boundingRect; // Element coordinates
    pageURL; //keep track of what web page the element is 
    parentURL;
    textTruncated;
    top;
    left;
    width;
    height;
    absoluteTop;
    absoluteLeft;
    scrollX;    // scroll bar X
    scrollY;    // scroll bar Y
    offsetX;    // offset to click in anchor or other element, starting point in element for drag-and-drop
    offsetY;    // offset to click in anchor or other element, starting point in element for drag-and-drop
    deltaX;    // this is the offset to move the mouse from picking up the element
    deltaY;    // this is the offset to move the mouse from picking up the element
    // Create an empty array to store the attributes of each element
    attributes;


    constructor(objectSourceElement, modifiableObjectTagIndices, incrementIndexCount, action = workflowActions.PlaceHolder) {
        // Create an empty array to store the attributes of each element
        this.attributes = [];
        const attributesObject = {};

        // Get all attributes of the current element
        const attributes = objectSourceElement.attributes;

        // Iterate over the attributes
        for (let i = 0; i < attributes.length; i++) {
            // Extract the attribute name and value
            const attributeName = attributes[i].name;
            const attributeValue = attributes[i].value;

            // Add the attribute name and value to the attributesObject
            if ('href' !== attributeName)
                attributesObject[attributeName] = attributeValue.replaceAll('gpal-box-shadow-line-element', '');
        }

        // Add the attributesObject to the elementAttributes array
        this.attributes.push(attributesObject);

        this.css = this.createSelectorOrThrow(objectSourceElement, "css").replaceAll('.gpal-box-shadow-line-element', '');   // somehow, even tho it hasn't been added yet, it comes up...

        // now returned when we create 'xpath', but will retain it
        this.fullXPath = this.createSelectorOrThrow(objectSourceElement, "full xpath");

        this.simplifiedXPath = Globals.simplifiedXPath;
        this.xPaths = this.createSelectorOrThrow(objectSourceElement, "xpath");

        this.xPaths.push(this.findBestMatch(this.fullXPath, objectSourceElement));
        this.xPaths.push(this.findBestMatch(this.simplifiedXPath, objectSourceElement));
        this.xPaths = this.xPaths.filter(item => item && typeof item.xpath !== 'undefined' && item.xpath !== null);   // TODO: CAVEAT: why are we pushing nulls and uindefined? fix that
        // dedupe
        this.xPaths = [...new Map(this.xPaths.map(v => [v.xpath, v])).values()];

        // Find the best XPath by prioritizing the sort for the element usage, interaction or data extraction

        // if element is clickable or editable, then we want the unique xpaths first
        if (true == isElementClickable(objectSourceElement) || true == isElementEditable(objectSourceElement))
            this.xPaths.sort((a, b) => (b ? (a ? a.matchedElements - b.matchedElements : -1) : 1));
        //            xpaths.sort((a, b) => { if (a && b) parseInt(a.matchedElements) - parseInt(b.matchedElements) });
        else if (false == isElementClickable(objectSourceElement) && false == isElementEditable(objectSourceElement))
            // if the element is not clickable or editable, then we want that as a data point and we want the generic paths first
            this.xPaths.sort((a, b) => (a ? (b ? b.matchedElements - a.matchedElements : -1) : 1));
//            xpaths.sort((a, b) => { if (a && b) parseInt(b.matchedElements) - parseInt(a.matchedElements) });


        // let us evaluate the selectors and return them in order, xpaths is already sorted, we need to add fuil and simplified

        this.value = objectSourceElement.value;
        // get our text, then decide if we have to truncate it
        let tempText = objectSourceElement.innerText || objectSourceElement.value || objectSourceElement.textContent || '';

        if (tempText && true == persistence.truncateText && persistence.settings.truncateTextTo < tempText.length && workflowActions.FillInFrom !== action)
            this.textTruncated = true;
        else
            this.textTruncated = false;
        // CAVEAT: do not truncate fillinfrom text, only other elements - why would someone click an element they don't want, except to grab text?
        this.text = true == this.textTruncated && workflowActions.FillInFrom !== action ? tempText.slice(0, persistence.settings.truncateTextTo + 1) : tempText;
        this.alt = objectSourceElement.alt;

        this.href = objectSourceElement.href;
        this.src = objectSourceElement.src;
        this.placeholder = objectSourceElement.placeholder;
        this.tagName = objectSourceElement.tagName.replaceAll("-", ""); // remove dashes from tag name
        if (incrementIndexCount) {
            let selectorPrefix;
            if (objectSourceElement.id && persistence.settings.useIDForName)
                selectorPrefix = objectSourceElement.id.replaceAll('-', '');
            else
                selectorPrefix = this.tagName.replaceAll('-', '').toLowerCase();

            let idx = modifiableObjectTagIndices[selectorPrefix] || 0;
            this.selectorName = selectorPrefix + "Selector" + idx++; // identifier for element
            modifiableObjectTagIndices[selectorPrefix] = idx;
        }
        this.imageData = ""; // empty image data

        var clientRects = objectSourceElement.getClientRects();
        var jsonArray = Array.from(clientRects).map(rect => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left
        }));

        var jsonString = JSON.stringify(jsonArray);
        this.clientRects = JSON.parse(jsonString);

        jsonArray = Array.from(this.xPaths).map(xpath => ({
            xpath: xpath.xpath,
            matchedElements: xpath.matchedElements
        }));
        jsonString = JSON.stringify(jsonArray);
        this.xPaths = JSON.parse(jsonString);

        this.boundingRect = JSON.parse(JSON.stringify(objectSourceElement.getBoundingClientRect()));
        if ('IFRAME' === this.tagName || 0 === Globals.currentContentID) {   // top level document is frameid = 0, don't use the scroll, it's already accounted for
            this.absoluteLeft = this.left = this.boundingRect.left;// + objectSourceElement.offsetLeft - window.scrollX;
            this.absoluteTop = this.top = this.boundingRect.top;// + objectSourceElement.offsetTop - window.scrollY;
        } else
            if (objectSourceElement.shadowRoot) {
                this.absoluteLeft = this.left = objectSourceElement.offsetLeft;
                this.absoluteTop = this.top = objectSourceElement.offsetTop;
            } else {
                this.absoluteLeft = this.left = this.boundingRect.left - window.scrollX;
                this.absoluteTop = this.top = this.boundingRect.top - window.scrollY;
            }
        this.width = objectSourceElement.offsetWidth;
        this.height = objectSourceElement.offsetHeight;

        this.scrollX = window.scrollX;
        this.scrollY = window.scrollY;

        //LogMessage(LOG_TYPE.DEBUG, 'boundingRect:', this.boundingRect);
        //LogMessage(LOG_TYPE.DEBUG, 'clientRects:', this.clientRects);

        if (true == incrementIndexCount) {  // for real, we are remebering this one, not just comparison
            // flash a dashed outline around the object just saved for user feedback
            objectSourceElement.classList.add(HIGHLIGHTED_BOX_SHADOW_ELEMENT_CLASS);

            setTimeout(() => {
                objectSourceElement.classList.remove(HIGHLIGHTED_BOX_SHADOW_ELEMENT_CLASS);
            }, 500);
        }

        this.pageURL = window.location.href; //get the URL of the iframe or page
        if (Globals.currentUrl)
            this.parentURL = Globals.currentUrl;    // we should've gotten a broadcast with this, or we are frameid 0 and set it ourselves.
        else {
            Messaging.sendMessageToBackground(REQUEST.GET_TOP_LEVEL_URL, (url) => {
                this.parentURL = Globals.currentUrl = url;
            });
        }
        this.deltaX = this.deltaY = this.offsetX = this.offsetY = 0;
    }

    findBestMatch(xpath, element) {
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
        return { xpath: bestXPath, matchedElements: matchedElements };
    }

    generateXPath(element) {
        let matchedElements = 999;
        let bestXPath = null;

        // for some reason unable to access this using 'this', i think i have to assign this to another variable so it works nested, otherwise, it is declared twice
        function findBestMatch(xpath, element) {
            var matchingElements;
            try {
                matchingElements = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            } catch (error) {
                return null;
            }
            for (let i = 0; i < matchingElements.snapshotLength; i++) {
                if (matchingElements.snapshotItem(i) === element) {
                    if (matchingElements.snapshotLength < matchedElements) {
                        matchedElements = matchingElements.snapshotLength;
                    }
                }
            }
            if (999 !== matchedElements)
                return { xpath: xpath, matchedElements: matchedElements };
            else
                return null;
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
            } catch (error) {}
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

                if (999 !== matchedElements)
                    return { xpath: bestXPath, matchedElements: matchedElements };
            } catch (error) {}
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
            } catch (error) {}

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

        const xpaths = [
            getElementWithId(element),
            findAnchorAndCreateRelativeXPath(element),
            getElementByPosition(element),
            getElementByText(element),
            getElementWithAttributes(element),
        ];

        return xpaths;
    }

      //generates a selector string for a given HTML element in a specified format (either CSS or XPath)
    createSelectorOrThrow(objectElement, stringSelectorType) {
        // Throw an error if the `objectElement` parameter is not an object.
        if (typeof objectElement !== "object") {
            throw "Parameter 'objectElement' must be of type object.";
        }

        // Throw an error if the `stringSelectorType` parameter is not a non-empty string.
        if (
            typeof stringSelectorType !== "string" ||
            stringSelectorType.trim().length === 0
        ) {
            throw "Parameter 'stringSelectorType' must be of type string, must not be empty, and must not consist entirely of white space.";
        }

        // Initialize variables for the identifier and indexing expressions, and the separator expression.
        let pairedIdentifierExpressions = [];
        let pairedIndexingExpressions = [];
        let separatorExpression = "";

        // Depending on the value of `stringSelectorType`, assign values to the above variables.
        switch (stringSelectorType) {
            case "css":
                pairedIdentifierExpressions = ["#", ""];
                pairedIndexingExpressions = [":nth-of-type(", ")"];
                separatorExpression = " > ";
                break;

            case "xpath":
                return this.generateXPath(objectElement);

            case "full xpath":
                pairedIdentifierExpressions = ['//*[@id="', '"]'];
                pairedIndexingExpressions = ["[", "]"];
                separatorExpression = "/";
                break;

            default:
                throw "Parameter 'stringSelectorType' must be among {css, xpath, full xpath}.";
        }

        // Get the current element.
        let me = objectElement;

        // Get the tag name of the current element in lowercase.
        let myLowerCaseTagName;
        
        if (me && me.tagName)
            myLowerCaseTagName = me.tagName.toLowerCase();
        else
            myLowerCaseTagName = 'unknown';

        // If the current element has an ID, use the ID to create a CSS selector with highest specificity.
        let myId = me.id;
        if (myId) {
            // 1st-tier CSS specificity: an element with an id, which is unique by definition

            if (stringSelectorType !== "full xpath") {
                return (
                    pairedIdentifierExpressions[0] + myId + pairedIdentifierExpressions[1]
                );
            }
        }

        // Get the parent element of the current element.
        let myParent = me.parentElement;

        // If there is no parent element, return either the tag name or the root node, depending on the `stringSelectorType`.
        if (!myParent) {
            // last-resort specificity: the root node

            if (stringSelectorType === "css") {
                return myLowerCaseTagName;
            } else {
                return separatorExpression + myLowerCaseTagName;
            }
        }

        // Recursively call the `createSelectorOrThrow` function on the parent element, to get its selector.
        let myParentSelector = "";
        try {
            myParentSelector = this.createSelectorOrThrow(
                myParent,
                stringSelectorType
            );
            // Catch any stack overflow errors and rethrow them with a more specific message.
        } catch (error) {
            if (error.message === "Maximum call stack size exceeded") {
                error.message =
                    "Maximum call stack size exceeded, while generating selector.";
                error.stack = error.message;
            }
            throw error;
        }
        // Get the index of the current element among its siblings.
        let myTagIndex = this.tagIndexAmongSiblings(me);

        // If the current element is the only one of its tag name among its siblings, use a CSS selector with higher specificity.
        if (myTagIndex === null) {
            return myParentSelector + separatorExpression + myLowerCaseTagName;
        }

        // Otherwise, create a CSS selector using the tag name and either a unique class name or a unique pseudoclass.
        let mySelector = myLowerCaseTagName;

        // The `mySelector` variable is set to the lowercased tag name of `me`, followed by additional selector expressions
        // depending on the selector type and the specificity of `me`.
        if (
            stringSelectorType === "css" &&
            this.isClassListUniqueAmongSiblings(me)
        ) {
            // 2nd-tier CSS specificity: an element with a unique class list

            // If `me` has a unique class list among its siblings, add each class name to `mySelector` with a period separator.
            for (const CLASS_NAME of me.classList) {
                mySelector += "." + CSS.escape(CLASS_NAME);
            }
        } else {
            // 3rd-tier CSS specificity: an element with a unique pseudoclass list

            // Add an indexing expression to `mySelector` indicating the tag index of `me` among its siblings.
            mySelector +=
                pairedIndexingExpressions[0] +
                myTagIndex +
                pairedIndexingExpressions[1];
        }

        return myParentSelector + separatorExpression + mySelector;
    }

    static getCss(element) {
        const inst = Object.create(SelectorSet.prototype);
        return inst.createSelectorOrThrow(element, "css")
                   .replaceAll('.gpal-box-shadow-line-element', '');
    }

    // This function below checks whether an element's class list is unique among its siblings.
    isClassListUniqueAmongSiblings(objectElement) {
        // Throw an error if the input parameter is not an object.
        if (typeof objectElement !== "object") {
            throw "Parameter 'objectElement' must be of type object.";
        }

        let me = objectElement;
        let myParent = me.parentElement;
        if (!myParent) {
            throw "isClassListUniqueAmongSiblings(): Element has unexpectedly been detached from its parent.";
        }

        let mySiblings = myParent.children;
        if (!mySiblings) {
            throw "isClassListUniqueAmongSiblings(): Element has unexpectedly been detached from its siblings.";
        }

        // My classes, without our dashed outline.
        let myClasses = Array.from(me.classList || []).filter(c => HIGHLIGHTED_BOX_SHADOW_ELEMENT_CLASS !== c);

        // tag.class1.class2 matches every sibling of my tag that has all my classes, whatever else it has, so the
        // classes name me alone only when I have some and no sibling of my tag has all of them. With no classes,
        // the selector is the bare tag, which matches every sibling of my tag.
        let isMyClassListUniqueAmongSiblings = 0 < myClasses.length;
        for (const MY_SIBLING of mySiblings) {
            if (MY_SIBLING !== me && MY_SIBLING.tagName === me.tagName &&
                myClasses.every(c => MY_SIBLING.classList.contains(c))) {
                isMyClassListUniqueAmongSiblings = false;
                break;
            }
        }

        return isMyClassListUniqueAmongSiblings;
    }

    //The function determines the position of the element among its siblings with the same tag name.
    tagIndexAmongSiblings(objectElement) {
        // Make sure the parameter is an object
        if (typeof objectElement !== "object") {
            throw "Parameter 'objectElement' must be of type object.";
        }

        // Get the object element and its parent element
        let me = objectElement;
        let myParent = me.parentElement;

        // If the object element doesn't have a parent, throw an error
        if (!myParent) {
            throw "tagIndexAmongSiblings(): Element has unexpectedly been detached from its parent.";
        }

        // If there are no siblings, throw an error
        let mySiblings = myParent.children;
        if (!mySiblings) {
            throw "tagIndexAmongSiblings(): Element has unexpectedly been detached from its siblings.";
        }

        // Initialize variables to track the index of the object element among its siblings
        let myIndex = null;
        let numberOfSiblingsWhoHaveTheSameTagNameAsMe = 0;

        // Loop through each sibling of the parent element
        for (const MY_SIBLING of mySiblings) {
            let mySiblingTagName = MY_SIBLING.tagName;
            if (mySiblingTagName === me.tagName) {
                numberOfSiblingsWhoHaveTheSameTagNameAsMe++;
            }

            if (MY_SIBLING === me) {
                myIndex = numberOfSiblingsWhoHaveTheSameTagNameAsMe;
            }
        }

        // If there are multiple siblings with the same tag name, return the index of the object element
        if (numberOfSiblingsWhoHaveTheSameTagNameAsMe > 1) {
            return myIndex;
        } else {
            return null;
        }
    }

    elementsLikeMe(xpath) {
        const result = document.evaluate(this.simplifiedXPath, document, null, XPathResult.ANY_TYPE, null);

        // Count the number of matching elements
        let count = 0;
        let node = result.iterateNext();
        while (node) {
            count++;
            node = result.iterateNext();
        }
    }

   
    getSimplifiedCSS(simplifiedXPath) {
        // Split the simplified XPath by '/' to get individual node names
        const nodeNames = simplifiedXPath.split('/').filter(Boolean);

        // Generate the simplified CSS selector
        const simplifiedCSS = nodeNames.map((nodeName) => nodeName.split('[')[0]).join(' > ');

        return simplifiedCSS;
    }

    // find elements that match this generic xpath
    static findMatchingXPaths(originalXPath) {
        const matchingData = {
            matches: [],
            simplifiedXPath: null,
            count: 0,
        };

        // first take off every index
        Globals.simplifiedXPath = getSimplifiedXPath(originalXPath);

        // potential matches
        const potentialMatchingNodes = document.evaluate(Globals.simplifiedXPath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);

        let element;
        let count = 0;

        const potentialMatchingElements = [];

        while (element = potentialMatchingNodes.iterateNext()) {
            potentialMatchingElements.push(element);
            count++;
        }

        let OriginalElement = findNodeByXpath(originalXPath);

        // this step eliminates any elements that don't have the same classes as our original element
        // if there are no classes, then they are all the same?
        let filteredMatches = filterElementsByClasses(potentialMatchingElements, OriginalElement.node);

        // if we have 1, that is te OGelement, so no matches
        if (1 < filteredMatches.length) {
            // we do have at least one match, so take the first one and last one and try to come up with the most precise generic xpath we can
            let lvalue = filteredMatches[filteredMatches.length - 1]; // last match
            let rvalue = filteredMatches[0]; // first match
            let xpath1 = new SelectorSet(lvalue, persistence.indices, false).fullXPath;
            let xpath2 = new SelectorSet(rvalue, persistence.indices, false).fullXPath;
            Globals.simplifiedXPath = simplifyXPath(xpath1, xpath2);    // just simplifies one parent node, typically a list item <li>
        }   // else, we use the totally stripped down generic xpath

        matchingData.matches = filteredMatches;
        matchingData.count = filteredMatches.length;
        matchingData.simplifiedXPath = Globals.simplifiedXPath;

        return matchingData;

        function getSimplifiedXPath(xpath) {
            return xpath.replace(/\[\d+\]/g, '');
        }

        function simplifyXPath(xpath1, xpath2) {
            // Split the XPaths by '/' to get individual node names
            const nodes1 = xpath1.split('/').filter(Boolean);
            const nodes2 = xpath2.split('/').filter(Boolean);

            // Find the first differing node index
            let diffIndex = -1;
            for (let i = 0; i < nodes1.length && i < nodes2.length; i++) {
                if (nodes1[i] !== nodes2[i]) {
                    diffIndex = i;
                    break;
                }
            }

            // If a differing node index is found, remove index from that node only
            if (diffIndex >= 0) {
                const simplifiedNodes = [...nodes1];
                simplifiedNodes[diffIndex] = simplifiedNodes[diffIndex].split('[')[0];
                return simplifiedNodes.join('/');
            }

            // If no differing node index is found, return the original XPath
            return xpath1;
        }

        // given an array of elements, remove anything not like the originalElement
        // this is used for highlighting similar elements
        // CAVEAT: but hides a not so great generic xpath generator :(
        // our xpath should only get us these elements
        function filterElementsByClasses(elements, originalElement) {
            let filteredElements;
            // how would we ever get a null original element? yet still we get this error: Cannot read properties of null (reading 'classList')
            if (originalElement && typeof originalElement.classList !== 'undefined' && originalElement.classList) {
                // Get the class list of the original element
                const originalClasses = Array.from(originalElement.classList);

                // Filter the elements array based on matching classes
                filteredElements = elements.filter(element => {
                    // Get the class list of the current element
                    if (element && element.classList) {
                        const currentClasses = Array.from(element.classList);

                        // Check if the current element has the same classes as the original element,
                        // ignoring classes starting with 'gpal'
                        return originalClasses.every(className => {
                            if (className.startsWith('gpal')) {
                                return true; // Ignore the 'gpal' class and move on to the next class
                            } else {
                                return currentClasses.includes(className);
                            }
                        });
                    } else
                        return false;
                });
            } else {
                filteredElements = elements.filter(element => {
                    // Get the class list of the current element
                    if (element.classList)
                        return false;
                    else
                        return true;
                });
            }
            return filteredElements;
        }
    }

    static findSelector(selectorName, returnIndex = false) {
        let retval;
        let retCount;
        let count = 0;

        persistence.selectorSets.forEach((selectorSet) => {
            if (selectorName === selectorSet.selectorName) {
                retval = selectorSet;
                retCount = count;
            }
            count++;
        });

        if (true == returnIndex)
            return retCount;
        else
            return retval;
    }

    static deleteSelector(selectorName) {
        persistence.selectorSets = persistence.selectorSets.filter((selectorSet) => {
            return selectorName !== selectorSet.selectorName;
        });
    }
}
