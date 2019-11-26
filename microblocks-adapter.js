/**
 * microblocks-adapter.js - MicroBlocks adapter implemented as a plugin.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const crypto = require('crypto');
const manifest = require('./manifest.json');
const SerialPort = require('serialport');
const {
  Adapter,
  Device,
  Property,
  Event,
} = require('gateway-addon');

// Adapter

class MicroBlocksProperty extends Property {
  constructor(device, description, variable) {
    super(device, variable.name, description);
    const myself = this;
    variable.property = this;
    this.unit = description.unit;
    this.ublocksVarId = description.ublocksVarId;
    this.ublocksVarName = description.ublocksVarName;
    this.setCachedValue(description.value);
    this.requestingChange = false;
    this.device.notifyPropertyChanged(this);

    this.poller = setInterval(
      function() {
        myself.device.serialPort.write([
          0xFA,                 // short message
          0x07,                 // getVarValue opCode
          myself.ublocksVarId,  // var ID
        ]);
      },
      1000
    );
  }

  /**
   * @method setValue
   * @returns a promise which resolves to the updated value.
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value, clientOnly) {
    if (!clientOnly) {
      this.requestingChange = true;
    }
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
  constructor(adapter, mockThing) {
    const shasum = crypto.createHash('sha1');
    shasum.update(mockThing.name);
    mockThing.id = `microblocks-${shasum.digest('hex')}`;
    super(adapter, mockThing.id);

    const myself = this;
    this.name = mockThing.name;
    this.id = mockThing.id;
    this.type = mockThing.capability ? mockThing.capability[0] : 'thing';
    this['@type'] = mockThing.capability;
    this.serialPort = mockThing.serialPort;
    this.variables = mockThing.variables;

    mockThing.properties.forEach(function(description) {
      const variable = myself.findVar(description.ublocksVarName);
      description.value = variable.value;
      description.ublocksVarId = variable.id;
      myself.properties.set(
        description.ublocksVarName,
        new MicroBlocksProperty(myself, description, variable)
      );
    });
    mockThing.events.forEach(function(description) {
      myself.addEvent(description.name, description.metadata);
    });
  }

  notifyPropertyChanged(property, clientOnly) {
    super.notifyPropertyChanged(property);
    if (!clientOnly) {
      const variable = this.findVar(property.ublocksVarName);
      this.serialPort.write(
        this.adapter.packSetVariableMessage(
          variable.id,
          property.value,
          variable.type));
    }
  }

  findVar(varName) {
    return this.variables.find(function(variable) {
      return variable.name === varName;
    });
  }
}

class MicroBlocksAdapter extends Adapter {

  constructor(addonManager) {
    super(addonManager, manifest.name, manifest.id);
    // boards are indexed by name
    this.devices = new Map();
    addonManager.addAdapter(this);

    this.startPairing();
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

  addDevice(mockThing) {
    if (!this.devices.has(mockThing.id)) {
      console.log('adding new thing named', mockThing.name);
      const device = new MicroBlocksDevice(this, mockThing);
      this.devices.set(device.id, device);
      this.handleDeviceAdded(device);
      return device;
    } else {
      console.log('found existing thing named', mockThing.name);
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
      thing.properties.forEach(function(property) {
        clearInterval(property.poller);
      });
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
   * everything into a mock thing instance until the whole definition is
   * complete, and only then we create a new MicroBlocksDevice.
   *
   * @param {port} serial port object to probe.
   */
  probePort(port) {
    if (port.vendorId) {
      const serialPort =
        new SerialPort(port.comName, {baudRate: 115200});

      const mockThing = {
        buffer: [],
        variables: [],
        serialPort: serialPort,
        properties: [],
        events: [],
      };

      serialPort.on('data', (data) => {
        mockThing.buffer = mockThing.buffer.concat(data.toJSON().data);
        this.processBuffer(mockThing);
      });

      serialPort.on('open', function() {
        console.log(`probing ${port.comName}`);
        // We ask the board to restart all tasks so we can receive its
        // thing and property definitions via broadcasts. We also ask
        // for all its variable names.
        serialPort.write([
          0xFA,       // short message
          0x05,       // startAll opCode
          0x00,       // object ID (irrelevant)
        ]);

        this.discoveryTimeout = setTimeout(function() {
          console.log(`Port ${port.comName} timed out`);
          serialPort.close();
          clearTimeout(this);
          serialPort.discoveryTimeout = null;
        }, 1000);
      });

      serialPort.on('close', (err) => {
        if (err && err.disconnected) {
          console.log('removing device at', port.comName,
                      'because it was unplugged');
          const device = this.devices.get(mockThing.id);
          if (!device) {
            console.warn('Unable to remove device associated with', mockThing);
            return;
          }
          this.removeThing(device).then(() => {
            mockThing.serialPort = null;
          });
        } else {
          console.log('device at', port.comName, 'successfully disconnected');
        }
      });
    }
  }

  /**
   * Process the current serial port buffer to see if there's a complete
   * message to be parsed, and parse it if so.
   *
   * @param {mockThing} mock thing object where we store all properties.
   */
  processBuffer(mockThing) {
    const check = mockThing.buffer[0];
    const opCode = mockThing.buffer[1];
    const objectId = mockThing.buffer[2];
    const dataSize = mockThing.buffer[3] | mockThing.buffer[4] << 8;

    if (check === 0xFB) {
      this.discoveredDevice(mockThing);
      // long message
      if (mockThing.buffer.length >= dataSize + 5) {
        // message is complete
        if (opCode === 0x1D) {
          // variableName message is complete
          this.processVariableName(
            mockThing,
            objectId,
            this.getPayload(mockThing, dataSize)
          );
        } else if (opCode === 0x15) {
          // variableValue opCode
          this.processVariableValue(
            mockThing,
            objectId,
            this.getPayload(mockThing, dataSize),
            this.getPayloadType(mockThing)
          );
        } else if (opCode === 0x1B) {
          // broadcast opCode
          this.processBroadcast(
            mockThing,
            this.getPayload(mockThing, dataSize)
          );
        } else if (opCode === 0x14) {
          // outputValue opCode (for debugging)
          console.log('device says:', this.getPayload(mockThing, dataSize));
        }
        mockThing.buffer = mockThing.buffer.slice(5 + dataSize);
        // there may be the start of a new message left to process
        this.processBuffer(mockThing);
      }
    } else if (check === 0xFA) {
      // short message
      mockThing.buffer = mockThing.buffer.slice(3);
      // there may be the start of a new message left to process
      this.processBuffer(mockThing);
    } else {
      // missed a message header, or we're not talking to a µBlocks board
      const checkIndex = mockThing.buffer.indexOf(0xFB);
      if (checkIndex > -1) {
        // our message starts somewhere in the middle of the buffer
        mockThing.buffer = mockThing.buffer.slice(checkIndex);
        this.processBuffer(mockThing);
      } else {
        mockThing.buffer = [];
      }
    }
  }

  /**
   * Read the payload of the message being currently processed
   *
   * @param {dataSize} amount of bytes to read.
   * @return {int, boolean, string} the parsed value in its proper type.
   */
  getPayload(mockThing, dataSize) {
    const typeByte = this.getPayloadType(mockThing);
    if (typeByte === -1) {
      // not a variable, get the full string
      return String.fromCharCode.apply(
        null,
        mockThing.buffer.slice(5, 5 + dataSize));
    } else if (typeByte === 1) {
      // int
      return (mockThing.buffer[9] << 24) | (mockThing.buffer[8] << 16) |
            (mockThing.buffer[7] << 8) | (mockThing.buffer[6]);
    } else if (typeByte === 2) {
      // string
      return String.fromCharCode.apply(
        null,
        mockThing.buffer.slice(6, 5 + dataSize));
    } else if (typeByte === 3) {
      // boolean
      return mockThing.buffer[6] === 1;
    }
  }

  /**
   * Determine the type of the payload of the message being currently
   * process. Only makes sense for variables.
   *
   * @return {int} MicroBlocks variable type byte.
   */
  getPayloadType(mockThing) {
    if (mockThing.buffer[5] <= 3) {
      return mockThing.buffer[5];
    } else {
      return -1;
    }
  }

  /**
   * Called when a MicroBlocks device has been discovered. We clear the
   * serial port discovery timeout.
   *
   * @param {mockThing} mock thing object where we store all properties.
   */
  discoveredDevice(mockThing) {
    if (mockThing.serialPort.discoveryTimeout) {
      console.log(
        'found MicroBlocks device at',
        mockThing.serialPort.path);
      clearTimeout(mockThing.serialPort.discoveryTimeout);
      mockThing.serialPort.discoveryTimeout = null;
    }
  }

  /**
   * Start a timeout of 2 seconds that waits for the device property
   * descriptions. If we don't get any in time, we understand the device has no
   * properties.
   *
   * @param {mockThing} mock thing object where we store all properties.
   */
  setPropertiesTimeout(mockThing) {
    const myself = this;
    if (!mockThing.serialPort.propertiesTimeout) {
      mockThing.serialPort.propertiesTimeout = setTimeout(function() {
        console.log(
          'Thing description at ',
          mockThing.serialPort.path,
          'complete');
        myself.addDevice(mockThing);
        clearTimeout(this);
        mockThing.serialPort.propertiesTimeout = null;
      }, 2000);
    }
  }

  /**
   * Process and store variable names into the mock thing, and ask for their
   * content too.
   *
   * @param {mockThing} mock thing object where we store all properties.
   * @param {objectId} MicroBlocks variable id
   * @param {varName} MicroBlocks variable name
   */
  processVariableName(mockThing, objectId, varName) {
    mockThing.variables[objectId] = {
      name: varName,
      id: objectId,
      value: 0,
      type: 'unknown',
    };
    // let's ask for the var value
    mockThing.serialPort.write([
      0xFA,       // short message
      0x07,       // getVarValue opCode
      objectId,   // var ID
    ]);
  }

  /**
   * Process and store variable values into the mock thing. If the variable
   * contains the thing's name or capability, we store those into the mock
   * device. Once we have both, our thing is defined and we can ask the board
   * to restart all its scripts so that we can intercept the property
   * description broadcasts.
   *
   * @param {mockThing} mock thing object where we store all properties.
   * @param {objectId} MicroBlocks variable id
   * @param {varValue} MicroBlocks variable content, properly typed
   * @param {varType} MicroBlocks variable type string (boolean, int, string)
   */
  processVariableValue(mockThing, objectId, varValue, type) {
    const variable = mockThing.variables[objectId];
    if (variable) {
      variable.value = varValue;
      variable.type = type;
      if (variable.property) {
        // second parameter asks to not notify this update back to µBlocks
        if (!variable.property.requestingChange) {
          variable.property.setValue(varValue, true);
        } else {
          variable.property.requestingChange = false;
        }
      }
    }
  }

  /**
   * Process a broadcast message coming from the board. If it describes a
   * thing property, we parse it and add it to our mock thing's property
   * list.
   *
   * @param {mockThing} mock thing object where we store all properties.
   * @param {message} MicroBlocks message content, as a string
   */
  processBroadcast(mockThing, message) {
    let json;
    if (message.indexOf('moz-thing') === 0) {
      try {
        json = JSON.parse(message.substring(9));
      } catch (err) {
        console.log('moz-thing message was corrupt');
        json = {};
      }
      if (json.name) {
        mockThing.name = json.name;
        mockThing.capability = json['@type'];
        this.setPropertiesTimeout(mockThing);
        console.log('found thing description');
        mockThing.serialPort.write([
          0xFA,       // short message
          0x09,       // getVarNames opCode
          0x00,       // object ID (irrelevant)
        ]);
      }
    } else if (message.indexOf('moz-property') === 0) {
      try {
        json = JSON.parse(message.substring(12));
      } catch (err) {
        console.log('moz-property message was corrupt');
        json = {};
      }
      if (json.href) {
        // get the variable name from the href: "/properties/varName" field
        json.ublocksVarName = json.href.substring(12);
        mockThing.properties.push(json);
        console.log('registered property', json.title);
      }
    } else if (message.indexOf('moz-event') === 0) {
      try {
        json = JSON.parse(message.substring(9));
      } catch (err) {
        console.log('moz-event message was corrupt');
        json = {};
      }
      if (json.name) {
        mockThing.events.push(json);
        console.log('registered event', json.name);
      }
    } else {
      const device = this.getDevice(mockThing.id);
      if (device) {
        const eventDescription = device.events.get(message);
        if (eventDescription) {
          console.log('got event', message);
          device.eventNotify(new Event(device, message));
        }
      }
    }
  }

  /**
   * Pack a "set variable value" MicroBlocks serial message, including the
   * variable id, type and value and ready to be sent via serial port.
   *
   * @param {varId} MicroBlocks variable id
   * @param {value} MicroBlocks variable content
   * @return {Array} An array of bytes ready to be sent to the board.
   */
  packSetVariableMessage(varId, value, type) {
    let message = [0xFB, 0x08, varId];
    const data = this.packValue(value, type).concat(0xFE);
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
    return string.split('').map(function(char) {
      return char.charCodeAt(0);
    });
  }

  /**
   * Pack a value as an array of bytes in theMicroBlocks VM format, including
   * its type.
   *
   * @param {value} the value to be packed.
   * @param {typeName} the name of the value type. (boolean, int, string)
   * @return {Array} An array of bytes.
   */
  packValue(value, type) {
    if (type === 1) {
      // int
      const level = Math.floor(value);
      return [
        1,
        level & 255,
        (level >> 8) & 255,
        (level >> 16) & 255,
        (level >> 24) & 255,
      ];
    } else if (type === 2) {
      // string
      return [ 2 ].concat(this.packString(value));
    } else if (type === 3) {
      // boolean
      return [ 3, value && 1 || 0 ];
    }
  }
}

function loadMicroBlocksAdapter(addonManager) {
  new MicroBlocksAdapter(addonManager);
}

module.exports = loadMicroBlocksAdapter;
