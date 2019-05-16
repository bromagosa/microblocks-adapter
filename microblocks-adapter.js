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
    constructor(device, description) {
        super(device, description.title, description);
        this.unit = description.unit;
        this.ublocksVarName = description.ublocksVarName;
        this.setCachedValue(description.value);
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
        super(adapter, serialPort.thingName);
        const myself = this;
        this.name = serialPort.thingName;
        this.type = serialPort.thingCapability || 'thing';
        console.log('thing type is', this.type);
        this.serialPort = serialPort;
        this.variables = serialPort.variables;

        serialPort.thingProperties.forEach(function (description) {
            description.value =
                myself.variables.find(function(variable) {
                    return variable.name = description.ublocksVarName
                }).value;
            myself.properties.set(
                description.ublocksVarName,
                new MicroBlocksProperty(myself, description)
            );
        });
    }

    notifyPropertyChanged(property, clientOnly) {
        const propertyName = property.ublocksVarName || property.name;
        let variable = this.variables.find(function (variable) {
            return variable.name === propertyName;
        });
        super.notifyPropertyChanged(property);
        if (!clientOnly) {
            console.log('sendProperty', propertyName);
            const value = this.uBlocksValue(property.value, property.type);
            this.serialPort.write(
                this.packVariableMessage(variable.id, value)
            );
        }
    }

    packVariableMessage(varId, value) {
        let message = [0xFB, 0x08, varId];
        let data = this.packString(value.toString()).concat(0xFE);
        // add the data size in little endian
        message.push(data.length & 255);
        message.push((data.length >> 8) & 255);
        // add the data to the message
        message = message.concat(data);
        return message;
    }

    packString(string) {
        return string.split('').map(
            function (char) { return char.charCodeAt(0); }
        );
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
                        new SerialPort(port.comName, { baudRate: 115200 });
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
                            serialPort.discoveryTimeout = null;
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

        if (check === 0xFB) {
            // long message
            if (this.buffer.length >= dataSize + 5) {
                // message is complete
                if (opCode === 0x1D) {
                    // variableName opCode
                    this.discoveredDevice(serialPort);
                    this.setDescriptionTimeout(serialPort);
                    // variableName message is complete
                    this.processVariableName(
                        serialPort,
                        objectId,
                        this.getPayload(dataSize)
                    );
                } else if (opCode === 0x15) {
                    // variableValue opCode
                    this.processVariableValue(
                        serialPort,
                        objectId,
                        this.getPayload(dataSize)
                    );
                } else if (opCode === 0x1B) {
                    // broadcast opCode
                    this.processBroadcast(
                        serialPort,
                        objectId,
                        this.getPayload(dataSize)
                    );
                }
                this.buffer = this.buffer.slice(5 + dataSize);
                // there may be the start of a new message left to process
                this.processBuffer();
            }
        } else if (check === 0xFA) {
            // short message
            this.buffer = this.buffer.slice(3);
            // there may be the start of a new message left to process
            this.processBuffer();
        } else {
            // missed a message header, or we're not talking to a µBlocks board
            this.buffer = [];
            return;
        }
    }

    getPayload(dataSize) {
        return String.fromCharCode.apply(
            null,
            this.buffer.slice(5, 5 + dataSize)
        ).replace(/\u0002/g, ''); // remove null chars
    }

    discoveredDevice(serialPort) {
        if (serialPort.discoveryTimeout) {
            serialPort.thingProperties = [];
            console.log('found MicroBlocks device at', serialPort.path);
            clearTimeout(serialPort.discoveryTimeout);
            serialPort.discoveryTimeout = null;
        }
    }

    setDescriptionTimeout(serialPort) {
        const myself = this;
        if (!serialPort.descriptionTimeout) {
            serialPort.descriptionTimeout = setTimeout(function() {
                if (serialPort.thingProperties.length > 0) {
                    console.log(
                        'Thing description at ',
                        serialPort.path,
                        'complete');
                    myself.addDevice(serialPort);
                } else {
                    console.log(
                        'Incomplete description for thing at',
                        serialPort.path
                    );
                    serialPort.close();
                }
                clearTimeout(this);
                serialPort.descriptionTimeout = null;
            },
            2000);
        }
    }

    processVariableName(serialPort, objectId, varName) {
        serialPort.variables[objectId] = {
            name: varName,
            id: objectId,
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
        variable.value = varValue;
        if (variable.name === '_wot_thingName') {
            serialPort.thingName = varValue;
        } else if (variable.name === '_wot_thingCapability') {
            serialPort.thingCapability = varValue;
        }
        if (!serialPort.thingDefined &&
                serialPort.thingName &&
                serialPort.thingCapability) {
            serialPort.thingDefined = true;
            // Thing is defined. Let's ask the board to restart all tasks so we
            // can receive its property definitions via broadcasts
            serialPort.write([
                0xFA,           // short message
                0x06,           // stopAll opCode
                0x00,           // object ID (irrelevant)
                0xFA,           // short message
                0x05,           // startAll opCode
                0x00            // object ID (irrelevant)
            ]);
        }
    }

    processBroadcast(serialPort, objectId, message) {
        let property;
        if (message.indexOf('moz-property') === 0) {
            property = JSON.parse(message.substring(12));
            // get the variable name from the href: "/properties/varName" field
            property.ublocksVarName = property.href.substring(12);
            serialPort.thingProperties.push(property);
            console.log('got property', property.title);
        }
    }

    addDevice(serialPort) {
        if (!this.devices.has(serialPort.thingName)) {
            console.log('adding new thing named', serialPort.thingName);
            const device = new MicroBlocksDevice(this, serialPort);
            this.devices.set(device.name, device);
            this.handleDeviceAdded(device);
            return device;
        } else {
            // TODO
            console.log(
                'TODO: should be updating board named',
                serialPort.thingName
            );
        }
    }

    cancelPairing() {
        // need to get to the serialport
        console.log(this);
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
