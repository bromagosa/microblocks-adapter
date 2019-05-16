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
    constructor(adapter, serialPort) {
        const myself = this;
        this.serialPort = serialPort;
        this.variables = [];
    }

    addVariable(name, index) {
        // remove null chars from variable names
        // eslint-disable-next-line no-control-regex
        console.log(`got variable ${varName} with index ${index}`);
        this.variables[index] = { name: varName, value: 0 };
        if (varName === '_wot_thingName' ||
            varName === '_wot_thingCapability') {
            // let's ask for the var content
            this.serialPort.write([
                0xFA, // short message
                0x07, // getVar opCode
                index // var ID
            ]);
        }
    }
}

class MicroBlocksAdapter extends Adapter {
    // we store everything into the serialPort object until the whole thing
    // definition is complete, and only then we create a MicroBlocksDevice.

    constructor(addonManager, packageName) {
        super(addonManager, 'MicroBlocks', packageName);
        // boards are indexed by name
        this.devices = new Map();
        this.buffer = [];
        addonManager.addAdapter(this);
    }

    startPairing(_timeoutSeconds) {
        console.log('MicroBlocks adapter pairing started');
        const myself = this;
        SerialPort.list().then(function(ports) {
            ports.forEach(function(port) {
                if (port.vendorId) {
                    // test this port to see if there's a µBlocks device in it
                    const serialPort =
                        new SerialPort(port.comName, {baudRate: 115200});
                    serialPort.variables = [];

                    serialPort.on('data', function (data) {
                        myself.buffer = myself.buffer.concat(data.toJSON().data);
                        myself.processBuffer(this);
                    });

                    serialPort.on('open', function() {
                        console.log(`probing ${port.comName}`);
                        // we ask the board for its variable names
                        this.write([
                            0xFA,       // short message
                            0x09,       // getVarNames opCode
                            0x00        // object ID (irrelevant)
                        ]);
                        this.discoveryTimeout = setTimeout(function() {
                            console.log(`Port ${port.comName} timed out`);
                            serialPort.close();
                            clearTimeout(this);
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

    processBuffer(serialPort) {
        let check = this.buffer[0];
        let opCode = this.buffer[1];
        let objectId = this.buffer[2];
        let dataSize = this.buffer[3] | this.buffer[4] << 8;

        if (check !== 0xFA && check !== 0xFB) {
            // missed a message header, or we're not talking to a µBlocks board
            this.buffer = [];
            return;
        }

        if (opCode === 0x1D) {
            // variableName opCode
            this.discoveredDevice(serialPort);
            this.setDescriptionTimeout(serialPort);
            if (this.buffer.length >= dataSize + 5) {
                // variableName message is complete
                this.processVariableName(
                    serialPort,
                    objectId,
                    this.getPayload(dataSize)
                );
                this.buffer = this.buffer.slice(5 + dataSize);
            }
        } else if (opCode === 0x15) {
            // variableValue opCode
            if (this.buffer.length >= dataSize + 5) {
                this.processVariableValue(
                    serialPort,
                    objectId,
                    this.getPayload(dataSize)
                );
                this.buffer = this.buffer.slice(5 + dataSize);
            }
        }
    }

    discoveredDevice(serialPort) {
        if (serialPort.discoveryTimeout) {
            clearTimeout(serialPort.discoveryTimeout);
        }
    }

    setDescriptionTimeout(serialPort) {
        if (!serialPort.descriptionTimeout) {
            serialPort.descriptionTimeout = setTimeout(function() {
                console.log(
                    'Incomplete description for thing at',
                    serialPort.path
                );
                serialPort.close();
                clearTimeout(this);
            },
            2000);
        }
    }

    processVariableName(serialPort, objectId, varName) {
        serialPort.variables[objectId] = {
            // remove null chars from variable names
            name: varName.replace(/\u0000/g, ''),
            value: 0
        };
        if (varName === '_wot_thingName' ||
            varName === '_wot_thingCapability') {
            // let's ask for the var content
            serialPort.write([
                0xFA,           // short message
                0x07,           // getVar opCode
                objectId        // var ID
            ]);
        }
    }

    processVariableValue(serialPort, objectId, varValue) {
        let variable = serialPort.variables[objectId];
        //checkForThingCompletion();
        variable.value = varValue;
        if (variable.name === '_wot_thingName') {
            serialPort.thingName = varValue;
            console.log('got thing named', serialPort.thingName);
        } else if (variable.name === '_wot_thingCapability') {
            serialPort.thingCapability = varValue;
            console.log(
                'got thing with capability',
                serialPort.thingCapability
            );
        }
    }

    checkForThingCompletion(serialPort) {
        return serialPort.variables.find()
    }

    getPayload(dataSize) {
        return String.fromCharCode.apply(
            null,
            this.buffer.slice(5, 5 + dataSize)
        );
    }

    addDevice(device) {
        if (!this.devices.has(device.name)) {
            console.log(`adding new board at ${serialPort.path}`);
            this.devices.set(device.name, device);
            this.handleDeviceAdded(device);
            return device;
        } else {
            // TODO: update it
            console.log(`TODO: should be updating board named ${device.name}`);
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
