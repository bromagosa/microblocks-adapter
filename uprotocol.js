/*

    protocol.js

    µBlocks protocol support for Snap!


    written by John Maloney, Jens Mönig, and Bernat Romagosa
    http://microblocks.fun

    Copyright (C) 2018 by John Maloney, Jens Mönig, Bernat Romagosa

    This file is part of Snap!.

    Snap! is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of
    the License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

*/

function detect(list, predicate) {
    // answer the first element of list for which predicate evaluates
    // true, otherwise answer null
    var i, size = list.length;
    for (i = 0; i < size; i += 1) {
        if (predicate.call(null, list[i])) {
            return list[i];
        }
    }
    return null;
}

var Protocol;

// Protocol //////////////////////////////////////////////////

// µBlocks message protocol
// I interpret and dispatch messages received via the µBlocks postal service

function Protocol (owner) {
    this.init(owner);
};

Protocol.prototype.init = function (owner) {
    this.messageBuffer = [];
    this.owner = owner;
};

Protocol.prototype.processRawData = function (data) {
    this.messageBuffer = this.messageBuffer.concat(data);
    this.parseMessage();
};

Protocol.prototype.clearBuffer = function () {
    this.messageBuffer = [];
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
            this.dispatcher[descriptor.selector].call(this, data, taskId);
        } else {
            this.dispatcher[descriptor.selector].call(this, taskId);
        }
    }
};

Protocol.prototype.processJSONMessage = function (json) {
    this.dispatcher[json.selector].apply(
        this.owner,
        json.arguments
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

    return isNil(value) ? 'unknown type' : value;
};

Protocol.prototype.processString = function (rawData) {
    return String.fromCharCode.apply(null, rawData);
};

Protocol.prototype.processErrorValue = function (rawData) {
    // rawData[0] contains the error code
    return this.descriptorFor('taskError').dataDescriptor[rawData[0]] || 'Unspecified Error';
};

Protocol.prototype.packString = function (string) {
    return string.split('').map(function (char) { return char.charCodeAt(0); });
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
    return detect(
        this.descriptors,
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

Protocol.prototype.dispatcher = {
    // JSON messages
    getSerialPortListResponse: function (portList) {
    },
    serialConnectResponse: function (success, portPath) {
    },
    serialDisconnectResponse: function (success, portPath) {
    },
    boardUnplugged: function (portPath) {
    },
    boardReconnected: function (portPath) {
    },

    // µBlocks messages
    taskStarted: function (taskId) {
    },
    taskDone: function (taskId) {
    },
    taskReturned: function (data, taskId) {
    },
    taskError: function (data, taskId) {
    },
    variableValue: function (data, varIndex) {
        console.log('var ' + this.varIndex + ' is ' + this.processReturnValue(data));
    },
    outputValue: function (data, taskId) {
        console.log('task ' + taskId + ' says ' + this.processReturnValue(data));
    },
    broadcast: function (data, taskId) {
        this.owner.receiveBroadcast(this.processString(data));
    },
    vmVersion: function (data) {
        var versionString = this.processString(data),
            vmVersion = versionString.substring(1).replace(/ .*/,''),
            boardType = versionString.replace(/.* /, '');
        console.log('board is a ' + boardType + ' and runs µBlocks ' + vmVersion);
    },
    varName: function (data, varId) {
        this.owner.addVariable(this.processString(data), varId);
    }
};

module.exports = Protocol;
