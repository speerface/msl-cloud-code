var CloudCode = require( './hooks' );
var Parse     = require( 'parse/node' );
var response  = require( './response' );

var cloud = ( function() {
    var _instance = {};

    Parse.initialize( "uDurhUNh3PWciPFDcUH2DgsKGkbsNCSYg9sd8J3K", "zVw4LTe6k2QmD4n2L2gPdMradqoobe5QXTwsirHE" );
    Parse.serverURL = 'http://192.168.0.13/1';

    CloudCode.beforeSave( 'Action', function( request ) {
        return response.error( 'Action has encountered an error' );
    });

    CloudCode.afterDelete( 'Action', function( request ) {
        console.log( 'about to log!' );
        var deletedObject = request.object;
        var Log = Parse.Object.extend( 'Log' );
        var deleteLog = new Log();
        var requestUser = request.user;
        if ('undefined' === typeof deletedObject ) {
            var errorText = 'Could not save a delete log, no object provided';
            deleteLog.set('error', errorText);
        } else {
            deleteLog.set('guid',deletedObject.get('guid'));
            deleteLog.set('deletedData', JSON.stringify(deletedObject));
            deleteLog.set('user', requestUser);
        }
        deleteLog.save().then( function( response ){
            console.log( 'response from log create:' + response );
            return response.success( 'saved delete log' );
        },function( error ) {
            console.log( 'error fro log create' + JSON.stringify( error ) );
        });

    }); // afterDelete Action

    return _instance;
}() );

module.exports = cloud;