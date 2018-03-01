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

const ttys = [
  '/dev/ttys003',
];

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
}

class MicroBlocksAdapter extends Adapter {
  constructor(addonManager, packageName, ttyPath) {
    super(addonManager, 'MicroBlocks', packageName);
    this.ttyPath = ttyPath;

	this.port = new SerialPort('/dev/cu.usbmodem1422', { baudRate: 115200 });

	// Switches the port into "flowing mode"
	this.port.on('data', function (data) {
	  console.log('Data:', data);
	});

	// Read data that is available but keep the stream from entering "flowing mode"
// 	this.port.on('readable', function () {
// 	  console.log('Data:', port.read());
// 	});

/*
    this.readStream = fs.createReadStream(this.ttyPath);
    this.readStream.on('data', (chunk) => {
      console.log(`Received ${chunk.length} bytes of data:`, chunk);
    });
    this.writeStream = fs.createWriteStream(this.ttyPath);
    this.writeStream.on('open', () => {
      this.writeStream.write(Buffer.from([250, 26, 0]));
    });

	// xxx testing:
    this.readStream.on('readable', () => {
    	console.log('is readable');
    });
    console.log(this.readStream.read());
*/

    addonManager.addAdapter(this);
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
}

function loadMicroBlocksAdapter(addonManager, manifest, _errorCallback) {
  for (let tty of ttys) {
    var adapter = new MicroBlocksAdapter(addonManager, manifest.name, tty);
    var device = new MicroBlocksDevice(adapter, 'example-plug-2', {
      name: 'example-plug-2',
      type: 'onOffSwitch',
      description: 'MicroBlocks Plugin Device',
      properties: {
        on: {
          name: 'on',
          type: 'boolean',
          value: false,
        },
      },
    });
    adapter.handleDeviceAdded(device);
  }
}

module.exports = loadMicroBlocksAdapter;
