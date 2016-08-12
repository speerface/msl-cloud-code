var express    = require( 'express' );
var Parse      = require( 'parse/node' );
var cloud      = require( './lib/cloud' );
var CloudCode  = require( './lib/hooks' );
var bodyParser = require( 'body-parser' );
var app        = express();

app.use( bodyParser.urlencoded( { extended: false } ) );
app.use( bodyParser.json() );

app.post( '/function/:functionName', function(req, res) {
   var functionName = req.params.functionName,
       body = req.body;
    
    CloudCode.triggerFunction( functionName, body ).then( function( response ) {
        res.send( JSON.stringify( response ) );
    });
});

app.post( '/beforeSave', function(req, res) {
    var type  = req.body.type,
        data  = req.body.data,
        isNew = req.body.new,
        user  = req.body.user;

    parseObject( isNew, type, data ).then( function( obj ) {
        CloudCode.trigger( 'beforeSave', type, { object: obj, user: user } ).then( function( response ){
            res.send( JSON.stringify( response ) );
        });
    });
});

app.post( '/afterSave', function(req, res) {
    var type  = req.body.type,
        data  = req.body.data,
        isNew = false,
        user  = req.body.user;

    parseObject( isNew, type, data ).then( function( obj ) {
        CloudCode.trigger( 'afterSave', type, { object: obj, user: user } ).then( function( response ){
            res.send( JSON.stringify( response ) );
        });
    });
});

app.post( '/beforeDelete', function(req, res) {
    var type  = req.body.type,
        data  = req.body.data,
        isNew = false,
        user  = req.body.user;

    parseObject( isNew, type, data ).then( function( obj ) {
        CloudCode.trigger( 'beforeDelete', type, { object: obj, user: user } ).then( function( response ){
            console.log( response );
            res.send( JSON.stringify( response ) );
        });
    });
});

app.post( '/afterDelete', function(req, res) {

    var type  = req.body.type,
        data  = req.body.data,
        isNew = false,
        user  = req.body.user;

    parseObject( isNew, type, data ).then( function( obj ) {
        CloudCode.trigger( 'afterDelete', type, { object: obj, user: user } ).then( function( response ){
            res.send( JSON.stringify( response ) );
        });
    });
});

app.listen(3000, function () {
    Parse.initialize( "uDurhUNh3PWciPFDcUH2DgsKGkbsNCSYg9sd8J3K", "zVw4LTe6k2QmD4n2L2gPdMradqoobe5QXTwsirHE" );
    Parse.serverURL = 'http://192.168.0.13/1';
});

function parseObject( isNew, type, data ) {

    return new Promise( function( resolve, reject ) {
        var object = Parse.Object.extend( type );
        if ( isNew ) {
            var self = new object();
            for ( var key in data ) {

                self.set( key, data[key] );

            }
            resolve( self );
        } else {
            var query = new Parse.Query( object );
            query.get( data.objectId ).then(
                function( object ) {
                    resolve( object );
                },
                function( error ) {
                }
            );
        }
    });


}