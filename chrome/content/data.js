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
 * Portions created by the Initial Developer are Copyright (C) 2006-2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * ***** END LICENSE BLOCK ***** */

/*
 * Stores Adblock Plus data to be attached to a window.
 * This file is included from nsAutoProxy.js.
 */

var dataSeed = Math.random();    // Make sure our properties have randomized names

function DataContainer(wnd) {
  this.locations = {};
  this.subdocs = [];
  this.install(wnd);
}
aup.DataContainer = DataContainer;

DataContainer.prototype = {
  topContainer: null,
  lastSelection: null,
  detached: false,

  // Attaches the data to a window
  install: function(wnd) {
    var topWnd = wnd.top;
    if (topWnd != wnd) {
      this.topContainer = DataContainer.getDataForWindow(topWnd);
      this.topContainer.registerSubdocument(topWnd, this);
    }
    else
      this.topContainer = this;

    wnd.document["aupData" + dataSeed] = this;

    this.installListeners(wnd);
  },

  installListeners: function(wnd) {
    var me = this;
    var hideHandler = function(ev) {
      if (!ev.isTrusted || ev.eventPhase != ev.AT_TARGET)
        return;

      if (me != me.topContainer)
        me.topContainer.unregisterSubdocument(this.top, me);
      else
        DataContainer.notifyListeners(this, "clear", me);

      // We shouldn't send further notifications
      me.detached = true;
    };

    var showHandler = function(ev) {
      if (!ev.isTrusted || ev.eventPhase != ev.AT_TARGET)
        return;

      // Allow notifications again
      me.detached = false;

      if (me != me.topContainer)
        me.topContainer.registerSubdocument(this.top, me);
      else
        DataContainer.notifyListeners(this, "select", me);
    };

    var removeHandler = function(ev) {
      if (!ev.isTrusted)
        return;

      me.removeNode(ev.target);
    };

    wnd.addEventListener("pagehide", hideHandler, false);
    wnd.addEventListener("pageshow", showHandler, false);

    wnd.addEventListener("DOMNodeRemoved", removeHandler, true);
  },

  registerSubdocument: function(topWnd, data) {
    for (var i = 0; i < this.subdocs.length; i++)
      if (this.subdocs[i] == data)
        return;

    this.subdocs.push(data);
    if (!this.detached)
      DataContainer.notifyListeners(topWnd, "refresh", this);
  },
  unregisterSubdocument: function(topWnd, data) {
    for (var i = 0; i < this.subdocs.length; i++)
      if (this.subdocs[i] == data)
        this.subdocs.splice(i--, 1);

    if (!this.detached)
      DataContainer.notifyListeners(topWnd, "refresh", this);
  },

  removeNode: function(node) {
    if ("aupLocation" + dataSeed in node) {
      var nodes = node["aupLocation" + dataSeed].nodes;
      for (var i = 0; i < nodes.length; i++)
        if (nodes[i] == node)
          nodes.splice(i--, 1);
    }
  },

  getLocation: function(type, location) {
    var key = " " + type + " " + location;
    if (key in this.locations)
      return this.locations[key];

    for (var i = 0; i < this.subdocs.length; i++) {
      var result = this.subdocs[i].getLocation(type, location);
      if (result)
        return result;
    }

    return null;
  },
  getAllLocations: function(results) {
    if (typeof results == "undefined")
      results = [];
    for (var key in this.locations)
      if (key.match(/^ /))
          results.push(this.locations[key]);

    for (var i = 0; i < this.subdocs.length; i++)
      this.subdocs[i].getAllLocations(results);

    return results;
  }
};

// Loads Adblock data associated with a window object
DataContainer.getDataForWindow = function(wnd) {
  if ("aupData" + dataSeed in wnd.document)
    return wnd.document["aupData" + dataSeed];
  else
    return new DataContainer(wnd);
};
aup.getDataForWindow = DataContainer.getDataForWindow;

// Loads Adblock data associated with a node object
DataContainer.getDataForNode = function(node, noParent) {
  while (node) {
    if ("aupLocation" + dataSeed in node)
      return [node, node["aupLocation" + dataSeed]];

    if (typeof noParent == "boolean" && noParent)
      return null;

    // If we don't have any information on the node, then maybe on its parent
    node = node.parentNode;
  }

  return null;
};
aup.getDataForNode = DataContainer.getDataForNode;

// Adds a new handler to be notified whenever the location list is added
DataContainer.listeners = [];
DataContainer.addListener = function(handler) {
  DataContainer.listeners.push(handler);
};
  
// Removes a handler
DataContainer.removeListener = function(handler) {
  for (var i = 0; i < DataContainer.listeners.length; i++)
    if (DataContainer.listeners[i] == handler)
      DataContainer.listeners.splice(i--, 1);
};

// Calls all location listeners
DataContainer.notifyListeners = function(wnd, type, data, location) {
  for (var i = 0; i < DataContainer.listeners.length; i++)
    DataContainer.listeners[i](wnd, type, data, location);
};