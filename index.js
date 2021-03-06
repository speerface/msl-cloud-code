var express    = require('express');
var Parse      = require('parse/node');
var cloud      = require('./lib/cloud');
var CloudCode  = require('./lib/hooks');
var scheduler  = require('./lib/scheduler');
var bodyParser = require('body-parser');
var Promise    = require('bluebird');
var app        = express();

app.use( bodyParser.urlencoded( { extended: false } ) );
app.use( bodyParser.json() );

app.post( '/function/:functionName', function(req, res) {
   var functionName = req.params.functionName,
       body         = req.body,
       app_id       = req.get( 'x-parse-application-id' );

    Parse.initialize( app_id, "zVw4LTe6k2QmD4n2L2gPdMradqoobe5QXTwsirHE" );
    Parse.serverURL = 'https://api.ga.mysupplylive.com/1';

    CloudCode.triggerFunction( functionName, body ).then( function( response ) {
        res.send( JSON.stringify( response ) );
    });
});

app.post( '/beforeSave', function(req, res) {
    var type   = req.body.type,
        data   = req.body.data,
        isNew  = req.body.new,
        user   = req.body.user,
        app_id = req.get( 'x-parse-application-id' );

    parseObject( isNew, type, data, app_id ).then( function( obj ) {
        CloudCode.trigger( 'beforeSave', type, { object: obj, user: user } ).then( function( response ){
            res.send( JSON.stringify( response ) );
            return;
        });
    });
});

app.post( '/afterSave', function(req, res) {
    var type   = req.body.type,
        data   = req.body.data,
        isNew  = false,
        user   = req.body.user,
        app_id = req.get( 'x-parse-application-id' );

    parseObject( isNew, type, data, app_id ).then( function( obj ) {

        if ( Object.keys(obj).length === 0 && obj.constructor === Object ) {
            res.send( JSON.stringify( { 'error': 'Could not connect to api server.' } ) );
            return;
        }

        console.log( 'trigger afterSave for ' + type + ' by user ' + user + ' with data ' + JSON.stringify( data ) );

        CloudCode.trigger( 'afterSave', type, { object: obj, user: user } ).then( function( response ){
            res.send( JSON.stringify( response ) );
            return;
        });
    });
});

app.post( '/beforeDelete', function(req, res) {
    var type   = req.body.type,
        data   = req.body.data,
        isNew  = false,
        user   = req.body.user,
        app_id = req.get( 'x-parse-application-id' );

    parseObject( isNew, type, data, app_id ).then( function( obj ) {
        CloudCode.trigger( 'beforeDelete', type, { object: obj, user: user } ).then( function( response ){
            res.send( JSON.stringify( response ) );
            return;
        });
    });
});

app.post( '/afterDelete', function(req, res) {

    var type   = req.body.type,
        data   = req.body.data,
        isNew  = false,
        user   = req.body.user,
        app_id = req.get( 'x-parse-application-id' );

    parseObject( isNew, type, data, app_id ).then( function( obj ) {
        CloudCode.trigger( 'afterDelete', type, { object: obj, user: user } ).then( function( response ){
            res.send( JSON.stringify( response ) );
            return;
        });
    });
});

app.listen(3000, function(){
    scheduler.initTasks();
});

function parseObject( isNew, type, data, app_id ) {

    Parse.initialize( app_id, "zVw4LTe6k2QmD4n2L2gPdMradqoobe5QXTwsirHE" );
    Parse.serverURL = 'https://api.ga.mysupplylive.com/1';

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
                    return;
                },
                function( error ) {
                    console.log( error );
                    resolve( {} );
                    return;
                }
            );
        }
    });


}