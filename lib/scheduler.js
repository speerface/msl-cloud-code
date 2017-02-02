var schedule  = require('node-schedule');
var CloudCode = require('./hooks');
var Parse     = require('parse/node');

var scheduler = ( function() {
    var _instance = {};

    _instance.initTasks = function() {

    };


    return _instance;
}() );

module.exports = scheduler;