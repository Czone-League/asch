var async = require('async');
var request = require('request');
var ip = require('ip');
var util = require('util');
var extend = require('extend');
var crypto = require('crypto');
var bignum = require('bignumber');
var Router = require('../utils/router.js');
var slots = require('../utils/slots.js')
var sandboxHelper = require('../utils/sandbox.js');
var shell = require('../utils/shell.js');

// Private fields
var modules, library, self, private = {}, shared = {};

private.headers = {};
private.loaded = false;
private.chainMessageCache = {};

// Constructor
function Transport(cb, scope) {
  library = scope;
  self = this;
  self.__private = private;
  private.attachApi();

  setImmediate(cb, null, self);
}

// Private methods
private.attachApi = function () {
  var router = new Router();

  router.use(function (req, res, next) {
    if (modules) return next();
    res.status(500).send({ success: false, error: "Blockchain is loading" });
  });

  router.post("/transactions", function (req, res) {
    if (modules.loader.syncing()) {
      return res.status(500).send({
        success: false,
        error: 'Blockchain is syncing'
      })
    }
    var lastBlock = modules.blocks.getLastBlock();
    var lastSlot = slots.getSlotNumber(lastBlock.timestamp);
    if (slots.getNextSlot() - lastSlot >= 12) {
      library.logger.error("OS INFO", shell.getInfo())
      library.logger.error("Blockchain is not ready", { getNextSlot: slots.getNextSlot(), lastSlot: lastSlot, lastBlockHeight: lastBlock.height })
      return res.status(200).json({ success: false, error: "Blockchain is not ready" });
    }

    res.set(private.headers);

    if (req.headers['magic'] !== library.config.magic) {
      return res.status(500).send({
        success: false,
        error: "Request is made on the wrong network",
        expected: library.config.magic,
        received: req.headers['magic']
      });
    }

    try {
      var transaction = library.base.transaction.objectNormalize(req.body.transaction);
      // transaction.asset = transaction.asset || {}
    } catch (e) {
      library.logger.error("Received transaction parse error", {
        raw: req.body,
        trs: transaction,
        error: e.toString()
      });
      return res.status(200).json({ success: false, error: "Invalid transaction body" });
    }

    library.sequence.add(function (cb) {
      library.logger.log('Received transaction ' + transaction.id + ' from http client');
      modules.transactions.processUnconfirmedTransaction(transaction, cb);
    }, function (err, transaction) {
      if (err) {
        library.logger.warn('Receive invalid transaction ' + transaction.id, err);
        let errMsg = err.message ? err.message : err.toString()
        res.status(200).json({ success: false, error: errMsg });
      } else {
        library.bus.message('unconfirmedTransaction', transaction, true);
        res.status(200).json({ success: true, transactionId: transaction.id });
      }
    });
  })

  router.use(function (req, res, next) {
    res.status(500).send({ success: false, error: "API endpoint not found" });
  });

  library.network.app.use('/peer', router);
}

private.hashsum = function (obj) {
  var buf = new Buffer(JSON.stringify(obj), 'utf8');
  var hashdig = crypto.createHash('sha256').update(buf).digest();
  var temp = new Buffer(8);
  for (var i = 0; i < 8; i++) {
    temp[i] = hashdig[7 - i];
  }

  return bignum.fromBuffer(temp).toString();
}

Transport.prototype.broadcast = function (topic, message) {
  modules.peer.publish(topic, message)
}

Transport.prototype.sandboxApi = function (call, args, cb) {
  sandboxHelper.callMethod(shared, call, args, cb);
}

// Events
Transport.prototype.onBind = function (scope) {
  modules = scope;
  private.headers = {
    os: modules.system.getOS(),
    version: modules.system.getVersion(),
    port: modules.system.getPort(),
    magic: modules.system.getMagic()
  }
}

Transport.prototype.onBlockchainReady = function () {
  private.loaded = true;
}

Transport.prototype.onPeerReady = function () {
  modules.peer.handle('commonBlock', function (req, res, next) {
    const query = req.params.body
    if (!Number.isInteger(query.max)) return res.send({ error: 'Field max must be integer' })
    if (!Number.isInteger(query.min)) return res.send({ error: 'Field min must be integer' })
    // TODO validate query.ids
    const max = query.max;
    const min = query.min;
    const ids = query.ids;
    (async () => {
      try {
        let blocks = await app.sdb.getBlocksByHeightRange(min, max)
        // app.logger.trace('find common blocks in database', blocks)
        if (!blocks || !blocks.length) {
          return res.send({ success: false, error: 'Blocks not found' })
        }
        blocks = blocks.reverse()
        let commonBlock = null
        for (let i in ids) {
          if (blocks[i].id === ids[i]) {
            commonBlock = blocks[i]
            break
          }
        }
        if (!commonBlock) {
          return res.send({ success: false, error: 'Common block not found' })
        }
        return res.send({ success: true, common: commonBlock });
      } catch (e) {
        app.logger.error('Failed to find common block: ' + e)
        return res.send({ success: false, error: 'Failed to find common block' })
      }
    })()
  });

  modules.peer.handle('blocks', function (req, res, next) {
    // TODO validate req.query.lastBlockId
    let query = req.params.body
    let blocksLimit = 200;
    if (query.limit) {
      blocksLimit = Math.min(blocksLimit, Number(query.limit))
    }

    (async function () {
      let lastBlockId = query.lastBlockId
      try {
        let lastBlock = await app.sdb.getBlockById(lastBlockId)
        if (!lastBlock) throw new Error('Last block not found: ' + lastBlockId)

        let minHeight = lastBlock.height + 1
        let maxHeight = minHeight + blocksLimit - 1
        let blocks = await app.sdb.getBlocksByHeightRange(minHeight, maxHeight)

        if (!blocks || !blocks.length) {
          return res.send({ blocks: [] })
        }

        maxHeight = blocks[blocks.length - 1].height
        let transactions = await app.sdb.findAll('Transaction', {
          condition: {
            height: { $gt: lastBlock.height, $lte: maxHeight }
          }
        })
        // app.logger.trace('Transport get blocks transactions', transactions)
        let firstHeight = blocks[0].height
        for (let i in transactions) {
          let t = transactions[i]
          let h = t.height
          let b = blocks[h - firstHeight]
          if (!!b) {
            if (!b.transactions) {
              b.transactions = []
            }
            b.transactions.push(t)
          }
        }
        res.send({ blocks: blocks });
      } catch (e) {
        app.logger.error('Failed to get blocks or transactions', e)
        return res.send({ blocks: [] });
      }
    })()
  })

  modules.peer.handle('votes', function (req, res, next) {
    // TODO validate req.params.query{height, id, signature}
    library.bus.message('receiveVotes', req.params.body.votes)
    res.send({})
  })

  modules.peer.handle('transactions', function (req, res, next) {
    res.send({ transactions: modules.transactions.getUnconfirmedTransactionList() });
  });

  modules.peer.handle('height', function (req, res, next) {
    res.send({
      height: modules.blocks.getLastBlock().height
    });
  });

  modules.peer.handle('chainRequest', function (req, res, next) {
    let params = req.params
    let query = req.params.body
    try {
      if (!params.chain) {
        return res.send({ success: false, error: "missed chain" });
      }
      if (!params.timestamp || !params.hash) {
        return res.status(200).json({
          success: false,
          error: "missed hash sum"
        });
      }
      var newHash = private.hashsum(query, params.timestamp);
      if (newHash !== params.hash) {
        return res.send({ success: false, error: "wrong hash sum" });
      }
    } catch (e) {
      library.logger.error('receive invalid chain request', { error: e.toString(), params: params })
      return res.send({ success: false, error: e.toString() });
    }

    modules.chains.request(params.chain, query.method, query.path, { query: params.query }, function (err, ret) {
      if (!err && ret.error) {
        err = ret.error;
      }

      if (err) {
        library.logger.error('failed to process chain request', err)
        return res.send({ success: false, error: err });
      }
      res.send(extend({}, { success: true }, ret));
    });
  });

  modules.peer.subscribe('block', function (message) {
    if (modules.loader.syncing()) {
      return
    }
    let block = message.body.block
    let votes = message.body.votes
    try {
      block = library.base.block.objectNormalize(block);
      votes = library.base.consensus.normalizeVotes(votes);
    } catch (e) {
      library.logger.log('normalize block or votes object error: ' + e.toString());
    }
    library.bus.message('receiveBlock', block, votes);
  })

  modules.peer.subscribe('propose', function (message) {
    if (typeof message.body.propose == 'string') {
      message.body.propose = library.protobuf.decodeBlockPropose(new Buffer(message.body.propose, 'base64'));
    }
    library.scheme.validate(message.body.propose, {
      type: "object",
      properties: {
        height: {
          type: "integer",
          minimum: 1
        },
        id: {
          type: "string",
          maxLength: 64,
        },
        timestamp: {
          type: "integer"
        },
        generatorPublicKey: {
          type: "string",
          format: "publicKey"
        },
        address: {
          type: "string"
        },
        hash: {
          type: "string",
          format: "hex"
        },
        signature: {
          type: "string",
          format: "signature"
        }
      },
      required: ["height", "id", "timestamp", "generatorPublicKey", "address", "hash", "signature"]
    }, function (err) {
      if (err) {
        library.logger.error('Received propose is invalid', { propose: message.body.propose, error: err })
        return
      }
      library.bus.message('receivePropose', req.body.propose);
    });
  });

  modules.peer.subscribe('transaction', function (message) {
    if (modules.loader.syncing()) {
      return
    }
    const lastBlock = modules.blocks.getLastBlock();
    const lastSlot = slots.getSlotNumber(lastBlock.timestamp);
    if (slots.getNextSlot() - lastSlot >= 12) {
      library.logger.error("OS INFO", shell.getInfo())
      library.logger.error("Blockchain is not ready", { getNextSlot: slots.getNextSlot(), lastSlot: lastSlot, lastBlockHeight: lastBlock.height })
      return
    }

    if (typeof message.body.transaction == 'string') {
      message.body.transaction = library.protobuf.decodeTransaction(new Buffer(message.body.transaction, 'base64'));
    }
    try {
      var transaction = library.base.transaction.objectNormalize(message.body.transaction);
    } catch (e) {
      library.logger.error("Received transaction parse error", {
        message: message,
        trs: transaction,
        error: e.toString()
      });
      return
    }

    library.sequence.add(function (cb) {
      library.logger.log('Received transaction ' + transaction.id + ' from remote peer');
      modules.transactions.processUnconfirmedTransaction(transaction, cb);
    }, function (err) {
      if (err) {
        library.logger.warn('Receive invalid transaction ' + transaction.id, err);
        let errMsg = err.message ? err.message : err.toString()
      } else {
        library.bus.message('unconfirmedTransaction', transaction, true);

      }
    });
  })

  modules.peer.subscribe('chainMessage', function (message) {
    try {
      if (!message.chain) {
        return
      }
      if (!message.timestamp || !message.hash) {
        return
      }
      var newHash = private.hashsum(message.body, message.timestamp);
      if (newHash !== message.hash) {
        return
      }
    } catch (e) {
      library.logger.error(e)
      library.logger.debug('receive invalid chain message', message)
      return
    }

    if (private.chainMessageCache[message.hash]) {
      return res.sendStatus(200);
    }

    private.chainMessageCache[message.hash] = true;
    modules.chains.message(message.chain, message.body, function (err, body) {
      if (!err && body.error) {
        err = body.error;
      }

      if (err) {
        library.logger.error('failed to process chain message', err)
        return
      }
      library.bus.message('message', req.body, true);
    });
  });
}

Transport.prototype.onUnconfirmedTransaction = function (transaction) {
  let message = {
    body: {
      transaction: transaction
    }
  }
  self.broadcast('transaction', message);
}

Transport.prototype.onNewBlock = function (block, votes) {
  let message = {
    body: {
      block: block, votes: votes
    }
  }
  self.broadcast('block', message)
}

Transport.prototype.onNewPropose = function (propose) {
  let message = {
    body: {
      propose: library.protobuf.encodeBlockPropose(propose).toString('base64')
    }
  }
  self.broadcast('propose', message);
}

Transport.prototype.sendVotes = function (votes, address) {
  let params = {
    body: {
      votes: votes
    }
  }
  const parts = address.split(':')
  const contact = {
    hostname: parts[0],
    port: parts[1]
  }
  const identity = modules.peer.getIdentity(contact)
  const target = [identity, contact]
  modules.peer.request('votes', params, contact, target, function (err) {
    if (err) {
      library.logger.error('send votes error', err)
    }
  })
}

Transport.prototype.onMessage = function (msg) {
  const message = {
    chain: msg.chain,
    body: msg
  }
  self.broadcast('chainMessage', message)
}

Transport.prototype.cleanup = function (cb) {
  private.loaded = false;
  cb();
}

// Shared
shared.message = function (msg, cb) {
  msg.timestamp = (new Date()).getTime();
  msg.hash = private.hashsum(msg.body, msg.timestamp);

  self.broadcast('chainMessage', msg);

  cb(null, {});
}

shared.request = function (req, cb) {
  req.timestamp = (new Date()).getTime();
  req.hash = private.hashsum(req.body, req.timestamp);

  if (req.body.peer) {
    modules.peer.request('chainRequest', req, req.body.peer, cb)
  } else {
    modules.peer.randomRequest('chainRequest', req, cb)
  }

}

// Export
module.exports = Transport;
