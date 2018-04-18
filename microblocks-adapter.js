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
        // this.adapter.sendProperty(this.id, property);
    }
}

class MicroBlocksAdapter extends Adapter {
    constructor(addonManager, packageName) {
        super(addonManager, 'MicroBlocks', packageName);

        // boards are indexed by port name
        this.boards = new Map();

        //this.receiveBuf = new Buffer(0);
        //this.onPortData = this.onPortData.bind(this);
        //this.port.on('data', this.onPortData);

        addonManager.addAdapter(this);

        // xxx temporary
        //this.addLED = this.addLED.bind(this);
        //this.addLED();
    }

    startPairing(_timeoutSeconds) {
        console.log('MicroBlocks adapter pairing started');
        var myself = this;
        SerialPort.list().then(function (ports) {
            ports.forEach(function (port) {
                if (port.vendorId) {
                    // test this port to see if there's a µBlocks device in it
                    var serialPort = new SerialPort(port.comName, { baudRate: 115200 }),
                        protocol = new Protocol(serialPort);

                    serialPort.receiveBroadcast = function (message) {
                        var description = JSON.parse(message);
                        myself.addBoard(port.comName, description.name, description.devices);
                    };

                    serialPort.on('data', function (data) {
                        protocol.processRawData(Array.from(new Uint8Array(data)));
                    });
                    console.log('probing ' + port.comName);
                    var message = protocol.packMessage('broadcast', 0, protocol.packString('moz-pair'));
                    console.log(message);
                    serialPort.write(message);
                }
            });
        })
    }

    /**
     * Cancel the pairing/discovery process.
     */
    cancelPairing() {
        console.log('ExampleAdapter:', this.name, 'id', this.id,
                'pairing cancelled');
    }

    addBoard(portName, boardName, deviceDescriptors) {
        var myself = this;
        console.log('found board: ' + boardName);
        // TODO if board already exists, update it
        if (!this.boards.has(portName)) {
            // TODO what to do with board name?
            var devices = new Map();
            this.boards.set(portName, devices);
            deviceDescriptors.forEach(function (deviceDescriptor) {
                // TODO if device already exists, update it
                var device = new MicroBlocksDevice(myself, deviceDescriptor.name, deviceDescriptor);
                myself.handleDeviceAdded(device);
                devices.set(deviceDescriptor.name, device);
            });
        }
    }
    /*

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
    }
    */

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

}

function loadMicroBlocksAdapter(addonManager, manifest, _errorCallback) {
    var adapter = new MicroBlocksAdapter(addonManager, manifest.name);
}

module.exports = loadMicroBlocksAdapter;
