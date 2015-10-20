'use strict';

var util = require('util');
var fs = require('fs');
var Promise = require('promise');
var stream = require('stream');
var winston = require('winston');
var moment = require('moment');
var _ = require('lodash');
var retry = require('retry');
var elasticsearch = require('elasticsearch');

var defaultTransformer = require('./transformer');

/**
 * Constructor
 */
var Elasticsearch = function(options) {
  this.options = options || {};

  // Enforce context
  if (!(this instanceof Elasticsearch)) {
    return new Elasticsearch(options);
  }

  // Set defaults
  var defaults = {
    level: 'info',
    indexPrefix: 'logs',
    indexSuffixPattern: 'YYYY.MM.DD',
    messageType: 'log',
    fireAndForget: false,
    transformer: defaultTransformer,
    ensureMappingTemplate: true,
    consistency: 'one'
  };
  _.defaults(options, defaults);
  winston.Transport.call(this, options);

  // Use given client or create one
  if (options.client) {
    if (options.client instanceof elasticsearch.Client) {
      this.client = options.client;
      return this;
    } else {
      var msg = 'Client option passed was is an instance of ES Client';
      throw new TypeError(msg);
    }
  } else {
    // As we don't want to spam stdout, create a null stream
    // to eat any log output of the ES client
    var NullStream = function() {
      stream.Writable.call(this);
    };
    util.inherits(NullStream, stream.Writable);
    NullStream.prototype._write = function(chunk, encoding, next) {
      next();
    };

    var defaultClientOpts = {
      clientOpts: {
        log: [
          {
            type: 'stream',
            level: 'error',
            stream: new NullStream()
          }
        ]
      }
    };
    _.defaults(options, defaultClientOpts);

    // Create a new ES client
    // http://localhost:9200 is the default of the client already
    this.client = new elasticsearch.Client(this.options.clientOpts);
  }

  // Conduct connection check (sets connection state for further use)
  this.checkEsConnection().then(function(connectionOk) {});
  return this;
};

util.inherits(Elasticsearch, winston.Transport);

Elasticsearch.prototype.name = 'elasticsearch';

/**
 * log() method
 */
Elasticsearch.prototype.log = function log(level, message, meta, callback) {
  var thiz = this;

  if (callback && thiz.fireAndForget) {
    return callback(null);
  }

  // Don't think this is needed, TODO: check.
  // var args = Array.prototype.slice.call(arguments, 0);
  // Not sure if Winston always passed a callback and regulates number of args, but we are on the safe side here
  // callback = 'function' === typeof args[ args.length - 1 ] ? args[ args.length - 1 ] : function fallback() {};

  var logData = {
    message: message,
    level: level,
    meta: meta
  };
  var entry = this.options.transformer(logData);

  var esEntry = {
    index: this.getIndexName(this.options),
    consistency: this.options.consistency,
    type: this.options.messageType,
    body: entry
  };

  var operation = retry.operation({
    retries: 3,
    factor: 3,
    minTimeout: 0.5 * 1000,
    maxTimeout: 1 * 1000,
    randomize: false
  });

  return new Promise(function(fulfill, reject) {
    operation.attempt(function currentAttempt() {
      thiz.client.index(esEntry).then(
        function(res) {
          callback(null, res);
        },
        function(err) {
          if (operation.retry(err)) {
            return;
          }
          thiz.esConnection = false;
          thiz.emit('error', err);
          reject(false);
        });
    });
  });
};

Elasticsearch.prototype.getIndexName = function(options) {
  var now = moment();
  var dateString = now.format(options.indexSuffixPattern);
  var indexName = options.indexPrefix + '-' + dateString;
  return indexName;
};

Elasticsearch.prototype.checkEsConnection = function() {
  var thiz = this;

  var operation = retry.operation({
    retries: 10,
    factor: 3,
    minTimeout: 1 * 1000,
    maxTimeout: 60 * 1000,
    randomize: false
  });

  return new Promise(function(fulfill, reject) {
    operation.attempt(function currentAttempt() {
      thiz.client.ping().then(
        function(res) {
          thiz.esConnection = true;
          // Ensure mapping template is existing if desired
          if (thiz.options.ensureMappingTemplate) {
            thiz.ensureMappingTemplate(fulfill, reject);
          } else {
            fulfill(true);
          }
        },
        function(err) {
          if (operation.retry(err)) {
            return;
          }
          thiz.esConnection = false;
          thiz.emit('error', err);
          reject(false);
        });
    });
  });
};

Elasticsearch.prototype.search = function(q) {
  var indexName = this.getIndexName(this.options);
  var query = {
    index: indexName,
    q: q
  };
  return this.client.search(query);
};

Elasticsearch.prototype.ensureMappingTemplate = function(fulfill, reject) {
  var thiz = this;
  var mappingTemplate = thiz.options.mappingTemplate;
  if (mappingTemplate === null || typeof mappingTemplate === 'undefined') {
    var template = fs.readFileSync('./index-template-mapping.json', 'utf8');
    mappingTemplate = JSON.parse(template);
  }
  var tmplCheckMessage = {
    name: 'template_' + thiz.options.indexPrefix
  };
  thiz.client.indices.getTemplate(tmplCheckMessage).then(
    function(res) {
      fulfill(res);
    },
    function(res) {
      if (res.status && res.status === 404) {
        var tmplMessage = {
          name: 'template_' + thiz.options.indexPrefix,
          create: true,
          body: mappingTemplate
        };
        thiz.client.indices.putTemplate(tmplMessage).then(
        function(res) {
          fulfill(res);
        },
        function(err) {
          reject(err);
        });
      }
    });
};

module.exports = winston.transports.Elasticsearch = Elasticsearch;
