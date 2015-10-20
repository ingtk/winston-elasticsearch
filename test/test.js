var util = require('util');
var fs = require('fs');
var should = require('should');
var winston = require('winston');
var elasticsearch = require('elasticsearch');

require('../index');
var defaultTransformer = require('../transformer');

var logMessage = JSON.parse(fs.readFileSync('./test/request_logentry_1.json', 'utf8'));

/*
 * Note: To run the tests, a running elasticsearch instance is required.
 */

describe('winston-elasticsearch:', function() {
  describe('the default transformer', function() {
    it('should transform logdata from winston into a lostash like structure', function (done) {
      var transformed = defaultTransformer({
        message: 'some message',
        level: 'error',
        meta: {
          someField: true
        }
      });
      should.exist(transformed['@timestamp']);
      transformed.severity.should.equal('error');
      transformed.fields.someField.should.be.true();
      done();
    });
  });

  describe('a transport given a faulty ES client', function() {
    it('should throw an exception', function(done) {
      try {
        new (winston.transports.Elasticsearch)({
          client: new elasticsearch.Client({
            host: 'http://localhost:9300'
          })
        });
      } catch (error) {
        done();
      }
    });
  });

  var logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Elasticsearch)({
      })
    ]
  });

  describe('a logger', function() {
    it('should log to Elasticsearch', function(done) {
      this.timeout(6000);
      logger.log(logMessage.level, logMessage.message, logMessage.meta,
        function (err, level, msg, meta) {
            should.not.exist(err);
            level.should.equal(logMessage.level);
            msg.should.equal(logMessage.message);
            // Short wait phase to make sure data is already written.
            setTimeout(function() {
              done();
            }, 1500);
        });
    });

    describe('the logged message', function() {
      it('should be found in the index', function(done) {
        logger.transports.elasticsearch.search('message:logmessage1').then(
          function(res) {
            res.hits.total.should.be.above(0);
            done();
          },
          function(err) {
            should.not.exist(err);
            done();
          });
      });
    });
  });
});
