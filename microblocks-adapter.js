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
        var myself = this;
        this.name = deviceDescription.name;
        this.type = deviceDescription.type || 'thing';
        this.description = deviceDescription.description;
        this.serialPort = serialPort;
        this.protocol = protocol;
        this.variables = [];

        this.serialPort.addVariable = function (name, index) {
            // remove null chars from variable names
            var varName = name.replace(/\u0000/g,'');
            console.log('got variable ' + varName + ' with index ' + index);
            myself.variables[index] = varName;
            myself.notifyPropertyChanged(myself.properties.get(varName));
        };

        for (var propertyName in deviceDescription.properties) {
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

    notifyPropertyChanged(property) {
        super.notifyPropertyChanged(property);
        if (this.variables.indexOf(property.name) > -1) {
            console.log('sendProperty', this.name, property.name);
            var value = this.uBlocksValue(property.value, property.type),
                packet = this.protocol.packMessage(
                    'setVar',
                    this.variables.indexOf(property.name),
                    value);
            this.serialPort.write(packet);
        } else {
            console.log('we don\'t yet have a variable index for property ' + this.name);
        }
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
        var myself = this;
        SerialPort.list().then(function (ports) {
            ports.forEach(function (port) {
                if (port.vendorId) {
                    // test this port to see if there's a µBlocks device in it
                    var serialPort = new SerialPort(port.comName, { baudRate: 115200 }),
                        protocol = new Protocol(serialPort),
                        deviceDescriptor = { properties: {} },
                        device,
                        responds = false;

                    serialPort.receiveBroadcast = function (message) {
                        try {
                            if (message.indexOf('moz-pair') === 0) {
                                deviceDescriptor.name = message.split('moz-pair ')[1];
                                responds = true;
                            } else if (message.indexOf('moz-property') === 0) {
                                var json = JSON.parse(message.split('moz-property ')[1]);
                                console.log('got property: ', json);
                                deviceDescriptor.properties[json.name] = json;
                            } else if (message.indexOf('moz-done') === 0) {
                                device = myself.addDevice(serialPort, deviceDescriptor, protocol);
                            } else {
                                console.log('received unknown message: ' + message);
                            }
                        } catch (err) {
                            console.log(err);
                        }
                    };

                    serialPort.on('data', function (data) {
                        protocol.processRawData(Array.from(new Uint8Array(data)));
                    });

                    serialPort.on('open', function () {
                        console.log('probing ' + port.comName);
                        setTimeout(function () {
                            if (!responds) {
                                console.log('Port ' + port.comName + ' timed out');
                                serialPort.close();
                            }
                        }, 2000);
                    });

                    serialPort.on('close', function (err) {
                        if (err && err.disconnected) {
                            console.log('removing device at ' + port.comName + ' because it was unplugged');
                            myself.removeThing(device).then(() => { protocol.serialPort = null });
                        } else {
                            console.log('device at ' + port.comName + ' successfully disconnected');
                            protocol.serialPort = null;
                        }
                    });

                    serialPort.write(protocol.packMessage('broadcast', 0, protocol.packString('moz-pair')));
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
        for (let deviceId in this.devices) {
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
        return new Promise((resolve, reject) => {
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
    var adapter = new MicroBlocksAdapter(addonManager, manifest.name);
}

module.exports = loadMicroBlocksAdapter;
