/*
    uprotocol.js

    µBlocks protocol implementation

    written by John Maloney, Jens Mönig, and Bernat Romagosa
    http://microblocks.fun

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.

    Copyright 2018 John Maloney, Bernat Romagosa, and Jens Mönig
*/

var Protocol;

// Protocol //////////////////////////////////////////////////

// µBlocks message protocol
// I interpret messages received via the µBlocks postal service and dispatch them
// to my client.
//
// The dispatcher should define a ublocksDispatcher object holding the following
// functions:
//
// getSerialPortListResponse: function (portList, protocol)
// serialConnectResponse: function (success, portPath, protocol)
// serialDisconnectResponse: function (success, portPath, protocol)
// boardUnplugged: function (portPath, protocol)
// boardReconnected: function (portPath, protocol)
// taskStarted: function (taskId, protocol)
// taskDone: function (taskId, protocol)
// taskReturned: function (data, taskId, protocol)
// taskError: function (data, taskId, protocol)
// variableValue: function (data, varIndex, protocol)
// outputValue: function (data, taskId, protocol)
// broadcast: function (data, taskId, protocol)
// vmVersion: function (data, taskId, protocol)
// varName: function (data, varId, protocol)
//
// These functions will be executed with the client as the caller, so you can
// reference it by using the "this" pseudovariable. The protocol instance is also
// passed to these functions as the last parameter.

function Protocol (client) {
    this.init(client);
};

Protocol.prototype.init = function (client) {
    this.messageBuffer = [];
    this.client = client;
};

Protocol.prototype.processRawData = function (data) {
    this.messageBuffer = this.messageBuffer.concat(data);
    this.parseMessage();
};

Protocol.prototype.clearBuffer = function () {
    this.messageBuffer = [];
};

Protocol.prototype.packString = function (string) {
    return string.split('').map(function (char) { return char.charCodeAt(0); });
};

Protocol.prototype.parseMessage = function () {
    var check = this.messageBuffer[0],
        isLong = check == 0xFB,
        opCode = this.messageBuffer[1],
        descriptor, dataSize;

    if (check !== 0xFA && check !== 0xFB) {
        // We probably connected to the board while it was sending a message
        // and missed its header.
        this.clearBuffer();
        return;
    }

    if (!opCode) {
        // We haven't yet gotten our opCode, let's wait for it.
        return;
    }

    descriptor = this.descriptorFor(opCode);

    if (isLong && this.messageBuffer.length >= 5) {
        dataSize = this.messageBuffer[3] | this.messageBuffer[4] << 8;
        if (this.messageBuffer.length >= dataSize + 5) {
            // The message is complete, let's parse it.
            this.processMessage(descriptor, dataSize);
            this.messageBuffer = this.messageBuffer.slice(5 + dataSize);
            this.parseMessage();
        }
    } else if (!isLong && this.messageBuffer.length >= 3) {
        // this message carries no data and is complete
        this.processMessage(descriptor);
        this.messageBuffer = this.messageBuffer.slice(3);
        this.parseMessage();
    }
};

Protocol.prototype.processMessage = function (descriptor, dataSize) {
    var data,
        taskId = this.messageBuffer[2];

    if (dataSize) {
        data = this.messageBuffer.slice(5, 5 + dataSize);
    }

    if (descriptor.selector === 'jsonMessage') {
        value =
            this.processJSONMessage(JSON.parse(String.fromCharCode.apply(null, data)));
    } else {
        if (dataSize) {
            this.client.ublocksDispatcher[descriptor.selector].call(this.client, data, taskId, this);
        } else {
            this.client.ublocksDispatcher[descriptor.selector].call(this.client, taskId, this);
        }
    }
};

Protocol.prototype.processJSONMessage = function (json) {
    this.client.ublocksDispatcher[json.selector].apply(
        this.client,
        json.arguments.concat(this),
    );
};

Protocol.prototype.processReturnValue = function (rawData) {
    var type = rawData[0],
        value;

    if (type === 1) {
        // integer
        value = (rawData[4] << 24) | (rawData[3] << 16) | (rawData[2] << 8) | (rawData[1]);
    } else if (type === 2) {
        // string
        value = this.processString(rawData.slice(1));
    } else if (type === 3) {
        // boolean
        value = rawData.slice(1) == 1;
    }

    return (value === null) ? 'unknown type' : value;
};

Protocol.prototype.processString = function (rawData) {
    return String.fromCharCode.apply(null, rawData);
};

Protocol.prototype.processErrorValue = function (rawData) {
    // rawData[0] contains the error code
    return this.descriptorFor('taskError').dataDescriptor[rawData[0]] || 'Unspecified Error';
};

Protocol.prototype.packMessage = function (selector, taskId, data) {
    var descriptor = this.descriptorFor(selector),
        message = [descriptor.isLong ? 0xFB : 0xFA, descriptor.opCode, taskId];

    if (data) {
        if (descriptor.isLong) {
            data = data.concat(0xFE);
        }
        // add the data size in little endian
        message = message.concat(data.length & 255).concat((data.length >> 8) & 255);
        // add the data
        message = message.concat(data);
    }

    return message;
};

Protocol.prototype.descriptorFor = function (selectorOrOpCode) {
    return this.descriptors.find(
        function (descriptor) {
            if (typeof selectorOrOpCode === 'string') {
                return descriptor.selector === selectorOrOpCode;
            } else {
                return descriptor.opCode === selectorOrOpCode;
            }
        }
    );
};

// Message descriptors

Protocol.prototype.descriptors = [
    // IDE → Board
    {
        opCode: 0x01,
        selector: 'storeChunk',
        isLong: true
    },
    {
        opCode: 0x02,
        selector: 'deleteChunk'
    },
    {
        opCode: 0x03,
        selector: 'startChunk'
    },
    {
        opCode: 0x04,
        selector: 'stopChunk'
    },
    {
        opCode: 0x05,
        selector: 'startAll'
    },
    {
        opCode: 0x06,
        selector: 'stopAll'
    },
    {
        opCode: 0x07,
        selector: 'getVar'
    },
    {
        opCode: 0x08,
        selector: 'setVar',
        isLong: true
    },
    {
        opCode: 0x09,
        selector: 'getVarNames'
    },

    {
        opCode: 0x0A,
        selector: 'deleteVar'
    },
    {
        opCode: 0x0B,
        selector: 'deleteComment'
    },
    {
        opCode: 0x0C,
        selector: 'getVmVersion'
    },
    {
        opCode: 0x0D,
        selector: 'getAllChunks'
    },
    {
        opCode: 0x0E,
        selector: 'deleteAll'
    },
    {
        opCode: 0x0F,
        selector: 'systemReset'
    },

    // Board → IDE
    {
        opCode: 0x10,
        selector: 'taskStarted'
    },
    {
        opCode: 0x11,
        selector: 'taskDone'
    },
    {
        opCode: 0x12,
        selector: 'taskReturned',
        isLong: true
    },
    {
        opCode: 0x13,
        selector: 'taskError',
        dataDescriptor: {
            0: 'No error',
            1: 'Unspecified error',
            2: 'Bad chunk index',
            10: 'Insufficient memory to allocate object',
            11: 'Needs an Array or ByteArray',
            12: 'Needs a boolean',
            13: 'Needs an integer',
            14: 'Needs a string',
            15: 'Those objects cannot be compared for equality',
            16: 'Array size must be a non-negative integer',
            17: 'Array index must be an integer',
            18: 'Array index out of range',
            19: 'A ByteArray can only store integer values between 0 and 255',
            20: 'Hexadecimal input must between between -1FFFFFFF and 1FFFFFFF',
            21: 'I2C device ID must be between 0 and 127',
            22: 'I2C register must be between 0 and 255',
            23: 'I2C value must be between 0 and 255',
            24: 'Attempt to access argument or local variable outside of a function',
        },
        isLong: true
    },
    {
        opCode: 0x14,
        selector: 'outputValue',
        isLong: true
    },
    {
        opCode: 0x15,
        selector: 'variableValue',
        isLong: true
    },
    {
        opCode: 0x16,
        selector: 'vmVersion',
        isLong: true
    },
    // Bidirectional
    {
        opCode: 0x1A,
        selector: 'ping'
    },
    {
        opCode: 0x1B,
        selector: 'broadcast',
        isLong: true
    },
    {
        opCode: 0x1C,
        selector: 'chunkAttribute',
        dataDescriptor: {
            0: 'chunkPosition',
            1: 'snapSource',
            2: 'gpSource'
        },
        isLong: true
    },
    {
        opCode: 0x1D,
        selector: 'varName',
        isLong: true
    },
    {
        opCode: 0x1E,
        selector: 'comment',
        isLong: true
    },
    {
        opCode: 0x1F,
        selector: 'commentPosition',
        isLong: true
    },

    // Bridge → IDE
    {
        opCode: 0xFF,
        selector: 'jsonMessage'
    }
];

if (typeof module !== 'undefined') {
    module.exports = Protocol;
}
