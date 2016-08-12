var Promise = require( 'bluebird' ),
    INTERNAL = function(){};

var response = ( function() {
    var _instance = {};

    _instance.success = function( message ){
        return { status: 'success', message: message };
    };

    _instance.error = function( message ){
        return { status: 'error', message: message };
    };

    _instance.defer = Promise.pending = function() {
        var promise = new Promise(INTERNAL);
        return {
            promise: promise,
            resolve: deferResolve,
            reject: deferReject,
            success: function( message ) {
                this.resolve( { status: 'success', message: message } );
            },
            error: function( message ) {
                this.resolve( { status: 'error', message: message } );
            }
        };
    };

    function deferResolve(v) {this.promise._resolveCallback(v);}
    function deferReject(v) {this.promise._rejectCallback(v, false);}

    return _instance;
}() );

module.exports = response;