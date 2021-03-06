/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Adblock Plus.
 *
 * The Initial Developer of the Original Code is
 * Wladimir Palant.
 * Portions created by the Initial Developer are Copyright (C) 2006-2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 * 2009-2010: Wang Congming <lovelywcm@gmail.com> modified for AutoProxy.
 *
 * ***** END LICENSE BLOCK ***** */

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

var RequestList = aup.RequestList;

/**
 * List of event handers to be registered. For each event handler the element ID,
 * event and the actual event handler are listed.
 * @type Array
 */
let eventHandlers = [
  ["aup-tooltip", "popupshowing", aupFillTooltip],
  ["aup-status-popup", "popupshowing", aupFillPopup],
  ["aup-toolbar-popup", "popupshowing", aupFillPopup],
  ["aup-command-settings", "command", function() { aup.openSettingsDialog(); }],
  ["aup-command-report", "command", report2gfwList],
  ["aup-command-sidebar", "command", toggleSidebar],
  ["aup-command-contextmenu", "command", function(e) {
    if (e.eventPhase == e.AT_TARGET) E("aup-status-popup").openPopupAtScreen(window.screen.width/2, window.screen.height/2, false); }],
  ["aup-command-modeauto", "command", function() { proxy.switchToMode('auto'); }],
  ["aup-command-modeglobal", "command", function() { proxy.switchToMode('global'); }],
  ["aup-command-modedisabled", "command", function() { proxy.switchToMode('disabled'); }],
  ["aup-status", "click", aupClickHandler],
  ["aup-toolbarbutton", "command", aupClickHandler],
  ["aup-toolbarbutton", "click", function(e) { if (e.button == 1) aupClickHandler(e); }]
];

/**
 * Stores the current value of showintoolbar preference (to detect changes).
 */
let currentlyShowingInToolbar = prefs.showintoolbar;

/**
 * Progress listener detecting location changes and triggering status updates.
 * @type nsIWebProgress
 */
let progressListener = null;

/**
 * Object implementing app-specific methods.
 */
let aupHooks = E("aup-hooks");

/**
 * Window of the detached list of blockable items (might be null or closed).
 * @type nsIDOMWindow
 */
let detachedSidebar = null;

aupInit();

function aupInit() {
  // Initialize app hooks
  for each (let hook in ["getBrowser", "addTab", "getToolbox", "getDefaultToolbar", "toolbarInsertBefore"])
  {
    let handler = aupHooks.getAttribute(hook);
    if (handler)
      aupHooks[hook] = new Function(handler);
  }

  // Process preferences
  aupReloadPrefs();

  // Copy the menu from status bar icon to the toolbar
  function fixId(node)
  {
    if (node.nodeType != node.ELEMENT_NODE)
      return node;

    if ("id" in node && node.id)
      node.id = node.id.replace(/aup-status/, "aup-toolbar");

    for (var child = node.firstChild; child; child = child.nextSibling)
      fixId(child);

    return node;
  }
  function copyMenu(to)
  {
    if (!to || !to.firstChild)
      return;

    to = to.firstChild;
    var from = E("aup-status-popup");
    for (var node = from.firstChild; node; node = node.nextSibling)
      to.appendChild(fixId(node.cloneNode(true)));
  }
  let paletteButton = aupGetPaletteButton();
  copyMenu(E("aup-toolbarbutton"));
  if (paletteButton != E("aup-toolbarbutton"))
    copyMenu(paletteButton);

  // Palette button elements aren't reachable by ID, create a lookup table
  let paletteButtonIDs = {};
  if (paletteButton)
  {
    function getElementIds(element)
    {
      if (element.hasAttribute("id"))
        paletteButtonIDs[element.getAttribute("id")] = element;

      for (let child = element.firstChild; child; child = child.nextSibling)
        if (child.nodeType == Ci.nsIDOMNode.ELEMENT_NODE)
          getElementIds(child);
    }
    getElementIds(paletteButton);
  }

  // Register event listeners
  window.addEventListener("unload", aupUnload, false);
  for each (let [id, event, handler] in eventHandlers)
  {
    let element = E(id);
    if (element)
      element.addEventListener(event, handler, false);

    if (id in paletteButtonIDs)
      paletteButtonIDs[id].addEventListener(event, handler, false);
  }

  prefs.addListener(aupReloadPrefs);
  filterStorage.addFilterObserver(aupReloadPrefs);
  filterStorage.addSubscriptionObserver(aupReloadPrefs);

  let browser = aupHooks.getBrowser();

  let dummy = function() {};
  let progressListener = {
    onLocationChange: aupReloadPrefs,
    onProgressChange: dummy,
    onSecurityChange: dummy,
    onStateChange: dummy,
    onStatusChange: dummy,
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener, Ci.nsISupportsWeakReference])
  };
  browser.addProgressListener(progressListener);

  // Make sure we always configure keys but don't let them break anything
  try {
    // Configure keys
    for (var key in prefs)
      if (key.match(/(.*)_key$/))
        aupConfigureKey(RegExp.$1, prefs[key]);
  } catch(e) {}

  // First run actions
  if (!("doneFirstRunActions" in prefs))
  {
    // Don't repeat first run actions if new window is opened
    prefs.doneFirstRunActions = true;

    // Show subscriptions dialog if the user doesn't have any subscriptions yet
    if (aup.versionComparator.compare(prefs.lastVersion, "0.0") <= 0)
      aup.runAsync(aupShowSubscriptions);
  }

  // Window-specific first run actions
  if (!("doneFirstRunActions " + window.location.href in prefs))
  {
    // Don't repeat first run actions for this window any more
    prefs["doneFirstRunActions " + window.location.href] = true;

    let lastVersion = aupHooks.getAttribute("currentVersion") || "0.0";
    if (lastVersion != prefs.currentVersion)
    {
      aupHooks.setAttribute("currentVersion", prefs.currentVersion);
      document.persist("aup-hooks", "currentVersion");

      let needInstall = (aup.versionComparator.compare(lastVersion, "0.0") <= 0);
      if (!needInstall)
      {
        // Before version 1.1 we didn't add toolbar icon in SeaMonkey, do it now
        needInstall = aup.versionComparator.compare(lastVersion, "1.1") < 0 &&
                      Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).ID == "{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}";
      }

      // Add AUP icon to toolbar if necessary
      if (needInstall)
        aup.runAsync(aupInstallInToolbar);
    }
  }
}

function aupUnload()
{
  prefs.removeListener(aupReloadPrefs);
  prefs.removeListener(proxy.reloadPrefs);
  filterStorage.removeFilterObserver(aupReloadPrefs);
  filterStorage.removeSubscriptionObserver(aupReloadPrefs);
  aupHooks.getBrowser().removeProgressListener(progressListener);
}

function aupReloadPrefs() {
  var state = prefs.proxyMode;
  var label = aup.getString("status_" + state + "_label");

  var tooltip = E("aup-tooltip");
  if (state && tooltip)
    tooltip.setAttribute("curstate", state);

  var updateElement = function(element) {
    if (!element)
      return;

    if (element.tagName == "statusbarpanel" || element.tagName == "vbox") {
      element.hidden = !prefs.showinstatusbar;

      var labelElement = element.getElementsByTagName("label")[0];
      labelElement.setAttribute("value", label);
    }
    else
      element.hidden = !prefs.showintoolbar;

    // HACKHACK: Show status bar icon instead of toolbar icon if the application doesn't have a toolbar icon
    if (element.hidden && element.tagName == "statusbarpanel" && !aupHooks.getDefaultToolbar)
      element.hidden = !prefs.showintoolbar;

    if (currentlyShowingInToolbar != prefs.showintoolbar)
      aupInstallInToolbar();

    currentlyShowingInToolbar = prefs.showintoolbar;

    element.setAttribute("proxyMode", state);
  };

  var status = E("aup-status");
  updateElement(status);
  if (prefs.defaultstatusbaraction == 0)
    status.setAttribute("popup", status.getAttribute("context"));
  else
    status.removeAttribute("popup");

  var button = E("aup-toolbarbutton");
  updateElement(button);
  if (button) {
    if (button.hasAttribute("context") && prefs.defaulttoolbaraction == 0)
    {
      button.setAttribute("popup", button.getAttribute("context"));
      button.removeAttribute("type");
    }
    else
      button.removeAttribute("popup");
  }

  updateElement(aupGetPaletteButton());
}

function aupConfigureKey(key, value) {
  var valid = {
    accel: "accel",
    ctrl: "control",
    control: "control",
    shift: "shift",
    alt: "alt",
    meta: "meta"
  };

  var command = E("aup-command-" + key);
  if (!command)
    return;

  var parts = value.split(/\s+/);
  var modifiers = [];
  var keychar = null;
  var keycode = null;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase() in valid)
      modifiers.push(parts[i].toLowerCase());
    else if (parts[i].length == 1)
      keychar = parts[i];
    else if ("DOM_VK_" + parts[i].toUpperCase() in Ci.nsIDOMKeyEvent)
      keycode = "VK_" + parts[i].toUpperCase();
  }

  if (keychar || keycode) {
    var element = document.createElement("key");
    element.setAttribute("id", "aup-key-" + key);
    element.setAttribute("command", "aup-command-" + key);
    if (keychar)
      element.setAttribute("key", keychar);
    else
      element.setAttribute("keycode", keycode);
    element.setAttribute("modifiers", modifiers.join(","));

    E("aup-keyset").appendChild(element);
  }
}

// Finds the toolbar button in the toolbar palette
function aupGetPaletteButton()
{
  let toolbox = (aupHooks.getToolbox ? aupHooks.getToolbox() : null);
  if (!toolbox || !("palette" in toolbox) || !toolbox.palette)
    return null;

  for (var child = toolbox.palette.firstChild; child; child = child.nextSibling)
    if (child.id == "aup-toolbarbutton")
      return child;

  return null;
}

// Check whether we installed the toolbar button already
function aupInstallInToolbar()
{
  let tb = E("aup-toolbarbutton");
  if (!tb || tb.parentNode.localName == "toolbarpalette")
  {
    let toolbar = (aupHooks.getDefaultToolbar ? aupHooks.getDefaultToolbar() : null);
    let insertBefore = (aupHooks.toolbarInsertBefore ? aupHooks.toolbarInsertBefore() : null);
    if (toolbar && "insertItem" in toolbar)
    {
      if (insertBefore && insertBefore.parentNode != toolbar)
        insertBefore = null;

      toolbar.insertItem("aup-toolbarbutton", insertBefore, null, false);

      toolbar.setAttribute("currentset", toolbar.currentSet);
      document.persist(toolbar.id, "currentset");
    }
  }
}

// Let user choose subscriptions on first start unless he has some already
function aupShowSubscriptions()
{
  // Look for existing subscriptions
  for each (let subscription in filterStorage.subscriptions)
    if (subscription instanceof aup.DownloadableSubscription)
      return;

  if (!aupHooks.addTab || aupHooks.addTab("chrome://autoproxy/content/ui/tip_subscriptions.xul") === false)
    window.openDialog("chrome://autoproxy/content/ui/tip_subscriptions.xul", "_blank", "chrome,centerscreen,resizable,dialog=no");
}

function aupFillTooltip(event) {
  if (!document.tooltipNode || !document.tooltipNode.hasAttribute("tooltip"))
  {
    event.preventDefault();
    return;
  }

  var type = (document.tooltipNode && document.tooltipNode.id == "aup-toolbarbutton" ? "toolbar" : "statusbar");
  var action = parseInt(prefs["default" + type + "action"]);
  if (isNaN(action))
    action = -1;

  var actionDescr = E("aup-tooltip-action");
  actionDescr.hidden = (action < 0 || action > 5);
  if (!actionDescr.hidden)
    actionDescr.setAttribute("value", aup.getString("action" + action + "_tooltip"));

  var state = event.target.getAttribute("curstate");
  var statusDescr = E("aup-tooltip-status");
  statusDescr.setAttribute("value", aup.getString(state + "_tooltip"));

  var proxyDescr = E("aup-tooltip-proxy");
  proxyDescr.setAttribute("value", proxy.nameOfDefaultProxy);
  proxyDescr.hidden = E("aup-tooltip-proxy-label").hidden = (state == "disabled");

  var activeFilters = [];
  E("aup-tooltip-blocked").hidden = E("aup-tooltip-blocked-label").hidden = (state!="auto");
  if (state == "auto") {
    var locations = [];
    var rootData = RequestList.getDataForWindow(window);
    var rootCurrentData = rootData.getLocation(6, aupHooks.getBrowser().currentURI.spec);
    if (rootCurrentData) locations.push(rootCurrentData);
    var data = RequestList.getDataForWindow(aupHooks.getBrowser().contentWindow);
    data.getAllLocations(locations);

    var blocked = 0;
    var filterCount = {__proto__: null};
    for (i = 0; i < locations.length; i++) {
      if (locations[i].filter && !(locations[i].filter instanceof aup.WhitelistFilter))
        blocked++;
      if (locations[i].filter) {
        if (locations[i].filter.text in filterCount)
          filterCount[locations[i].filter.text]++;
        else
          filterCount[locations[i].filter.text] = 1;
      }
    }

    var blockedStr = aup.getString("blocked_count_tooltip");
    blockedStr = blockedStr.replace(/--/, blocked).replace(/--/, locations.length);
    E("aup-tooltip-blocked").setAttribute("value", blockedStr);

    var filterSort = function(a, b) {
      return filterCount[b] - filterCount[a];
    };
    for (var filter in filterCount)
      activeFilters.push(filter);
    activeFilters = activeFilters.sort(filterSort);
  }

  E("aup-tooltip-filters-label").hidden = (activeFilters.length == 0);
  E("aup-tooltip-filters").hidden = (activeFilters.length == 0);
  if (activeFilters.length > 0) {
    var filtersContainer = E("aup-tooltip-filters");
    while (filtersContainer.firstChild)
      filtersContainer.removeChild(filtersContainer.firstChild);

    for (var i = 0; i < activeFilters.length && i < 3; i++) {
      var descr = document.createElement("description");
      descr.setAttribute("value", activeFilters[i] + " (" + filterCount[activeFilters[i]] + ")");
      filtersContainer.appendChild(descr);
    }
    if (activeFilters.length > 3) {
      var descr = document.createElement("description");
      descr.setAttribute("value", "...");
      filtersContainer.appendChild(descr);
    }
  }
}

/**
 * Retrieves the current location of the browser (might return null on failure).
 */
function getCurrentLocation() /**nsIURI*/
{
  if ("currentHeaderData" in window && "content-base" in window.currentHeaderData)
  {
    // Thunderbird blog entry
    return aup.unwrapURL(window.currentHeaderData["content-base"].headerValue);
  }
  else if ("currentHeaderData" in window && "from" in window.currentHeaderData)
  {
    // Thunderbird mail/newsgroup entry
    try
    {
      let headerParser = Cc["@mozilla.org/messenger/headerparser;1"].getService(Ci.nsIMsgHeaderParser);
      let emailAddress = headerParser.extractHeaderAddressMailboxes(window.currentHeaderData.from.headerValue);
      return aup.makeURL("mailto:" + emailAddress.replace(/^[\s"]+/, "").replace(/[\s"]+$/, "").replace(/\s/g, "%20"));
    }
    catch(e)
    {
      return null;
    }
  }
  else
  {
    // Regular browser
    return aup.unwrapURL(aupHooks.getBrowser().contentWindow.location.href);
  }
}

// Fills the context menu on the status bar
function aupFillPopup(event)
{
  let popup = event.target;

  // Not at-target call, ignore
  if (popup.id != "aup-status-popup" && popup.id != "aup-toolbar-popup")
    return;

  // Need to do it this way to prevent a Gecko bug from striking
  var elements = {};
  var list = popup.getElementsByTagName("menuitem");
  for (var i = 0; i < list.length; i++)
    if (list[i].id && /\-(\w+)$/.test(list[i].id))
      elements[RegExp.$1] = list[i];

  // fix for default proxy, it is "menu" but not "menuitem"
  elements['defaultProxy'] = popup.getElementsByTagName('menu')[0];

  // Fill "Report to gfwList" Menu Items
  function isGfwlistSubscribed()
  {
    for (var subscriptionUrl in filterStorage.knownSubscriptions)
      if (subscriptionUrl.indexOf("gfwlist.txt") > 0)
        return true;
    return false;
  }
  elements.report.hidden = !isGfwlistSubscribed();


  // Fill "Sidebar" Menu Items
  var sidebarOpen = aupIsSidebarOpen();
  elements.opensidebar.hidden = sidebarOpen;
  elements.closesidebar.hidden = !sidebarOpen;

  // Fill "Enable Proxy On" Menu Items
  enableProxyOn(elements.defaultProxy);

  // Fill "Default Proxy" Menu Items
  elements.defaultProxy.disabled = 'disabled' == prefs.proxyMode;
  elements.defaultProxy.label = aup.getString('default_proxy') + ": " + proxy.nameOfDefaultProxy;
  makeProxyItems(elements.defaultProxy.firstChild);

  // Fill "choose proxy for rule groups" Menu Items
  chooseProxy4RuleGroups(elements.modeauto);

  // Fill "Proxy Mode" Menu Items
  elements.modeauto.setAttribute("checked", "auto" == prefs.proxyMode);
  elements.modeglobal.setAttribute("checked", "global" == prefs.proxyMode);
  elements.modedisabled.setAttribute("checked", "disabled" == prefs.proxyMode);
}

function aupIsSidebarOpen() {
  // Test whether detached sidebar window is open
  if (detachedSidebar && !detachedSidebar.closed)
    return true;

  var sidebar = E("aup-sidebar");
  return (sidebar ? !sidebar.hidden : false);
}

function toggleSidebar()
{
  if (detachedSidebar && !detachedSidebar.closed)
  {
    detachedSidebar.close();
    detachedSidebar = null;
  }
  else
  {
    var sidebar = E("aup-sidebar");
    if (sidebar && (!prefs.detachsidebar || !sidebar.hidden))
    {
      E("aup-sidebar-splitter").hidden = !sidebar.hidden;
      E("aup-sidebar-browser").setAttribute("src", sidebar.hidden ? "chrome://autoproxy/content/ui/sidebar.xul" : "about:blank");
      sidebar.hidden = !sidebar.hidden;
      if (sidebar.hidden)
        aupHooks.getBrowser().contentWindow.focus();
    }
    else
      detachedSidebar = window.openDialog("chrome://autoproxy/content/ui/sidebarDetached.xul", "_blank", "chrome,resizable,dependent,dialog=no");
  }

  let menuItem = E("aup-blockableitems");
  if (menuItem)
    menuItem.setAttribute("checked", aupIsSidebarOpen());
}

// Toggles the value of a boolean pref
function aupTogglePref(pref) {
  prefs[pref] = !prefs[pref];
  prefs.save();
}

// Handle clicks on statusbar/toolbar panel
function aupClickHandler(e)
{
  if (e.button == 1) cycleProxyMode();

  // e.button is undefined when left click on tool bar icon
  else if (e.button != 2 && e.target.tagName != 'menuitem')
    aupExecuteAction(e.target.tagName == 'image' ? prefs.defaultstatusbaraction : prefs.defaulttoolbaraction, e);
}

// Executes default action for statusbar/toolbar by its number
function aupExecuteAction(action, e)
{
  switch (action) {
    case 0:
      e.target.open = true;
      break;
    case 1:
      toggleSidebar();
      break;
    case 2:
      aup.openSettingsDialog();
      break;
    case 3:
      cycleProxyMode();
      break;
    case 4: // cycle default proxy
      if (aup.proxyTipTimer) aup.proxyTipTimer.cancel();
      prefs.defaultProxy = ++prefs.defaultProxy % proxy.server.length;
      prefs.save();
      // show tooltip
      let tooltip = E("cycleDefaultProxy");
      tooltip.label = aup.getString('default_proxy') + ": " + proxy.nameOfDefaultProxy;
      if (e.screenX && e.screenY)
        tooltip.openPopupAtScreen(e.screenX, e.screenY, false);
      else
        tooltip.openPopupAtScreen(e.target.boxObject.screenX, e.target.boxObject.screenY, false);
      aup.proxyTipTimer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);
      aup.proxyTipTimer.initWithCallback(
        {notify: function(){tooltip.hidePopup()}}, 2000, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
      break;
    case 5: // default proxy menu
      let popup = E("aup-popup-defaultProxyList");
      makeProxyItems(popup);
      if (e.screenX && e.screenY) popup.openPopupAtScreen(e.screenX, e.screenY, false);
      else popup.openPopupAtScreen(e.target.boxObject.screenX, e.target.boxObject.screenY, false);
      break;
    default:
      break;
  }
}

function switchDefaultProxy(event)
{
  var value = event.target.value;
  if ( proxy.nameOfDefaultProxy != value ) {
    prefs.defaultProxy = proxy.getName.indexOf(value);
    prefs.save();
  }
}

function makeProxyItems(popup)
{
  while (popup.firstChild) popup.removeChild(popup.firstChild);

  for each (let p in proxy.getName) {
    let item = cE('menuitem');
    item.setAttribute('type', 'radio');
    item.setAttribute('label', p);
    item.setAttribute('value', p);
    item.setAttribute('name', 'radioGroup-switchProxy');
    item.addEventListener("command", switchDefaultProxy, false);
    if (proxy.nameOfDefaultProxy == p) item.setAttribute('checked', true);
    popup.appendChild(item);
  }
}

function report2gfwList()
{
  aup.loadInBrowser("https://gfwlist.autoproxy.org/report/?url=" + aupHooks.getBrowser().currentURI.spec);
}

function chooseProxy4RuleGroups(flagItem)
{
  // remove previously created items
  removeAllMenuItems(flagItem, 'chooseProxy4RuleGroups');

  // one menu per rule group
  for each (var subscription in filterStorage.knownSubscriptions) {
    createRuleGroupProxyPopup(subscription);
  }

  // if user has no rule group, insert a note
  if (flagItem.previousSibling.className != 'chooseProxy4RuleGroups') {
    var note = cE('menu');
    note.className = 'chooseProxy4RuleGroups';
    note.setAttribute('disabled', true);
    note.setAttribute('label', aup.getString('no_proxy_rule'));
    flagItem.parentNode.insertBefore(note, flagItem);
  }

  // "when not matching" menu
  createRuleGroupProxyPopup();

  // create a menuseparator
  flagItem.parentNode.insertBefore(cE('menuseparator'), flagItem);
  flagItem.previousSibling.className = 'chooseProxy4RuleGroups';


  function createRuleGroupProxyPopup(subscription)
  {
    var groupMenu = cE('menu'),
        groupPopup = cE('menupopup'),
        menuLabel, selectedProxy;

    if (subscription) {
      selectedProxy = subscription.proxy == -1 ? aup.getString('default_proxy') : proxy.getName[subscription.proxy];
      menuLabel = (subscription.title || subscription.typeDesc) + ": " + selectedProxy;
    }
    else {
      selectedProxy = prefs.fallbackProxy == -1 ? aup.getString('no_proxy') : proxy.getName[prefs.fallbackProxy];
      menuLabel = aup.getString('not_matching') + ': ' + selectedProxy;
    }

    groupMenu.className = 'chooseProxy4RuleGroups';
    groupMenu.setAttribute('label', menuLabel);
    groupMenu.setAttribute('disabled', prefs.proxyMode != 'auto');
    groupMenu.setAttribute('value', subscription ? subscription.url : 'fallback');
    groupMenu.appendChild(groupPopup);

    // popup proxy items created here
    createMenuItem(aup.getString(subscription ? 'default_proxy' : 'no_proxy'));
    groupPopup.appendChild(cE('menuseparator'));
    proxy.getName.forEach(createMenuItem);

    flagItem.parentNode.insertBefore(groupMenu, flagItem);

    // place this function here for convenience,
    // though out of createRuleGroupProxyPopup() would be better.
    function createMenuItem(proxyName)
    {
      var menuItem = cE('menuitem');
      menuItem.setAttribute('type', 'radio');
      menuItem.setAttribute('label', proxyName);
      menuItem.setAttribute('checked', proxyName == selectedProxy);
      menuItem.addEventListener("command", setGroupProxy, false);
      groupPopup.appendChild(menuItem);
    }
  }
}

function setGroupProxy(event)
{
  var menuItem = event.target,
      selectedIndex = proxy.getName.indexOf(menuItem.label),
      subscriptionUrl = menuItem.parentNode.parentNode.value;

  if (subscriptionUrl == 'fallback') {
    prefs.fallbackProxy = selectedIndex;
    prefs.save();
  }
  else {
    filterStorage.knownSubscriptions[subscriptionUrl].proxy = selectedIndex;
  }
}

function cycleProxyMode()
{
  prefs.proxyMode = proxy.mode[(proxy.mode.indexOf(prefs.proxyMode) + 1) % 3];
  prefs.save();
}
