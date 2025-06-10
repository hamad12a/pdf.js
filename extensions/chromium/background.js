/*
Copyright 2012 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

"use strict";

// Import all necessary background functionality
// Note: In service workers, we can't use importScripts for ES modules,
// so we'll include all code directly or use dynamic imports

// ========================
// From pdfHandler.js
// ========================

var VIEWER_URL = chrome.runtime.getURL("content/web/viewer.html");

function getViewerURL(pdf_url) {
  // |pdf_url| may contain a fragment such as "#page=2". That should be passed
  // as a fragment to the viewer, not encoded in pdf_url.
  var hash = "";
  var i = pdf_url.indexOf("#");
  if (i > 0) {
    hash = pdf_url.slice(i);
    pdf_url = pdf_url.slice(0, i);
  }
  return VIEWER_URL + "?file=" + encodeURIComponent(pdf_url) + hash;
}

/**
 * @param {Object} details First argument of the webRequest.onHeadersReceived
 *                         event. The property "url" is read.
 * @returns {boolean} True if the PDF file should be downloaded.
 */
function isPdfDownloadable(details) {
  if (details.url.includes("pdfjs.action=download")) {
    return true;
  }
  // Display the PDF viewer regardless of the Content-Disposition header if the
  // file is displayed in the main frame, since most often users want to view
  // a PDF, and servers are often misconfigured.
  // If the query string contains "=download", do not unconditionally force the
  // viewer to open the PDF, but first check whether the Content-Disposition
  // header specifies an attachment. This allows sites like Google Drive to
  // operate correctly (#6106).
  if (details.type === "main_frame" && !details.url.includes("=download")) {
    return false;
  }
  var contentDisposition = "";
  var cdheader;
  if (details.responseHeaders) {
    cdheader = details.responseHeaders.find(
      function (header) {
        return header.name.toLowerCase() === "content-disposition";
      }
    );
  }
  if (cdheader) {
    contentDisposition = cdheader.value;
  }
  return /^attachment/i.test(contentDisposition);
}

/**
 * Get header from response headers array by name
 */
function getHeaderFromHeaders(headers, headerName) {
  if (!headers) return null;
  return headers.find(function(header) {
    return header.name.toLowerCase() === headerName.toLowerCase();
  });
}

/**
 * Check if the response is a PDF file
 */
function isPdfFile(details) {
  var header = getHeaderFromHeaders(details.responseHeaders, "content-type");
  if (header) {
    var headerValue = header.value.toLowerCase().split(";", 1)[0].trim();
    if (headerValue === "application/pdf") {
      return true;
    }
    if (headerValue === "application/octet-stream") {
      if (details.url.toLowerCase().indexOf(".pdf") > 0) {
        return true;
      }
      var cdHeader = getHeaderFromHeaders(
        details.responseHeaders,
        "content-disposition"
      );
      if (cdHeader && /\.pdf(["']|$)/i.test(cdHeader.value)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Force download by setting Content-Disposition: attachment
 */
function getHeadersWithContentDispositionAttachment(details) {
  var headers = details.responseHeaders.slice(); // Copy headers
  var cdHeader = getHeaderFromHeaders(headers, "content-disposition");
  if (!cdHeader) {
    cdHeader = { name: "Content-Disposition", value: "attachment" };
    headers.push(cdHeader);
  } else {
    cdHeader.value = "attachment" + cdHeader.value.replace(/^[^;]+/i, "");
  }
  return { responseHeaders: headers };
}

// Store referer for preserve-referer functionality  
var savedReferers = new Map();

/**
 * Get the content settings API.
 */
function getContentSettings() {
  return new Promise(function (resolve) {
    chrome.contentSettings.plugins.get(
      {
        primaryUrl: "http://drive.google.com/*",
        secondaryUrl: "drive.google.com",
        resourceIdentifier: { id: "adobe-flash-player" },
        incognito: false,
      },
      function () {
        chrome.contentSettings.plugins.get(
          {
            primaryUrl: "file://*/*",
            secondaryUrl: "file://*/*",
            resourceIdentifier: { id: "adobe-flash-player" },
            incognito: false,
          },
          function () {
            resolve(chrome.contentSettings && chrome.contentSettings.plugins);
          }
        );
      }
    );
  });
}

// ========================
// From preserve-referer.js  
// ========================

// Store referer for preserve-referer functionality  
var savedReferers = new Map();

function saveReferer(details) {
  savedReferers.set(details.url, details.url);
}

/**
 * @param {Object} details - webRequest details
 * @returns {Object|undefined} - onBeforeSendHeaders response
 */
function onBeforeSendHeaders(details) {
  if (details.url.indexOf(chrome.runtime.id) === -1) {
    return;
  }
  var i = details.url.indexOf("#");
  if (i === -1) {
    return;
  }
  var viewer_param_url = details.url.slice(i + 1);
  var j = viewer_param_url.indexOf("&");
  if (j !== -1) {
    // Ignore viewer hash parameters.
    viewer_param_url = viewer_param_url.slice(0, j);
  }
  if (!/^file=/.test(viewer_param_url)) {
    return;
  }
  var original_url = decodeURIComponent(viewer_param_url.slice(5));
  var referer_header = details.requestHeaders.find(function (header) {
    return header.name.toLowerCase() === "referer";
  });
  if (!referer_header) {
    referer_header = { name: "Referer", value: original_url };
    details.requestHeaders.push(referer_header);
  } else {
    referer_header.value = original_url;
  }
  return { requestHeaders: details.requestHeaders };
}

// ========================  
// From pageAction/background.js
// ========================

/**
 * @param {number} tabId - ID of tab where the page action will be shown.
 * @param {string} url - URL to be displayed in page action.
 */
function showPageAction(tabId, displayUrl) {
  // rewriteUrlClosure in viewer.js ensures that the URL looks like
  // chrome-extension://[extensionid]/http://example.com/file.pdf
  var url = /^chrome-extension:\/\/[a-p]{32}\/([^#]+)/.exec(displayUrl);
  if (url) {
    url = url[1];
    chrome.action.setPopup({
      tabId,
      popup: "/pageAction/popup.html?file=" + encodeURIComponent(url),
    });
    // In MV3, actions are always visible. We enable the action for this tab.
    chrome.action.enable(tabId);
  } else {
    console.log("Unable to get PDF url from " + displayUrl);
  }
}

// ========================
// From telemetry.js
// ========================

// This module sends the browser and extension version to a server, to
// determine whether it is safe to drop support for old Chrome versions in
// future extension updates.
//
// The source code for the server is available at:
// https://github.com/Rob--W/pdfjs-telemetry
var LOG_URL = "https://pdfjs.robwu.nl/logpdfjs";

// The minimum time to wait before sending a ping, so that we don't send too
// many requests even if the user restarts their browser very often.
// We want one ping a day, so a minimum delay of 12 hours should be OK.
var MINIMUM_TIME_BETWEEN_PING = 12 * 36e5;

function getLoggingPref(callback) {
  chrome.storage.local.get("disable_telemetry", function (items) {
    callback(items.disable_telemetry);
  });
}

function setLoggingPref(value, callback) {
  chrome.storage.local.set({ disable_telemetry: value }, callback);
}

function maybeSendPing() {
  getLoggingPref(function (didOptOut) {
    if (didOptOut) {
      return;
    }
    chrome.storage.local.get("last_ping_time", function (items) {
      var currentTime = Date.now();
      var timeSinceLastPing = currentTime - (items.last_ping_time || 0);
      if (timeSinceLastPing >= MINIMUM_TIME_BETWEEN_PING) {
        sendPing(currentTime);
      }
    });
  });
}

function sendPing(currentTime) {
  var request = new XMLHttpRequest();
  request.open("POST", LOG_URL, true);
  request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
  request.onload = function () {
    chrome.storage.local.set({ last_ping_time: currentTime });
  };
  
  var browserVersion = /Chrome\/([0-9.]+)/.exec(navigator.userAgent);
  browserVersion = browserVersion ? browserVersion[1] : "unknown";
  
  var postData = "extension_version=" + encodeURIComponent(chrome.runtime.getManifest().version) +
                "&browser_version=" + encodeURIComponent(browserVersion);
  request.send(postData);
}

// Initialize telemetry (only for official extension)
function initTelemetry() {
  // In MV3, we can check incognito context differently
  // For now, we'll skip the incognito check since service workers 
  // don't have the same context concept
  
  if (chrome.runtime.id !== "oemmndcbldboiebfnladdacbdfmadadm") {
    // Only send telemetry for the official PDF.js extension.
    console.warn("Disabled telemetry because this is not an official build.");
    return;
  }

  maybeSendPing();
  setInterval(maybeSendPing, 36e5);
}

// ========================
// Main event listeners and initialization
// ========================

// Initialize when service worker starts
initTelemetry();

// Handle messages from content scripts
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message === "showPageAction" && sender.tab) {
    showPageAction(sender.tab.id, sender.tab.url);
    sendResponse({success: true}); // Acknowledge the message
    return true; // Keep message channel open for async response
  }
  
  // Handle other message types if needed
  if (message && typeof message === 'object') {
    // Handle file access permission check
    if (message.action === "isAllowedFileSchemeAccess") {
      // In MV3, check if file scheme access is allowed
      try {
        chrome.extension.isAllowedFileSchemeAccess(sendResponse);
      } catch (e) {
        // Fallback: assume file access is allowed if API fails
        console.warn("isAllowedFileSchemeAccess API error:", e);
        sendResponse(true);
      }
      return true; // Keep channel open for async response
    }
    
    // Handle opening extensions page for file access
    if (message.action === "openExtensionsPageForFileAccess") {
      var url = "chrome://extensions/?id=" + chrome.runtime.id;
      if (message.data && message.data.newTab) {
        chrome.tabs.create({
          windowId: sender.tab.windowId,
          index: sender.tab.index + 1,
          url: url,
          openerTabId: sender.tab.id,
        });
      } else {
        chrome.tabs.update(sender.tab.id, {
          url: url,
        });
      }
      sendResponse({success: true});
      return true;
    }
    
    // For other object messages, send acknowledgment to prevent port closure
    sendResponse({received: true});
    return true;
  }
  
  // Return false for unhandled messages to close the port immediately
  return false;
});

// Handle web requests for PDF files - MV3 non-blocking approach
chrome.webRequest.onHeadersReceived.addListener(
  function (details) {
    if (details.method !== "GET") {
      return undefined;
    }
    if (!isPdfFile(details)) {
      return undefined;
    }
    if (isPdfDownloadable(details)) {
      // Force download by ensuring that Content-Disposition: attachment is set
      return getHeadersWithContentDispositionAttachment(details);
    }

    // For PDF content-type detection, redirect via tabs API
    var viewerUrl = getViewerURL(details.url);
    saveReferer(details);
    
    // Use chrome.tabs.update for redirection - this should work before the PDF loads
    if (details.tabId > 0) {
      chrome.tabs.update(details.tabId, { url: viewerUrl });
    }
    
    return undefined;
  },
  {
    urls: ["<all_urls>"],
    types: ["main_frame"],
  },
  ["responseHeaders"]
);

// Preserve referer header for PDF requests - Disabled in MV3
// Cannot modify headers without webRequestBlocking permission
/*
chrome.webRequest.onBeforeSendHeaders.addListener(
  onBeforeSendHeaders,
  {
    urls: [chrome.runtime.getURL("*")],
  },
  ["blocking", "requestHeaders"]
);
*/

// Handle navigation events for tab updates
chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId === 0) {
    // Main frame navigation - disable action for this tab
    // Note: chrome.action.hide() is not available in MV3
    // Using disable instead which sets the action to inactive state
    chrome.action.disable(details.tabId);
  }
});
