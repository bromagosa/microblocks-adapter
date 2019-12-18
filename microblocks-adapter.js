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
  constructor(device, description) {
    super(device, description.varName, description);
    const myself = this;
    this.unit = description.unit;
    this.title = description.title;
    this.name = description.varName;
    this.varName = description.varName;
    this.varID = null;
    this.varType = null;
    this.setCachedValue(description.value);
    this.requestingChange = false;
    this.device.notifyPropertyChanged(this);

    this.poller = setInterval(
      function() {
        if (myself.varID && !myself.requestingChange) {
          myself.device.serialPort.write([
            0xFA,          // short message
            0x07,          // getVarValue opCode
            myself.varID,  // var ID
          ]);
          myself.device.serialPort.drain();
        }
      },
      1000
    );
  }

  setValue(value) {
    return new Promise((resolve, reject) => {
      super.setValue(value).then((updatedValue) => {
        this.device.serialPort.write(
          this.device.adapter.packSetVariableMessage(
            this.varID,
            updatedValue,
            this.varType
          )
        );
        this.device.serialPort.drain();
        resolve(updatedValue);
        this.device.notifyPropertyChanged(this);
      }).catch((err) => {
        reject(err);
      });
    });
  }
}

class MicroBlocksDevice extends Device {
  constructor(adapter, thingDescription, serialPort, radioDeviceID) {
    super(adapter, thingDescription.id, serialPort);
    const myself = this;
    this.title = this.name = thingDescription.title || thingDescription.name;
    this.type = thingDescription.type;
    this['@context'] =
      thingDescription['@context'] || 'https://iot.mozilla.org/schemas';
    this['@type'] = thingDescription['@type'] || [];
    this.id = thingDescription.id;
    this.serialPort = serialPort;
    this.radioDeviceID = radioDeviceID;

    Object.keys(thingDescription.properties).forEach(function(varName) {
      let description = thingDescription.properties[varName];
      console.log('Adding property', description.title);
      description.varName = varName;
      myself.properties.set(
        varName,
        new MicroBlocksProperty(myself, description)
      );
    });
    if (thingDescription.events) {
      Object.keys(thingDescription.events).forEach(function(eventName) {
        let description = thingDescription.events[eventName];
        console.log('Registering event', eventName);
        myself.addEvent(eventName, description);
      });
    }
  }

  findPropertyByID(varID) {
    const myself = this;
    return [...this.properties.values()].find(function(property) {
      return property.varID === varID;
    });
  }
}

class MicroBlocksAdapter extends Adapter {

  constructor(addonManager) {
    super(addonManager, manifest.name, manifest.id);
    // boards are indexed by name
    this.devices = new Map();
    this.radioPackets = {};

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

  addDevice(serialPort, description, radioDeviceID) {
    this.discoveredDevice(serialPort);
    const shasum = crypto.createHash('sha1');
    shasum.update(description.title);
    description.id = `microblocks-${shasum.digest('hex')}`;
    if (!this.devices.has(description.id)) {
      const device =
        new MicroBlocksDevice(this, description, serialPort, radioDeviceID);
      this.devices.set(description.id, device);
      console.log('Adding thing "', description.title, '" with id', device.id);
      this.handleDeviceAdded(device);
      // Request variable IDs associated with device properties
      if (radioDeviceID) {
        serialPort.write(
          this.packBroadcastMessage('moz-get-vars' + radioDeviceID)
        );
      } else {
        serialPort.write([
          0xFA,       // short message
          0x09,       // getVarNames opCode
          0x00,       // object ID (irrelevant)
        ]);
      }
      serialPort.drain();
      return device;
    } else {
      console.log('Found existing thing named', description.title);
    }
  }

  deviceAtPort(serialPort, radioDeviceID) {
    return [...this.devices.values()].find(
      function (device) {
          return (device.serialPort === serialPort) &&
              (device.radioDeviceID === radioDeviceID);
      }
    );
  }

  cancelPairing() {
    // how to get to the serialport instance to close it?
  }

  /**
   * For cleanup between tests.
   */
  clearState() {
    this.actions = {};
    for (const deviceID in this.devices) {
      this.removeThing(this.devices[deviceID]);
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
        thing.serialPort = null;
      }
      this.devices.delete(thing.id);
      this.handleDeviceRemoved(thing);
      resolve(thing);
    });
  }

  /**
   * Test this port to see if there's a µBlocks device in it. If so, we create
   * a new thing with the description sent back by the device.
   *
   * @param {port} serial port object to probe.
   */
  probePort(port) {
    const myself = this;
    if (port.vendorId) {
      const serialPort =
        new SerialPort(port.comName, {baudRate: 115200});

      serialPort.buffer = [];

      serialPort.on('data', (data) => {
        serialPort.buffer = serialPort.buffer.concat(data.toJSON().data);
        this.processData(serialPort);
      });

      serialPort.on('open', function() {
        console.log(`Probing ${port.comName}`);
        // We ask the board to give us the value of the '_thing description'
        // variable
        serialPort.write([0xFA, 0x05, 0x00]); // startAll
        serialPort.drain();
        let message = [
          0xFB,       // long message
          0x07,       // getVarValue opCode
          0xFF,       // object ID (made up)
        ];
        const data = myself.packString('_thing description').concat(0xFE);
        // add the data size in little endian
        message.push(data.length & 255);
        message.push((data.length >> 8) & 255);
        // add the data to the message
        message = message.concat(data);
        serialPort.write(message);
        serialPort.drain();

        this.discoveryTimeout = setTimeout(function() {
          console.log(`Port ${port.comName} timed out`);
          serialPort.close();
          clearTimeout(this);
          serialPort.discoveryTimeout = null;
        }, 3000);
      });

      serialPort.on('error', (err) => {
        console.log('Serialport Error:', err);
      });

      serialPort.on('close', (err) => {
        if (err && err.disconnected) {
          console.log('removing device at', port.comName,
                      'because it was unplugged');
          const device = this.deviceAtPort(serialPort);
          if (!device) {
            console.warn('Unable to remove device at', port.comName);
            return;
          }
          this.removeThing(device);
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
   * @param {serialPort} the port through which this data is coming.
   */
  processData(serialPort) {
    const check = serialPort.buffer[0];
    const opCode = serialPort.buffer[1];
    const objectID = serialPort.buffer[2];
    const dataSize = serialPort.buffer[3] | serialPort.buffer[4] << 8;

    if (check === 0xFB) {
      // long message
      if (serialPort.buffer.length >= dataSize + 5) {
        // message is complete
        if (opCode === 0x1D) {
          // variableName message is complete
          this.processVariableName(
            serialPort,
            objectID,
            this.getPayload(serialPort.buffer, dataSize)
          );
        } else if (opCode === 0x15) {
          // variableValue opCode
          this.processVariableValue(
            serialPort,
            objectID,
            this.getPayload(serialPort.buffer, dataSize),
            this.getPayloadType(serialPort.buffer)
          );
        } else if (opCode === 0x1B) {
          // broadcast opCode
          this.processBroadcast(
            serialPort,
            this.getPayload(serialPort.buffer, dataSize)
          );
        } else if (opCode === 0x14) {
          // outputValue opCode (for debugging)
          console.log(
            'device says:',
            this.getPayload(serialPort.buffer, dataSize));
        } 
        serialPort.buffer = serialPort.buffer.slice(5 + dataSize);
        // there may be the start of a new message left to process
        this.processData(serialPort);
      }
    } else if (check === 0xFA) {
      // short message
      serialPort.buffer = serialPort.buffer.slice(3);
      // there may be the start of a new message left to process
      this.processData(serialPort);
    } else {
      // missed a message header, or we're not talking to a µBlocks board
      const checkIndex = serialPort.buffer.indexOf(0xFB);
      if (checkIndex > -1) {
        // our message starts somewhere in the middle of the buffer
        serialPort.buffer = serialPort.buffer.slice(checkIndex);
        this.processData(serialPort);
      } else {
        serialPort.buffer = [];
      }
    }
  }

  /**
   * Read the payload of the message being currently processed
   *
   * @param {dataSize} amount of bytes to read.
   * @return {int, boolean, string} the parsed value in its proper type.
   */
  getPayload(buffer, dataSize) {
    const typeByte = this.getPayloadType(buffer);
    if (typeByte === -1) {
      // not a variable, get the full string
      return String.fromCharCode.apply(
        null,
        buffer.slice(5, 5 + dataSize));
    } else if (typeByte === 1) {
      // int
      return (buffer[9] << 24) | (buffer[8] << 16) |
            (buffer[7] << 8) | (buffer[6]);
    } else if (typeByte === 2) {
      // string
      return String.fromCharCode.apply(
        null,
        buffer.slice(6, 5 + dataSize));
    } else if (typeByte === 3) {
      // boolean
      return buffer[6] === 1;
    }
  }

  /**
   * Determine the type of the payload of the message being currently
   * process. Only makes sense for variables.
   *
   * @return {int} MicroBlocks variable type byte.
   */
  getPayloadType(buffer) {
    if (buffer[5] <= 3) {
      return buffer[5];
    } else {
      return -1;
    }
  }

  /**
   * Called when a MicroBlocks device has been discovered. We clear the
   * serial port discovery timeout.
   *
   * @param {serialPort} port where the device has been discovered.
   */
  discoveredDevice(serialPort) {
    if (serialPort.discoveryTimeout) {
      console.log(
        'Found MicroBlocks device at',
        serialPort.path);
      clearTimeout(serialPort.discoveryTimeout);
      serialPort.discoveryTimeout = null;
    }
  }

  /**
   * Process variable values. If the variable contains a thing description,
   * we create a new device. Otherwise, we update the property value.
   *
   * @param {serialPort} port through which we got the message
   * @param {objectID} MicroBlocks message id (or variable id)
   * @param {varValue} MicroBlocks variable content, properly typed
   * @param {varType} MicroBlocks variable type string (boolean, int, string)
   */
  processVariableValue(serialPort, objectID, varValue, varType) {
    if (objectID === 0xFF) {
      // we found a new thing!
      let description = varValue;
      try {
        // fix incomplete thing descriptions
	if (description.endsWith(',')) {
          // close last property / event
          description = description.slice(0, -1) + '}}';
        } else if (description.endsWith('{')) {
          // no properties
          description = description + '}}';
        }
        this.addDevice(serialPort, JSON.parse(description));
        console.log('Thing description at', serialPort.path, 'complete');
      } catch (err) {
        console.error('Failed to add thing!');
        console.error(err);
        console.log(varValue);
      }
    } else {
      const device = this.deviceAtPort(serialPort);
      if (device) {
        const property = device.findPropertyByID(objectID);
        if (property) {
          // update type
          if (!property.varType) {
            console.log('Setting var type to', varType, 'for', property.title);
            property.varType = varType;
          }
          if (property.value !== varValue) {
            property.setCachedValue(varValue);
            device.notifyPropertyChanged(property);
          }
        }
      }
    }
  }

    /**
   * Process and store variable ids into corresponding properties, and ask for
   * their content too.
   *
   * @param {serialPort} port through which we got the message
   * @param {objectID} MicroBlocks variable id
   * @param {varName} MicroBlocks variable name
   */
  processVariableName(serialPort, objectID, varName) {
    const device = this.deviceAtPort(serialPort);
    if (device) {
      const property = device.properties.get(varName);
      if (property) {
        console.log(
          'Got id', objectID, 'for property', varName,
          'of device', device.name);
        property.varID = objectID;
        // let's ask for the property value
        serialPort.write([
          0xFA,       // short message
          0x07,       // getVarValue opCode
          objectID,   // var ID
        ]);
        serialPort.drain();
      }
    }
  }

  /**
   * Process a broadcast message coming from the board describing an event.
   * @param {serialPort} port through which we got the message
   * @param {message} MicroBlocks message content, as a string
   */
  processBroadcast(serialPort, message) {
    const isRadioPacket = message.startsWith('moz-packet');
    const radioDeviceID = isRadioPacket ? this.getRadioDeviceID(message) : null;
    const device = this.deviceAtPort(serialPort, radioDeviceID);
    if (device) {
      const contents =
            isRadioPacket ? this.extractRadioString(message) : message;
      console.log(contents);
      const eventDescription = device.events.get(contents);
      if (eventDescription) {
        console.log('Received event', contents);
        device.eventNotify(new Event(device, contents));
      }
    } else if (isRadioPacket) {
      // Turn string back into charCode array
      const byteArray =
            message.substring(11 + radioDeviceID.length).split(',').map(
              (s) => { return parseInt(s); }
            );
      this.processRadioPacket(serialPort, radioDeviceID, byteArray);
    }
  }

  getRadioDeviceID(message) {
    return message.substring(10).split(':')[0];
  }

  extractRadioString(message) {
    // Position is 10 (length of moz-packet) + 1 (: char) + length of device ID
    // We then remove all zeroes (null terminators) plus the first 4 elements
    // (protocol header)
    const byteArray =
          message.substring(
            11 + this.getRadioDeviceID(message).length).
            replace(/,0/g,'').split(',').slice(4);
    return String.fromCharCode.apply(null, byteArray);
  }

  processRadioPacket(serialPort, radioDeviceID, packet) {
    if (!packet[0] === 31) { return; }
    let index = packet[1]
    let strLength = packet[2]
    let crc = packet[3];
    const device = this.deviceAtPort(serialPort, radioDeviceID);
    if (!this.radioPackets[crc]) { this.radioPackets[crc] = []; }
    for (var i = 4; i < 32; i++) {
      if (packet[i] !== 0) {
        this.radioPackets[crc][((index - 1) * 28) + i - 4] = packet[i];
      }
    }
    let string = String.fromCharCode.apply(null, this.radioPackets[crc]);
    if (string.length === strLength) {
      // We got the last packet. Let's make sure CRCs match
      let computedCRC =
        this.radioPackets[crc].reduce((acc, current, i) => {
            return acc + (current * (i + 1));
        }, strLength) % 255;
      if (computedCRC === crc) {
        this.radioPackets[crc] = null;
        if (string.startsWith('{ "title": "')) {
          console.log('Got a radio thing!');
          this.addDevice(serialPort, JSON.parse(string), radioDeviceID);
        } else {
          //TODO Parse other messages? There may be no others
        }
      } else {
        // Ask the bridge to ask the board to resend
        // TODO The bridge doesn't yet listen for these messages
        serialPort.write(this.packBroadcastMessage('moz-resend' + crc));
      }
    }
  }

  /**
   * Pack a "broadcast" MicroBlocks serial message, including the
   * message payload.
   *
   * @param {message} MicroBlocks broadcast message content
   * @return {Array} An array of bytes ready to be sent to the board.
   */
  packBroadcastMessage(contents) {
    let message = [0xFB, 0x1B];
    const data = this.packValue(contents, 2).concat(0xFE); // 2 is string type
    // add the data size in little endian
    message.push(data.length & 255);
    message.push((data.length >> 8) & 255);
    // add the data to the message
    message = message.concat(data);
    return message;
  }

  /**
   * Pack a "set variable value" MicroBlocks serial message, including the
   * variable id, type and value and ready to be sent via serial port.
   *
   * @param {varID} MicroBlocks variable id
   * @param {value} MicroBlocks variable content
   * @return {Array} An array of bytes ready to be sent to the board.
   */
  packSetVariableMessage(varID, value, type) {
    let message = [0xFB, 0x08, varID];
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
   * Pack a value as an array of bytes in the MicroBlocks VM format, including
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
