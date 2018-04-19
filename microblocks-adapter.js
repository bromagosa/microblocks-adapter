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
const Protocol = require('./uprotocol.js');

// Adapter

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
    constructor(adapter, id, deviceDescription, serialPort, protocol) {
        super(adapter, id);
        this.name = deviceDescription.name;
        this.type = deviceDescription.type || 'thing';
        this.description = deviceDescription.description;
        this.serialPort = serialPort;
        this.protocol = protocol;
        for (var propertyName in deviceDescription.properties) {
            var description = deviceDescription.properties[propertyName];
            var property = new MicroBlocksProperty(this, propertyName, description);
            this.properties.set(propertyName, property);
        }
    }

    notifyPropertyChanged(property) {
        super.notifyPropertyChanged(property);
        console.log('sendProperty', this.name, property.name);
        var value = this.uBlocksValue(property.value, property.type),
            packet = this.protocol.packMessage(
                'setVar',
                Array.from(this.properties.keys()).indexOf(property.name),
                value);
        console.log(packet);
        this.serialPort.write(packet);
    }

    uBlocksValue(value, typeName) {
        if (typeName === 'boolean') {
            return [ 3, value && 1 || 0 ];
        } else {
            var level = Math.floor(value);
            return [
                1,
                level & 255,
                (level >> 8) & 255,
                (level >> 16) & 255,
                (level >> 24) & 255
            ]
        }
    }
}

class MicroBlocksAdapter extends Adapter {
    constructor(addonManager, packageName) {
        super(addonManager, 'MicroBlocks', packageName);
        // boards are indexed by port name
        this.devices = new Map();
        addonManager.addAdapter(this);
    }

    startPairing(_timeoutSeconds) {
        console.log('MicroBlocks adapter pairing started');
        var myself = this;
        SerialPort.list().then(function (ports) {
            ports.forEach(function (port) {
                if (port.vendorId) {
                    // test this port to see if there's a µBlocks device in it
                    var serialPort = new SerialPort(port.comName, { baudRate: 115200 }),
                        protocol = new Protocol(serialPort),
                        responds = false;

                    serialPort.receiveBroadcast = function (message) {
                        var descriptor = JSON.parse(message);
                        if (descriptor.name) {
                            responds = true;
                            myself.addDevice(serialPort, descriptor, protocol);
                        }
                    };

                    serialPort.on('data', function (data) {
                        protocol.processRawData(Array.from(new Uint8Array(data)));
                    });
                    console.log('probing ' + port.comName);
                    var packet = protocol.packMessage('broadcast', 0, protocol.packString('moz-pair'));
                    serialPort.on('open', function () {
                        setTimeout(function () {
                            if (!responds) {
                                console.log('Port ' + port.comName + ' timed out');
                                serialPort.close();
                            }
                        }, 2000);
                    });
                    serialPort.write(packet);
                }
            });
        })
    }

    cancelPairing() {
        // TODO What to do here?
    }

    // TODO if device or property already exists, update it
    addDevice(serialPort, descriptor, protocol) {
        console.log('found board: ' + descriptor.name);
        if (!this.devices.has(descriptor.name)) {
            var device = 
                new MicroBlocksDevice(
                    this,
                    descriptor.name,
                    descriptor,
                    serialPort,
                    protocol);
            this.devices.set(descriptor.name, descriptor);
            this.handleDeviceAdded(device);
        }
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

}

function loadMicroBlocksAdapter(addonManager, manifest, _errorCallback) {
    var adapter = new MicroBlocksAdapter(addonManager, manifest.name);
}

module.exports = loadMicroBlocksAdapter;
