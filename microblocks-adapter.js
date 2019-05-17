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
    constructor(adapter, mockDevice) {
        super(adapter, mockDevice.thingName);
        const myself = this;
        this.name = mockDevice.thingName;
        this.type = mockDevice.thingCapability || 'thing';
        this['@type'] = [ this.type ];
        this.serialPort = mockDevice.serialPort;
        this.variables = mockDevice.variables;

        mockDevice.thingProperties.forEach(function (description) {
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
        super.notifyPropertyChanged(property);
        let variable = this.variables.find(function (variable) {
            return variable.name === propertyName;
        });
        if (!clientOnly) {
            console.log('sendProperty', propertyName);
            const value = this.adapter.packValue(property.value, property.type);
            console.log('value', value);
            let message = this.adapter.packVariableMessage(variable.id, value);
            console.log('message', message);
            this.serialPort.write(message);
        }
    }

}

class MicroBlocksAdapter extends Adapter {

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
                myself.probePort(port);
            });
        });
    }

    addDevice(mockDevice) {
        if (!this.devices.has(mockDevice.thingName)) {
            console.log('adding new thing named', mockDevice.thingName);
            const device = new MicroBlocksDevice(this, mockDevice);
            this.devices.set(device.name, device);
            this.handleDeviceAdded(device);
            return device;
        } else {
            // TODO
            console.log(
                'TODO: should be updating board named',
                mockDevice.thingName
            );
        }
    }

    cancelPairing() {
        // how to get to the serialport instance to close it?
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

    /**
     * Test this port to see if there's a µBlocks device in it. If so, we store
     * everything into a mock device instance until the whole definition is
     * complete, and only then we create a new MicroBlocksDevice.
     *
     * @param {port} serial port object to probe.
     */
    probePort(port) {
        const myself = this;
        if (port.vendorId) {
            const serialPort =
                new SerialPort(port.comName, { baudRate: 115200 });

            let mockDevice = {
                variables: [],
                serialPort: serialPort
            }

            serialPort.on('data', function (data) {
                myself.buffer = myself.buffer.concat(data.toJSON().data);
                myself.processBuffer(mockDevice);
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
                        mockDevice.serialPort = null;
                    });
                } else {
                    console.log('device at',
                        port.comName,
                        'successfully disconnected');
                }
            });
        }
    }

    /**
     * Process the current serial port buffer to see if there's a complete
     * message to be parsed, and parse it if so.
     *
     * @param {mockDevice} mock device object where we store all properties.
     */
    processBuffer(mockDevice) {
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
                    this.discoveredDevice(mockDevice);
                    this.setDescriptionTimeout(mockDevice);
                    // variableName message is complete
                    this.processVariableName(
                        mockDevice,
                        objectId,
                        this.getPayload(dataSize)
                    );
                } else if (opCode === 0x15) {
                    // variableValue opCode
                    this.processVariableValue(
                        mockDevice,
                        objectId,
                        this.getPayload(dataSize)
                    );
                } else if (opCode === 0x1B) {
                    // broadcast opCode
                    this.processBroadcast(
                        mockDevice,
                        this.getPayload(dataSize)
                    );
                }
                this.buffer = this.buffer.slice(5 + dataSize);
                // there may be the start of a new message left to process
                this.processBuffer(mockDevice);
            }
        } else if (check === 0xFA) {
            // short message
            this.buffer = this.buffer.slice(3);
            // there may be the start of a new message left to process
            this.processBuffer(mockDevice);
        } else {
            // missed a message header, or we're not talking to a µBlocks board
            this.buffer = [];
            return;
        }
    }

    /**
     * Read the payload of the message being currently processed
     *
     * @param {dataSize} amount of bytes to read.
     * @return {int, boolean, string} the parsed value in its proper type.
     */
    getPayload(dataSize) {
        let typeByte = this.buffer[5];
        let value =
            String.fromCharCode.apply(
                null,
                this.buffer.slice(6, 5 + dataSize));
        if (typeByte === 1) {
            // int type
            return parseInt(value);
        } else if (typeByte === 2) {
            // string type
            return value;
        } else if (typeByte === 3) {
            // boolean type
            return value === 'true'
        } else {
            // not a variable, get the full string
            return String.fromCharCode.apply(
                null,
                this.buffer.slice(5, 5 + dataSize));
        }
    }

    /**
     * Called when a MicroBlocks device has been discovered. We clear the
     * serial port discovery timeout and add an array field to the mock device
     * to store incoming properties.
     *
     * @param {mockDevice} mock device object where we store all properties.
     */
    discoveredDevice(mockDevice) {
        if (mockDevice.serialPort.discoveryTimeout) {
            mockDevice.thingProperties = [];
            console.log(
                'found MicroBlocks device at',
                mockDevice.serialPort.path);
            clearTimeout(mockDevice.serialPort.discoveryTimeout);
            mockDevice.serialPort.discoveryTimeout = null;
        }
    }

    /**
     * Start a timeout of 2 seconds that waits for the device property
     * descriptions. If we don't get any in time, we close the connection
     * and we don't add this device.
     *
     * @param {mockDevice} mock device object where we store all properties.
     */
    setDescriptionTimeout(mockDevice) {
        const myself = this;
        if (!mockDevice.serialPort.descriptionTimeout) {
            mockDevice.serialPort.descriptionTimeout = setTimeout(function() {
                if (mockDevice.thingProperties.length > 0) {
                    console.log(
                        'Thing description at ',
                        mockDevice.serialPort.path,
                        'complete');
                    myself.addDevice(mockDevice);
                } else {
                    console.log(
                        'Incomplete description for thing at',
                        mockDevice.serialPort.path
                    );
                    mockDevice.serialPort.close();
                }
                clearTimeout(this);
                mockDevice.serialPort.descriptionTimeout = null;
            },
            2000);
        }
    }

    /**
     * Process and store variable names into the mock device, and ask for their
     * content too.
     *
     * @param {mockDevice} mock device object where we store all properties.
     * @param {objectId} MicroBlocks variable id
     * @param {varName} MicroBlocks variable name
     */
    processVariableName(mockDevice, objectId, varName) {
        mockDevice.variables[objectId] = {
            name: varName,
            id: objectId,
            value: 0
        };
        // let's ask for the var content
        mockDevice.serialPort.write([
            0xFA,           // short message
            0x07,           // getVar opCode
            objectId        // var ID
        ]);
    }

    /**
     * Process and store variable values into the mock device. If the variable
     * contains the thing's name or capability, we store those into the mock
     * device. Once we have both, our thing is defined and we can ask the board
     * to restart all its scripts so that we can intercept the property
     * description broadcasts.
     *
     * @param {mockDevice} mock device object where we store all properties.
     * @param {objectId} MicroBlocks variable id
     * @param {varValue} MicroBlocks variable content, properly typed
     */
    processVariableValue(mockDevice, objectId, varValue) {
        let variable = mockDevice.variables[objectId];
        variable.value = varValue;
        if (variable.name === '_wot_thingName') {
            mockDevice.thingName = varValue;
        } else if (variable.name === '_wot_thingCapability') {
            mockDevice.thingCapability = varValue;
        }
        if (!mockDevice.thingDefined &&
                mockDevice.thingName &&
                mockDevice.thingCapability) {
            mockDevice.thingDefined = true;
            // Thing is defined. Let's ask the board to restart all tasks so we
            // can receive its property definitions via broadcasts
            mockDevice.serialPort.write([
                0xFA,           // short message
                0x06,           // stopAll opCode
                0x00,           // object ID (irrelevant)
                0xFA,           // short message
                0x05,           // startAll opCode
                0x00            // object ID (irrelevant)
            ]);
        }
    }

    /**
     * Process a broadcast message coming from the board. If it describes a
     * thing property, we parse it and add it to our mock device's property
     * list.
     *
     * @param {mockDevice} mock device object where we store all properties.
     * @param {message} MicroBlocks message content, as a string
     */
    processBroadcast(mockDevice, message) {
        let property;
        if (message.indexOf('moz-property') === 0) {
            property = JSON.parse(message.substring(12));
            // get the variable name from the href: "/properties/varName" field
            property.ublocksVarName = property.href.substring(12);
            mockDevice.thingProperties.push(property);
            console.log('got property', property.title);
        }
    }

    /**
     * Pack a "set variable value" MicroBlocks serial message, including the
     * variable id and value and ready to be sent via serial port.
     *
     * @param {varId} MicroBlocks variable id
     * @param {value} MicroBlocks variable content
     * @return {Array} An array of bytes ready to be sent to the board.
     */
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

    /**
     * Pack a string as an array of bytes.
     *
     * @param {string} the string to be packed.
     * @return {Array} An array of bytes.
     */
    packString(string) {
        return string.split('').map(
            function (char) { return char.charCodeAt(0); }
        );
    }

    /**
     * Pack a value as an array of bytes in theMicroBlocks VM format, including
     * its type.
     *
     * @param {value} the value to be packed.
     * @param {typeName} the name of the value type. (boolean, int, string)
     * @return {Array} An array of bytes.
     */
    packValue(value, typeName) {
        // TODO string type not yet supported
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
    }
}

function loadMicroBlocksAdapter(addonManager, manifest, _errorCallback) {
    new MicroBlocksAdapter(addonManager, manifest.name);
}

module.exports = loadMicroBlocksAdapter;
