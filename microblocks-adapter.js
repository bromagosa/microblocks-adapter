/**
 * microblocks-adapter.js - MicroBlocks adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const SerialPort = require('serialport');
const {
  Adapter,
  Device,
  Property,
} = require('gateway-addon');

// Adapter

class MicroBlocksProperty extends Property {
  constructor(device, name, propertyDescription) {
    super(device, name, propertyDescription);
    this.unit = propertyDescription.unit;
    this.description = propertyDescription.description;
    this.ublocksVarName = propertyDescription.ublocksVarName;
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
  setValue(value, clientOnly) {
    return new Promise((resolve, reject) => {
      super.setValue(value).then((updatedValue) => {
        resolve(updatedValue);
        this.device.notifyPropertyChanged(this, clientOnly);
      }).catch((err) => {
        reject(err);
      });
    });
  }
}

class MicroBlocksDevice extends Device {
  constructor(adapter, id, deviceDescription, serialPort, protocol) {
    super(adapter, id);
    const myself = this;
    this.name = deviceDescription.name;
    this.type = deviceDescription.type || 'thing';
    this.description = deviceDescription.description;
    this.serialPort = serialPort;
    this.protocol = protocol;
    this.variables = [];

    this.serialPort.addVariable = function(name, index) {
      // remove null chars from variable names
      // eslint-disable-next-line no-control-regex
      const varName = name.replace(/\u0000/g, '');
      console.log(`got variable ${varName} with index ${index}`);
      myself.variables[index] = varName;
    };

    /*
    if (Object.keys(deviceDescription.properties).length === 1) {
      // this is a single-property device
      const property =
        deviceDescription.properties[
          Object.keys(deviceDescription.properties)[0]
        ];

      if (property.type === 'boolean') {
        this.type = 'onOffSwitch';
        if (property.name !== 'on') {
          deviceDescription.properties.on = property;
          deviceDescription.properties.on.ublocksVarName = property.name;
          delete deviceDescription.properties[property.name];
        }
      }

      // Commenting this part out, as multilevel switches have values from
      // 0 to 100, and our numeric things may have values between
      // arbitrary intervals

      else if (property.type === 'number') {
        this.type = 'multiLevelSwitch';
        deviceDescription.properties.level = {};
        Object.keys(property).forEach(function (key) {
          deviceDescription.properties.level[key] = property[key];
        });
        deviceDescription.properties.level.ublocksVarName = property.name;
        deviceDescription.properties.level.name = 'level';

        delete(deviceDescription.properties[property.name]);

        deviceDescription.properties.on = {
          name: 'on',
          type: 'boolean',
          value: true
        };
      }
    }
    */

    for (const propertyName in deviceDescription.properties) {
      this.properties.set(
        propertyName,
        new MicroBlocksProperty(
          this,
          propertyName,
          deviceDescription.properties[propertyName]
        )
      );
    }

    this.serialPort.write(protocol.packMessage('getVarNames'));
  }

  notifyPropertyChanged(property, clientOnly) {
    const propertyName = property.ublocksVarName || property.name;
    super.notifyPropertyChanged(property);
    if (!clientOnly) {
      if (this.variables.indexOf(propertyName) > -1) {
        console.log('sendProperty', propertyName);
        const value = this.uBlocksValue(property.value, property.type),
          packet = this.protocol.packMessage(
            'setVar',
            this.variables.indexOf(propertyName),
            value);
        this.serialPort.write(packet);
      } else {
        console.log('we don\'t yet have a variable index for property',
                    propertyName);
      }
    }
  }

  uBlocksValue(value, typeName) {
    if (typeName === 'boolean') {
      return [ 3, value && 1 || 0 ];
    } else {
      const level = Math.floor(value);
      return [
        1,
        level & 255,
        (level >> 8) & 255,
        (level >> 16) & 255,
        (level >> 24) & 255,
      ];
    }
    // TODO string type not yet supported
  }
}

class MicroBlocksAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, 'MicroBlocks', packageName);
    // boards are indexed by name
    this.devices = new Map();
    addonManager.addAdapter(this);
  }

  startPairing(_timeoutSeconds) {
    console.log('MicroBlocks adapter pairing started');
    const myself = this;
    SerialPort.list().then(function(ports) {
      ports.forEach(function(port) {
        if (port.vendorId) {
          // test this port to see if there's a µBlocks device in it
          const serialPort = new SerialPort(port.comName, {baudRate: 115200});
          const protocol = new Protocol(serialPort);
          const deviceDescriptor = {properties: {}};
          let timeout;
          let device;
          let responds = false;
          let rawJSON = '';

          serialPort.on('data', function(data) {
            let index = data.indexOf('moz-json');
            if (index > -1) {
                responds = true;
                clearTimeout(timeout);
                rawJSON += data.substring(index);
            }
            console.log(rawJSON);
          });

          serialPort.on('open', function() {
            console.log(`probing ${port.comName}`);
            timeout = setTimeout(function() {
              if (!responds) {
                console.log(`Port ${port.comName} timed out`);
                serialPort.close();
                clearTimeout(timeout);
              }
            }, 2000);
          });

          serialPort.on('close', function(err) {
            if (err && err.disconnected) {
              console.log('removing device at',
                          port.comName,
                          'because it was unplugged');
              myself.removeThing(device).then(() => {
                protocol.serialPort = null;
              });
            } else {
              console.log('device at',
                          port.comName,
                          'successfully disconnected');
            }
          });
        }
      });
    });
  }

  /*
  cancelPairing() {
      // what TODO here?
  }
  */

  addDevice(serialPort, descriptor, protocol) {
    console.log(`adding board: ${descriptor.name}`);
    if (!this.devices.has(descriptor.name)) {
      const device = new MicroBlocksDevice(this,
                                           descriptor.name,
                                           descriptor,
                                           serialPort,
                                           protocol);
      this.devices.set(descriptor.name, descriptor);
      this.handleDeviceAdded(device);
      return device;
    } else {
      // TODO if device or property already exists, update it
    }
  }

  /**
   * For cleanup between tests.
   */
  clearState() {
    this.actions = {};
    for (const deviceId in this.devices) {
      this.removeThing(this.devices[deviceId]);
    }
  }

  /**
   * Remove a MicroBlocksDevice from the MicroBlocksAdapter.
   *
   * @param {thing} device to remove.
   * @return {Promise} which resolves to the device removed.
   */
  removeThing(thing) {
    return new Promise((resolve) => {
      if (thing.serialPort && thing.serialPort.isOpen) {
        thing.serialPort.close();
      }
      this.devices.delete(thing.id);
      this.handleDeviceRemoved(thing);
      resolve(thing);
    });
  }
}

function loadMicroBlocksAdapter(addonManager, manifest, _errorCallback) {
  new MicroBlocksAdapter(addonManager, manifest.name);
}

module.exports = loadMicroBlocksAdapter;
