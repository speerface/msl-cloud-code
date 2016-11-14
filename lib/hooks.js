var Promise = require( 'bluebird' );
var Response  = require( './response' );

var hooks = ( function() {

    var _instance = {};

    var hooks = {
        beforeSave: {},
        afterSave: {},
        beforeDelete: {},
        afterDelete: {},
        functions: {},
        jobs: {}
    };

    _instance.beforeSave = function( objectType, callback ){
        if ( 'undefined' == typeof hooks.beforeSave[ objectType ] ) {
            hooks.beforeSave[ objectType ] = [];
        }

        hooks.beforeSave[ objectType ].push( callback );
    };

    _instance.afterSave = function( objectType, callback ){
        if ( 'undefined' == typeof hooks.afterSave[ objectType ] ) {
            hooks.afterSave[ objectType ] = [];
        }

        hooks.afterSave[ objectType ].push( callback );
    };

    _instance.beforeDelete = function( objectType, callback ){
        if ( 'undefined' == typeof hooks.beforeDelete[ objectType ] ) {
            hooks.beforeDelete[ objectType ] = [];
        }

        hooks.beforeDelete[ objectType ].push( callback );
    };

    _instance.afterDelete = function( objectType, callback ){
        if ( 'undefined' == typeof hooks.afterDelete[ objectType ] ) {
            hooks.afterDelete[ objectType ] = [];
        }

        hooks.afterDelete[ objectType ].push( callback );
    };

    _instance.define = function( functionName, callback ) {
        hooks.functions[ functionName ] = callback;
    };

    _instance.trigger = function( triggerType, objectType, request ) {

        return new Promise( function( resolve, reject ) {

            var promises = [];

            if ( 'undefined' !== typeof hooks[ triggerType ] && 'undefined' !== typeof hooks[ triggerType ][ objectType ] ) {
                for ( var i = 0; i < hooks[ triggerType ][ objectType ].length; i++ ) {
                    var deferred = Response.defer();
                    hooks[ triggerType ][ objectType ][ i ]( request, deferred );
                    promises.push( deferred.promise );
                }
            }

            Promise.all( promises ).then( function( data ) {
                resolve( data );
            });
        });

    };

    _instance.triggerFunction = function( name, request ) {
        return new Promise( function( resolve, reject ) {
            if ( 'undefined' !== typeof hooks['functions'][ name ] ) {
                var deferred = Response.defer();
                hooks['functions'][ name ]( request, deferred );
                resolve( deferred.promise );
            }
        });
    };

    return _instance;

}() );

module.exports = hooks;