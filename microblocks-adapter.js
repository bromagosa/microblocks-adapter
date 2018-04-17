/**
 * microblocks-adapter.js - MicroBlocks adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

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
      var description = deviceDescription.properties[propertyName];
      var property = new MicroBlocksProperty(this, propertyName, description);
      this.properties.set(propertyName, property);
    }
  }

  notifyPropertyChanged(property) {
    super.notifyPropertyChanged(property);
    this.adapter.sendProperty(this.id, property);
  }
}

class MicroBlocksAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, 'MicroBlocks', packageName);

    this.devices = new Map();
    this.port = new SerialPort('/dev/ttyACM0', { baudRate: 115200 });

    this.receiveBuf = new Buffer(0);
    this.onPortData = this.onPortData.bind(this);
    this.port.on('data', this.onPortData);

    addonManager.addAdapter(this);

	// xxx temporary
    this.addLED = this.addLED.bind(this);
	this.addLED();
  }

  addLED() {
      let deviceDescription = {
      name: 'User LED',
      type: 'onOffLight',
      properties: {
        on: {
          name: 'on',
          type: 'boolean',
          value: false,
        },
      },
    };

    if (!this.devices.has(deviceDescription.name)) {
      var device = new MicroBlocksDevice(this, deviceDescription.name, deviceDescription);
      this.handleDeviceAdded(device);
      this.devices.set(deviceDescription.name, device);
    }
  }

  addLED2() {
      let deviceDescription = {
		  name: 'Dimmable LED',
		  type: 'dimmableLight',
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

    if (!this.devices.has(deviceDescription.name)) {
      var device = new MicroBlocksDevice(this, deviceDescription.name, deviceDescription);
      this.handleDeviceAdded(device);
      this.devices.set(deviceDescription.name, device);
    }
  }

  onPortData(data) {
    this.receiveBuf = Buffer.concat([this.receiveBuf, data]);

    let deviceDescription = {
      name: 'User LED',
      type: 'dimmableLight',
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

    if (!this.devices.has(deviceDescription.name)) {
      var device = new MicroBlocksDevice(this, deviceDescription.name, deviceDescription);
      this.handleDeviceAdded(device);
      this.devices.set(deviceDescription.name, device);
    }

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
      this.handleDeviceAdded(device);
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

  sendProperty(deviceId, property) {
    if (property.name == 'on') {
	  let varID = 0;
      this.sendLongMessage(0x08, varID, [3, (property.value ? 1 : 0)]);
    } else if (property.name == 'level') {
	  let varID = 1;
      let n = Math.floor(property.value);
      this.sendLongMessage(0x08, varID,
      	[1, (n & 0xff), ((n >> 8) & 0xff), ((n >> 16) & 0xff), ((n >> 24) & 0xff)]);
    }
  }

  sendLongMessage(opcode, varID, data) {
    data.push(0xfe);
    let buf = Buffer.from(
	  [0xfb, opcode, varID, data.length & 0xff, (data.length >> 16) & 0xff].concat(data));
    this.port.write(buf);
  }
}

function loadMicroBlocksAdapter(addonManager, manifest, _errorCallback) {
  var adapter = new MicroBlocksAdapter(addonManager, manifest.name);
}

module.exports = loadMicroBlocksAdapter;
