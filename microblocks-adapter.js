/**
 * example-plugin-adapter.js - MicroBlocks adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const fs = require('fs');
const Adapter = require('../adapter');
const Device = require('../device');
const Property = require('../property');
const SerialPort = require('serialport');

class MicroBlocksProperty extends Property {
  constructor(device, name, propertyDescription) {
    super(device, name, propertyDescription);
    this.unit = propertyDescription.unit;
    this.description = propertyDescription.description;
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
  }

  /**
   * @method setValue
   * @returns a promise which resolves to the updated value.
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    return new Promise((resolve, reject) => {
      super.setValue(value).then((updatedValue) => {
        resolve(updatedValue);
        this.device.notifyPropertyChanged(this);
      }).catch((err) => {
        reject(err);
      });
    });
  }
}

class MicroBlocksDevice extends Device {
  constructor(adapter, id, deviceDescription) {
    super(adapter, id);
    this.name = deviceDescription.name;
    this.type = deviceDescription.type;
    this.description = deviceDescription.description;
    for (var propertyName in deviceDescription.properties) {
      var propertyDescription = deviceDescription.properties[propertyName];
      var property = new MicroBlocksProperty(this, propertyName,
                                         propertyDescription);
      this.properties.set(propertyName, property);
    }
  }

  notifyPropertyChanged(property) {
    super.notifyPropertyChanged(property);
    this.adapter.sendProperty(this.deviceId, property);
  }
}

class MicroBlocksAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, 'MicroBlocks', packageName);

    this.port = new SerialPort('/dev/cu.usbmodem1422', { baudRate: 115200 });

    this.onPortData = this.onPortData.bind(this);
    this.portData = [];
    this.port.on('data', this.onPortData);

    let deviceDescription = {
      name: 'example-plug-2',
      type: 'onOffSwitch',
      description: 'MicroBlocks Plugin Device',
      properties: {
        on: {
          name: 'on',
          type: 'boolean',
          value: false,
        },
        level: {
          name: 'level',
          type: 'number',
          value: 0,
        },
      },
    };

    var device = new MicroBlocksDevice(this, deviceDescription.name, deviceDescription);

    adapter.handleDeviceAdded(device);
    addonManager.addAdapter(this);
  }

  onPortData(data) {
    console.log('onPortData', data);
    this.portData = this.portData.concat(data);
    /*
    if (broadcast of the json blob) {
      let blob = {
        name: 'example-plug-2',
        type: 'onOffSwitch',
        description: 'MicroBlocks Plugin Device',
        properties: {
          on: {
            name: 'on',
            type: 'boolean',
            value: false,
          },
          level: {
            name: 'level',
            type: 'number',
            value: 0,
          },
        },
      };
      var device = new MicroBlocksDevice(this, blob.name, blob);
      adapter.handleDeviceAdded(device);
    }
    */
  }

  /**
   * For cleanup between tests.
   */
  clearState() {
    this.actions = {};

    for (let deviceId in this.devices) {
      this.removeDevice(deviceId);
    }
  }

  /**
   * Add a MicroBlocksDevice to the MicroBlocksAdapter
   *
   * @param {String} deviceId ID of the device to add.
   * @return {Promise} which resolves to the device added.
   */
  addDevice(deviceId, deviceDescription) {
    return new Promise((resolve, reject) => {
      if (deviceId in this.devices) {
        reject('Device: ' + deviceId + ' already exists.');
      } else {
        var device = new MicroBlocksDevice(this, deviceId, deviceDescription);
        this.handleDeviceAdded(device);
        resolve(device);
      }
    });
  }

  /**
   * Remove a MicroBlocksDevice from the MicroBlocksAdapter.
   *
   * @param {String} deviceId ID of the device to remove.
   * @return {Promise} which resolves to the device removed.
   */
  removeDevice(deviceId) {
    return new Promise((resolve, reject) => {
      var device = this.devices[deviceId];
      if (device) {
        this.handleDeviceRemoved(device);
        resolve(device);
      } else {
        reject('Device: ' + deviceId + ' not found.');
      }
    });
  }

  pairDevice(deviceId, deviceDescription) {
    this.pairDeviceId = deviceId;
    this.pairDeviceDescription = deviceDescription;
  }

  unpairDevice(deviceId) {
    this.unpairDeviceId = deviceId;
  }

  // eslint-disable-next-line no-unused-vars
  startPairing(timeoutSeconds) {
    console.log('MicroBlocksAdapter:', this.name,
                'id', this.id, 'pairing started');
    if (this.pairDeviceId) {
      var deviceId = this.pairDeviceId;
      var deviceDescription = this.pairDeviceDescription;
      this.pairDeviceId = null;
      this.pairDeviceDescription = null;
      this.addDevice(deviceId, deviceDescription).then(() => {
        console.log('MicroBlocksAdapter: device:', deviceId, 'was paired.');
      }).catch((err) => {
        console.error('MicroBlocksAdapter: unpairing', deviceId, 'failed');
        console.error(err);
      });
    }
  }

  cancelPairing() {
    console.log('MicroBlocksAdapter:', this.name, 'id', this.id,
                'pairing cancelled');
  }

  removeThing(device) {
    console.log('MicroBlocksAdapter:', this.name, 'id', this.id,
                'removeThing(', device.id, ') started');
    if (this.unpairDeviceId) {
      var deviceId = this.unpairDeviceId;
      this.unpairDeviceId = null;
      this.removeDevice(deviceId).then(() => {
        console.log('MicroBlocksAdapter: device:', deviceId, 'was unpaired.');
      }).catch((err) => {
        console.error('MicroBlocksAdapter: unpairing', deviceId, 'failed');
        console.error(err);
      });
    }
  }

  cancelRemoveThing(device) {
    console.log('MicroBlocksAdapter:', this.name, 'id', this.id,
                'cancelRemoveThing(', device.id, ')');
  }

  sendProperty(deviceId, property) {
    console.log('sendProperty', deviceId, property);

    if (property.name == 'on') {
      this.sendLongMessage(0x08, 0, [1, property.value ? 1 : 0, 0, 0, 0]);
    } else if (property.name == 'switch') {
      this.sendLongMessage(0x08, 1, [1, property.value ? 1 : 0, 0, 0, 0]);
    } else if (property.name == 'level') {
      let level = Math.floor(property.value);
      this.sendLongMessage(0x08, 2, [1, level & 0xff, (level >> 16) & 0xff, ]);
    }
  }

  sendLongMessage(opcode, id, data) {
    data.push(0xfe);
    let buf = Buffer.from(
      [0xfb, opcode, id, data.length & 0xff, (data.length >> 16) & 0xff].concat(data));
    console.log(buf);
    this.port.write(buf);
  }
}

function loadMicroBlocksAdapter(addonManager, manifest, _errorCallback) {
  var adapter = new MicroBlocksAdapter(addonManager, manifest.name);
}

module.exports = loadMicroBlocksAdapter;
