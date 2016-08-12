var winston = require( 'winston' );

var log = ( function() {
    var _instance = {};

    _instance.info = function( message ) {
        winston.info( message, { timestamp: Date.now() } );
    };

    _instance.warn = function( message ) {
        winston.warn( message, { timestamp: Date.now() } );
    };

    _instance.error = function( message ) {
        winston.error( message, { timestamp: Date.now() } );
    };


    return _instance;
}() );

module.exports = log;