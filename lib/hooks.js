var Promise = require( 'bluebird' );

var hooks = ( function() {

    var _instance = {};

    var hooks = {

        beforeSave: {},
        afterSave: {},
        beforeDelete: {},
        afterDelete: {}
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

    _instance.trigger = function( triggerType, objectType, request ) {

        var response = [];

        return new Promise( function( resolve, reject ) {
            if ( 'undefined' !== typeof hooks[ triggerType ] && 'undefined' !== typeof hooks[ triggerType ][ objectType ] ) {
                for ( var i = 0; i < hooks[ triggerType ][ objectType] .length; i++ ) {

                    var result = hooks[ triggerType ][ objectType ][ i ]( request );
                    response.push( result );
                    if ( 'undefined' !== typeof result && 'success' !== result.status ) {
                        break;
                    }
                }
            }

            resolve( response );
        });

    };

    return _instance;
}() );

module.exports = hooks;