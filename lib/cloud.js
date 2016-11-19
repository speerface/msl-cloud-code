var CloudCode = require( './hooks' );
var Parse     = require( 'parse/node' );
var winston   = require( 'winston' );
var log       = require( './log' );
var _         = require( 'underscore' );
var twilio    = require( 'twilio' );
var rp        = require('request-promise');
require( 'winston-loggly' );

winston.add(winston.transports.Loggly, {
    subdomain: 'mslcloud',
    inputToken: '21e52f59-7e9c-4523-b348-e9e06212da8d',
    json: true
});

var toLogDeletes = ['Action','DataPoint','Facility','Field','Geofence','Hybrid','Inbred','MSLDocument','UserProfile','UserProfileActionSet','FieldActionSet'];

var cloud = ( function() {
    var _instance = {};

    for ( var i = 0; i < toLogDeletes.length; i++ ) {
        var currentClass = toLogDeletes[i];

        CloudCode.afterDelete( currentClass, function( request, response ) {
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
                response.success( 'saved delete log' );
            },function( error ) {
                response.error( JSON.stringify( error ) );
            });
        });
    }

    CloudCode.beforeSave( 'Field', function( request, response ) {
        var savedField = request.object;
        var dirtyKeys  = savedField.dirtyKeys();

        console.log( 'Field ' + savedField.get( 'guid' ) + ' has dirty keys ' + dirtyKeys );

        var geofenceChanged = (_.indexOf( dirtyKeys, 'geofence', false ) >= 0);
        if ( geofenceChanged ) {
            var Field = Parse.Object.extend( 'Field' );
            var oldFieldQuery = new Parse.Query( Field );
            oldFieldQuery.equalTo( 'guid', savedField.get( 'guid' ) );

            oldFieldQuery.first().then( function( existingField ) {
                var oldGeofence = existingField.get( 'geofence' );
                console.log( 'Geofence was changed from ' + oldGeofence + ' to ' + savedField.get( 'geofence' ) );
                var installation = request.installationId;
                var user         = request.user;

                var GeofenceLog = Parse.Object.extend( 'GeofenceLog' );
                var geofenceLog = new GeofenceLog();
                geofenceLog.set( 'field', savedField.get( 'guid' ) );
                geofenceLog.set( 'savedData', JSON.stringify( savedField ) );
                if ( oldGeofence ) {
                    geofenceLog.set( 'old', oldGeofence );
                }
                geofenceLog.set( 'new', savedField.get( 'geofence' ) );

                if ( installation ) {
                    console.log( 'Installation ' + installation );
                    geofenceLog.set( 'installation', installation );
                }
                if ( user ) {
                    console.log( 'User ' + user.toPointer() );
                    geofenceLog.set( 'user', user.toPointer() );
                }
                console.log( 'Field: ' + JSON.stringify( savedField ) );
                geofenceLog.save();
                response.success();
            } );
        } else {
            response.success();
        }
    });

    CloudCode.beforeSave( 'TransactionLog', function( request, response ) {

        var savedLog     = request.object;
        var targetGuid   = savedLog.get( 'targetGuid' );
        var effectedGuid = savedLog.get( 'effectedGuid' );

        if ( !targetGuid && effectedGuid ) {
            savedLog.set( 'targetGuid', effectedGuid );
        }

        response.success();
    });

    CloudCode.beforeSave( 'Action', function( request, response ) {

        var savedAction       = request.object;
        var currentActionType = savedAction.get( 'subclassName' );
        var actionColumn      = savedAction.get( 'Action' );

        if ( ! currentActionType ) {
            if ( actionColumn ) {
                savedAction.set( 'subclassName', actionColumn );
            }
        }

        if ( ! actionColumn ) {
            if ( currentActionType ) {
                savedAction.set( 'Action', currentActionType );
            }
        }

        response.success();
    });

    CloudCode.afterSave( 'Action', function( request, response ) {
        var item          = request.object,
            type          = item.get( 'subclassName' ),
            priority      = item.get( 'priority' ),
            fieldGuid     = item.get( 'fieldGuid' ),
            enabled       = true,
            userActionSet = item.get( 'userActionSet' );

        // Send SMS to users if High Priority Field Visit
        if ( enabled && 'FieldVisit' === type && 'High' === priority ) {

            var query = new Parse.Query( 'Field' ),
                scope = {};

            query.equalTo( 'guid', fieldGuid );
            query.first().then( function( field ) {

                scope.name = field.get( 'fieldNumber' );
                scope.fieldUsers = field.get( 'users' );

                var user_action_query = new Parse.Query( 'UserProfileActionSet' ),
                    user_action_set   = userActionSet;

                user_action_query.equalTo( 'guid', user_action_set );

                return user_action_query.first();
            }).then( function( action_set ) {

                var user_query = new Parse.Query( 'UserProfile' ),
                    user_profile = action_set.get( 'userProfile' );

                user_query.equalTo( 'guid', user_profile );
                return user_query.first();
            }).then( function( user_profile ) {

                var role = user_profile.get( 'role' ),
                    other_users_query = new Parse.Query( 'UserProfile' );

                other_users_query.greaterThanOrEqualTo( 'role', 28 );
                other_users_query.containedIn( 'guid', scope.fieldUsers );
                other_users_query.limit( 500 );

                return other_users_query.find();
            }).then( function( other_users ) {

                var profiles = [],
                    other_users_query = new Parse.Query( 'User' );

                for ( var i = 0; i < other_users.length; i++ ) {
                    profiles.push( other_users[i].get( 'guid' ) );
                }

                other_users_query.containedIn( 'userProfile', profiles );
                other_users_query.exists( 'phoneNumber' );
                other_users_query.limit( 500 );

                return other_users_query.find();
            }).then( function( users ) {

                logMessage( JSON.stringify( users ), 'Send Twilio Message for field ' + scope.name );

                var numbers = [];

                for ( var i = 0; i < users.length; i++ ) {
                    numbers.push( users[i].get( 'phoneNumber' ) );
                }

                for ( var n = 0; n < numbers.length; n++ ) {
                    var number = numbers[n];
                    sendFieldInspectionSMS( number, scope.name );
                }

                response.success( 'Done sending messages' );
            });

            return;
        }

        response.success( 'Did not run.' );
    });

    CloudCode.afterSave( 'Action', function( request, response ) {
        var savedAction = request.object;
        var isDeleted = savedAction.get('deleted');
        var actionType = savedAction.get('subclassName');

        var item      = request.object,
            type      = item.get( 'subclassName' ),
            priority  = item.get( 'priority' ),
            fieldGuid = item.get( 'fieldGuid' ),
            Field     = Parse.Object.extend( 'Field' );
            enabled   = true;

        var query = new Parse.Query(Field);
        query.equalTo("actionSet", request.object.get("fieldActionSet"));
        query.equalTo( 'deleted', false);

        if (actionType == 'Planting'){

            query.first({

                success: function(field) {

                    field.set('isPlanted', true);

                    if (request.object.get("female") == true) {

                        if (!field.get('plantingDate')) {

                            // only set the planting date property of Field objects if there isn't one already set
                            // we want the value of plantingDate to be the FIRST time
                            // female was planted
                            var plantingDate = request.object.get("endTime");
                            if (plantingDate) {
                                field.set("plantingDate", plantingDate);
                            }
                        }
                    } else {
                        console.log('female not set for this planting!');
                    }

                    field.save();

                    response.success( 'Finished' );
                }, error: function(error) {
                    console.error("Got an error " + error.code + " : " + error.message);
                    response.error( "Got an error " + error.code + " : " + error.message );
                }
            });
        } else if (actionType == 'Harvest') {

            query.first({

                success: function(field) {

                    var endTime = savedAction.get('endTime');
                    if (endTime) {
                        field.set('harvestDate', endTime);
                    }
                    field.set('isHarvested', true);
                    field.save();
                    response.success( 'Finished' );
                },
                error: function(error) {
                    console.error("Got an error " + error.code + " : " + error.message);
                }

            });
            return;
        }

        response.success( 'Did not run' );
    });

    CloudCode.afterSave( 'Action', function( request, response ) {
        var item      = request.object,
            type      = item.get( 'subclassName' );

        if ( 'YieldEstimate' == type ) {
            var query     = new Parse.Query( 'Field' ),
                guid      = savedAction.get( 'guid' ),
                fieldGuid = savedAction.get( 'fieldGuid' );

            query.equalTo( 'guid', fieldGuid );
            query.equalTo( 'deleted', false);
            query.first({

                success: function( field ) {

                    if ( field ) {
                        field.set( 'latestYieldEstimate', guid );

                        console.log( 'all done updating yieldestimate' );
                    }
                    field.set('isEstimated', true);
                    field.save();
                    response.success( 'Finished' );
                },
                error: function( error ) {
                    console.log( error );
                }
            });
        }

        response.success( 'Did not run' );
    });

    CloudCode.afterSave( 'Action', function( request, response ) {
        var item  = request.object,
            type  = item.get( 'subclassName' ),
            Field = Parse.Object.extend( 'Field' );

        var query = new Parse.Query(Field);
        query.equalTo("actionSet", request.object.get("fieldActionSet"));
        query.equalTo( 'deleted', false);

        if ( 'Detasseling' == type) {

            query.first({

                success: function( field ) {

                    field.set( 'isDetasseled', 'True');
                    field.save(null, {
                        success: function (field) {
                            response.success( 'Saved ' + field.get( 'grower' ) + ' for field ' + field.get( 'guid' ) );
                        },
                        error: function (field, error) {
                            response.success( error.message );
                        }
                    });
                }
            });

        } else {
            response.success( 'Did not run detasseling bidness' );
        }

    });

    CloudCode.afterSave( 'Action', function( request, response ) {

        var savedAction = request.object;

        if ( savedAction.get( 'endTime' ) && !savedAction.get( 'inProgress' ) ) {

            // modify query
            query = new Parse.Query( 'FieldActionSet' );
            query.equalTo("guid", request.object.get("fieldActionSet"));
            // we will get the field for the action to set it as the last completed action
            query.first({

                success: function(fieldActionSet) {
                    if (fieldActionSet) {
                        fieldActionSet.set("lastAction", savedAction.get("guid"));
                        fieldActionSet.save();

                        response.success( 'Finished' );
                    }
                },
                error: function(error) {
                    console.error("Got an error " + error.code + " : " + error.message);
                }
            });

            return;
        }

        response.success( 'Did not run' );
    });

    CloudCode.define("currentWeatherForFields", function(request, response) {
        console.log( request );
        var query = new Parse.Query('WeatherInfo');
        query.containedIn('field', request.params.fields);
        query.descending("weatherDate");
        query.limit(MAX_QUERY_LIMIT)
        query.find().then(function(objects) {

            var returned_objects = [],
                fields_array     = request.params.fields;

            for ( var i = 0; i < objects.length; i++ ) {
                var weather = objects[i],
                    field   = weather.get( 'field' ),
                    index   = fields_array.indexOf( field );

                if ( 0 === fields_array.length ) {
                    break;
                }

                if ( index !== -1 ) {
                    returned_objects.push( weather );
                    fields_array.splice( index, 1 );
                }

            }

            response.success( returned_objects );
        }, function(error) {
            console.log('error fetching current weather');
            pushErrorMessageToAdministrator(error);
            response.error(error);
        });
    });

    // Takes a Field GUID as input parameter and returns an array of key-value pairs, representing
// all of the GDU data for that field.  The dates are keys, the values are GDUs.
// @param fieldGUID  The GUID of the field to retrieve GDU data
// @return Array  An array of key-value pairs, with dates as keys and GDUs as value (int)
    CloudCode.define('allGDUDataForField', function(request, response) {

        var query = new Parse.Query('Field');
        query.equalTo('guid', request.params.fieldGUID);
        query.first().then(function(field) {

            if (field.get('plantingDate')) {

                var weatherInfoQuery = new Parse.Query('DailyWeatherSummary');
                weatherInfoQuery.equalTo('field', field.get('guid'));
                weatherInfoQuery.addAscending('date');
                weatherInfoQuery.limit(1000);
                weatherInfoQuery.find().then(function(weatherSummaries) {

                    var gduDataPoints = [];
                    _.each(weatherSummaries, function(weatherSummary) {

                        if (weatherSummary.get('date') && weatherSummary.get('gdu')) {
                            var dataPoint = {};
                            dataPoint['date'] = weatherSummary.get('date');
                            dataPoint['gdu'] = weatherSummary.get('gdu');
                            dataPoint['hiTemp'] = weatherSummary.get('hiTemp');
                            dataPoint['loTemp'] = weatherSummary.get('loTemp');
                            dataPoint['field'] = weatherSummary.get('field');
                            gduDataPoints.push(dataPoint);
                        }

                    }); // each weatherSummary loop
                    response.success(gduDataPoints);

                }, function(error) {
                    console.error('Error finding DailyWeatherSummaries ' + error.code + ':' + error.message);
                    pushErrorMessageToAdministrator(error);
                    response.error(error);
                }); // weatherInfoQuery
            } else {
                console.error('Field must have planting date in order to return GDU data.');
                response.error();
            }
        }, function(error) {
            console.error('Error finding field: ' + error.code + ':' + error.message);
            pushErrorMessageToAdministrator(error);
            response.error(error);
        }); // first query
    });

    CloudCode.define( 'testFunction', function( request, response ) {
        pushErrorMessageToAdministrator( 'Testing errors' );
        // var Field = Parse.Object.extend( 'Field' ),
        //     query = new Parse.Query( Field );
        //
        // query.first().then( function( object ) {
        //     console.log( object );
        //     response.success( object.get( 'guid' ) );
        // },
        // function( error ) {
        //     console.log( error );
        //     response.error( 'error' );
        // });
    });

    CloudCode.define("currentWeather", function(request, status) {
        var Field = Parse.Object.extend("Field");
        var query = new Parse.Query(Field);
        query.limit(1000);
        query.notEqualTo("deleted", true);

        query.find().then(function(results) {

            console.log( 'Number of fields grabbed: ' + results.length );

            // Pull weather info for field from forecast.io

            var promises = [];

            _.each(results, function(result) {
                var field = result;
                var baseURL = 'https://api.forecast.io/forecast/41362740878deb6113f15b79ae3280bd/';
                // console.log('weather for ' + field.get("guid"));
                var latitude = field.get("latitude");
                var longitude = field.get("longitude");

                if (latitude && longitude) {

                    var requestURL = baseURL + latitude + ',' + longitude;
                    // console.log('Requesting data for ' + requestURL);
                    promises.push( rp( requestURL ).then(function(httpResponse) {
                            return onWeatherInfoSuccess(httpResponse, field);
                        }).catch( function(error) {
                            console.log('CurrentWeather error with ' + field.get('guid') + ' : ' + JSON.stringify(error));
                            pushErrorMessageToAdministrator(error);
                            // return field.save();
                            return Parse.Promise.as();
                        }) // httpRequest

                    );

                }
            }); //each loop

            return Parse.Promise.when(promises);

        }).then(function() {
            status.success('Completed currentWeather job.');
        }, function(error) {
            console.log('Error in currentWeather job: ' + JSON.stringify(error));

            status.success('Current weather error ' + error.code + error.message);
            // pushErrorMessageToAdministrator(error);
        }); // query.find

    });

    CloudCode.define("EndGDUDataOnHarvest", function(request, status) {

        var query = new Parse.Query(Field);
        query.limit(1000);
        // query.skip(100);
        query.notEqualTo("deleted", true);
        // query.equalTo('guid', 'Field-0001A');
        // added to constrain query.  Remove is issues discovered with data
        query.doesNotExist('harvestDate');

        query.find().then(function(results) {
            console.log("Found " + results.length + " fields.");

            var count = 0;

            var promise = Parse.Promise.as();

            // var promises = [];
            _.each(results, function(field) {

                promise = promise.then(function() {

                    // console.log("Checking field " + field.get("guid"));

                    var harvestQuery = new Parse.Query(Harvest);
                    harvestQuery.equalTo("field", field.get("guid"));
                    harvestQuery.notEqualTo("deleted", true);
                    harvestQuery.descending("startTime");

                    // promises.push(

                    return harvestQuery.first().then(function(harvest) {

                        // found a valid Harvest for the field
                        if (harvest) {
                            // console.log("Setting harvestDate for " + field.get("guid") + " to be " + harvest.get('startTime'));
                            return field.save({
                                harvestDate: harvest.get('startTime')
                            }, function(error) {
                                // console.log("Error saving harvestDate for " + field.get('guid') + error.code + error.message);
                                return Parse.Promise.error("Error saving harvestDate");
                            });
                        } else {
                            // console.log('Could not find harvest for ' + field.get('guid'));
                            return Parse.Promise.error('No harvest found');
                        }

                    }).then(function(updatedField) {

                        if (!updatedField) {
                            // console.log('Skipping the summary lookup');
                            return Parse.Promise.error('No updated Field');
                        }
                        // field now has a harvestDate set

                        // console.log('remove extra daily summaries for ' + updatedField.get('guid'));

                        var DailyWeatherSummary = Parse.Object.extend("DailyWeatherSummary");
                        var weatherQuery = new Parse.Query(DailyWeatherSummary);
                        weatherQuery.equalTo("field", updatedField.get("guid"));
                        weatherQuery.greaterThan("date", updatedField.get('harvestDate'));
                        weatherQuery.limit(MAX_QUERY_LIMIT);

                        return weatherQuery.find();

                    }).then(function(results) {
                        if (!results) {
                            return Parse.Promise.error('No summary results');
                        }
                        // console.log("Found " + results.length + " weather summaries to delete for " + field.get('guid'));
                        return Parse.Object.destroyAll(results);

                    }, function(error) {

                        // console.log("Error with " + field.get('guid') + " " + error.code + " " + error.message);
                        return Parse.Promise.as("Finish after handling error for " + field.get('guid'));

                    }).then(function() {

                        // console.log('COMPLETED ' + field.get('guid'));
                        count++;
                        if ((count % 10) == 0) {
                            // need to throttle the logs, as we only get 100 logs per execution
                            console.log('Completed ' + count);
                        }
                    });
                }); //extend promise with .then()
            });// _.each(results, function())
            // console.log("About to return Promise.when with " + promises.length + " promises.");
            // return Parse.Promise.when(promises);
            return promise;
        }).then(function() {
            console.log('Resolved all Promises. Job complete.');

            status.success("Completed GDU Harvest Job");
        }, function(error) {
            console.log('Something REALLY bad happened!');

            status.error("Something bad happened! **code: " + error.code + " **message: "+ error.message);
        }); // end of query

    });

    CloudCode.define('RangeOfDailySummaries', function(request, status) {

        var parameters = JSON.parse(request.params);
        if (!parameters) {
            status.error('No parameters provided.');
        }

        var startDate = parameters.startDate;
        var endDate = parameters.endDate;
        if (!startDate) {
            startDate = new Date();
        } else {
            startDate = new Date(startDate.iso);
        }
        if (!endDate) {
            endDate = new Date();
        } else {
            endDate = new Date(endDate.iso);
        }

        var fieldNumber = parameters.fieldNumber;
        var loopDate = startDate;

        var promises = [];

        while(startDate <= endDate) {

            console.log('Submitting for date ' + JSON.stringify(startDate));
            var params = {"date" : startDate, "fieldNumber" : fieldNumber };

            // var datePromise = new Parse.Promise(function() {
            //  getDailyWeatherSummariesForDateRange(params).then(function() {
            //      datePromise.resolve('Completed ' + fieldNumber);
            //  }, function(error) {
            //      datePromise.reject(error);
            //  });
            // });

            // promises.push(datePromise);
            promises.push(getDailyWeatherForDate(params));
            // .then(function() {
//                  return;
//              }, function(error) {
//
//              })
            // );
            // .then(function() {
//              console.log(success);
//          }, function(error) {
//              console.error('Error ' + JSON.stringify(error));
//          })
            // ); //push promise

            var newDate = startDate.setDate(startDate.getDate() + 1);
            startDate = new Date(newDate);

        }

        Parse.Promise.when(promises).then(function() {
            status.success('Completed Date Range function');
        },function(error) {
            console.error('Error with Date Range: ' + JSON.stringify(error));
            status.error('Could not complete Date Range function');
        });

    });

    CloudCode.define('DailyPrecipitation', function(request, status) {

        var query = new Parse.Query(Field);

        query.limit(MAX_QUERY_LIMIT);

        query.notEqualTo("deleted", true);
        query.notEqualTo('harvestCompleted', true);
        query.exists('latitude');
        query.exists('longitude');
        query.equalTo('fieldNumber', '1002A');

        query.find().then(function(fields) {

            var promises = [];
            var dateToUse = new Date();
            dateToUse.setDate(dateToUse.getDate() - 1);
            dateToUse.setHours(0);
            dateToUse.setMinutes(1);
            dateToUse.setSeconds(1);
            var httpDate = dateToUse.getTime() / 1000;
            console.log('HTTP date: ' + httpDate);
            _.each(fields, function(field) {
                var APP_ID = 'APPID=ee52af7a31f552c43524c334f213d0d1'
                var baseURL = 'http://pro.openweathermap.org/data/2.5/history/city?'
                var latitude = field.get('latitude');
                var longitude = field.get('longitude');
                var requestURL = baseURL + 'lat=' + latitude + '&lon=' + longitude + '&' + APP_ID + '&start=' + httpDate;
                console.log('Request URL: ' + requestURL);

                promises.push( rp( requestURL ).then(function(httpResponse) {
                        console.log('got a response at least');
                        return precipitationForResponse(httpResponse, field, dateToUse);

                    }).catch( function(error) {
                        console.error('error with ' + field.get('guid'));
                        console.error('Error: ' + JSON.stringify(error));
                        return field.save();
                    }) // httpRequest

                ); // push to promises

            }); // _.each loop

            return Parse.Promise.when(promises);

        }).then(function() {
            status.success('Completed DailyPrecipitation job');
        }, function(error) {
            console.error('DailyPrecipitation error ' + JSON.stringify(error));
            status.error('ERROR with DailyPrecipitation job');
        }); //query.find()

    });

    CloudCode.define("DailyWeatherSummary", function(request, status) {

        // var parameters = JSON.parse(request.params);
        var parameters = request.params;
        var fieldNumber;
        var dateParameter;
        if (parameters) {
            fieldNumber = parameters.fieldNumber;
            dateParameter = parameters.date;
        }

        // if (!dateParameter) {
        //
        //  status.error('No date passed in.  Date: ' + dateParameter + ' fieldNumber: ' + fieldNumber);
        //  return;
        // }

        var query = new Parse.Query(Field);

        if (fieldNumber) {
            query.equalTo("fieldNumber", fieldNumber);
        } else {
            query.limit(MAX_QUERY_LIMIT);
        }

        // console.log('Parameters, date: ' + JSON.stringify(dateParameter) + ' fieldNumber: ' + fieldNumber);

        query.notEqualTo("deleted", true);
        query.notEqualTo('harvestCompleted', true);
        query.exists('latitude');
        query.exists('longitude');

        query.find().then(function(results) {

            // Pull weather info for field from forecast.io

            var promises = [];
            var dateToUse;

            if (!dateParameter) {

                dateToUse = new Date();
                dateToUse.setDate(dateToUse.getDate() - 1);

            } else {

                dateToUse = dateParameter.iso;

            }

            var dateWrapper = moment(dateToUse);

            console.log('About to process each field.');

            _.each(results, function(result) {
                var field = result;
                var baseURL = 'https://api.forecast.io/forecast/41362740878deb6113f15b79ae3280bd/';
                // console.log('weather for ' + field.get("guid"));
                var latitude = field.get("latitude");
                var longitude = field.get("longitude");

                if (latitude && longitude) {

                    var requestURL = baseURL + latitude + ',' + longitude + ',' + dateWrapper.format();
                    // console.log('Requesting data for ' + requestURL);

                    promises.push(rp(requestURL).then(function(httpResponse) {
                            // console.log('got a response at least');
                            return onHistorySuccess(httpResponse, field, dateToUse);

                        }).catch( function(error) {
                            // console.error('error with ' + field.get('guid'));
                            // console.error('Error: ' + JSON.stringify(error));
                            return field.save();
                        }) // httpRequest

                    ); // push to promises
                    //
                } else {
                    // no latitude and longitude for the field.  Cannot get weather!
                    // console.error('No lat or long for field ' + field.get('fieldNumber'));
                    return;
                }

            }); //each loop

            return Parse.Promise.when(promises);

        }).then(function() {
            status.success('Completed DailyWeather job.');
        }, function(error) {
            pushErrorMessageToAdministrator(error);
            console.error('Full error object: ' + JSON.stringify(error));
            status.error('Error getting DailyWeather ' + error.code + ' ' + error.message);
        }); // query.find

    });

    CloudCode.define("CalculateEstimatedDates", function(request, status) {
        var query = new Parse.Query(Field);
        query.limit(MAX_QUERY_LIMIT);
        query.notEqualTo("deleted", true);
        query.doesNotExist('harvestDate');
        query.exists('latitude');
        query.exists('longitude');
        query.exists('plantingDate');
        // query.equalTo('fieldNumber','1012A');
        query.find().then(function(results) {

            // Pull DailyWeatherSummary info from Parse
            var fields = results;
            var promises = [];
            var facilityHarvestDays = new Object();
            facilityHarvestDays['Facility-MtPulaski'] = 50;
            facilityHarvestDays['Facility-CubaCity'] = 50;
            facilityHarvestDays['Facility-Howe'] = 55;

            // console.log('making facility-days');

            harvestDaysForAllFacilities().then(function(result) {

                // facilityHarvestDays = result;

                // console.log('all facilties days: ' + JSON.stringify(facilityHarvestDays));
                return Parse.Promise.as(fields);
                // console.log('found fields: ' + JSON.stringify(results));
            }).then(_.each(results, function(result) {
                var field = result;
                // console.log('checking field ' + field.get('fieldNumber'));

                var gduToSilk;
                var gduToHarvest;
                var accumulatedGDU;
                var shouldCheckSilkGdu;
                var shouldCheckHarvestGdu;
                var lastGDUDate;
                //changing to estimatedSilkDate
                // I do not know why I used the actualSilkDate
                // I actually do not know how this was even set. :(
                var estimatedSilkDate;

                var facilityGUID = field.get('facility');
                var daysToAddForHarvest = facilityHarvestDays[facilityGUID];
                // console.log('Days to add for harvest: ' + daysToAddForHarvest);
                // console.log('now starting promise chain for ' + field.get('fieldNumber'));
                promises.push(femaleInbredForField(field).then(function(result) {

                    var femaleInbred = result;
                    // silkDate = field.get('actualSilkDate');
                    // console.log('silk date for ' + field.get('fieldNumber') + ' is ' + silkDate);

                    if (!femaleInbred) {
                        console.log('1.e) Could not find femaleInbred for field' + field.get('fieldNumber'));
                        return;
                    }
                    gduToSilk = femaleInbred.get('gduToSilk') - kGDUToSubtractForDetassel;
                    // gduToHarvest = femaleInbred.get('gduToHarvest');

                    // console.log('1.) found femaleInbred ' + femaleInbred.get('identifier') + '; silk: ' + gduToSilk + '; harvest: ' + gduToHarvest);
                    if (gduToSilk > 0 || estimatedSilkDate) {

                        var dateToUse = new Date();
                        // var dateWrapper = moment(dateToUse);

                        var weatherQuery = new Parse.Query(DailyWeatherSummary);
                        weatherQuery.limit(MAX_QUERY_LIMIT);
                        weatherQuery.greaterThan('date', field.get('plantingDate'));
                        weatherQuery.equalTo('field', field.get('guid'));
                        weatherQuery.lessThanOrEqualTo('date', dateToUse);
                        weatherQuery.ascending('date');
                        // console.log('2.) returning weather query for ' + field.get('fieldNumber'));
                        return weatherQuery.find();
                    } else {
                        // console.log('do not have gdu')
                        return;
                    }
                    //returns a weather query.find() promise
                }).then(function(results) {

                    if (estimatedSilkDate && daysToAddForHarvest) {
                        //this is the only spot estimatedHarvestDate is set
                        var harvestDate = new Date(estimatedSilkDate.getTime());
                        harvestDate.setDate(harvestDate.getDate() + daysToAddForHarvest);
                        field.set('estimatedHarvestDate', harvestDate);
                        // console.log('Field: ' + field.get('fieldNumber') + '; silk date: ' + estimatedSilkDate.getMonth() + '/' + estimatedSilkDate.getDate() + '/' + estimatedSilkDate.getFullYear() + ' - adding ' + daysToAddForHarvest + ' days to make harvest now: ' + harvestDate);
                    }
                    //results is an array of DailyWeatherSummaries, beginning w/ day after plantingDate and ending with less than (now)
                    if (results) {

                        // console.log('3.) have ' + results.length + ' of weather summaries for ' + field.get('fieldNumber'));
                        accumulatedGDU = 0;
                        shouldCheckSilkGdu = (gduToSilk > 0);
                        // shouldCheckHarvestDate = (estimatedSilkDate);
                        lastGDUDate = field.get('plantingDate');
                        _.each(results, function(result) {

                            // if (!shouldCheckHarvestDate && !shouldCheckSilkGdu) {
                            if (!shouldCheckSilkGdu) {
                                return;
                            }

                            accumulatedGDU += result.get('gdu');
                            // console.log('Field ' + field.get('fieldNumber') + ', Added ' + result.get('gdu') + ' actual GDU, date ' + result.get('date') + ' total GDU ' + accumulatedGDU);
                            if (shouldCheckSilkGdu && accumulatedGDU >= gduToSilk) {
                                field.set('estimatedSilkDate', result.get('date'));
                                shouldCheckSilkGdu = false;
                                // console.log('4.) field silk date has been set for ' + field.get('fieldNumber') + ' with actual total GDU ' + accumulatedGDU);
                            }
                            // if (shouldCheckHarvestDate && accumulatedGDU >= gduToHarvest) {
                            //  field.set('estimatedHarvestDate', result.get('date'));
                            //  shouldCheckHarvestDate = false;
                            // }
                            lastGDUDate = result.get('date');
                        });

                        // console.log('4.) current status for ' + field.get('fieldNumber') + ': checkSilk: ' + shouldCheckSilkGdu + ', checkHarvest: ' + shouldCheckHarvestGdu + ', accumulatedGDU: ' + accumulatedGDU);
                        if (shouldCheckSilkGdu) {
                            // if (shouldCheckHarvestDate || shouldCheckSilkGdu) {
                            //didn't hit the gdu of one of them.  need to fetch Historical data
                            // console.log('4.1) going to fetch estimated gdu data for ' + field.get('fieldNumber'));
                            return historicalGduDataAfter(lastGDUDate);

                        }
                    } else {
                        // console.log('4.e) no weather summary results for field ' + field.get('fieldNumber'));
                        return;
                    }
                    //returns a estimated gdu query.find() promise
                }).then(function(results) {

                    if (results) {

                        // console.log('5.) have ' + results.length + ' results for ' + field.get('fieldNumber'));
                        // console.log('6.) current status for ' + field.get('fieldNumber') + ': checkSilk: ' + shouldCheckSilkGdu + ', checkHarvest: ' + shouldCheckHarvestGdu + ', accumulatedGDU: ' + accumulatedGDU);

                        _.each(results, function(result) {

                            // if (!shouldCheckHarvestGdu && !shouldCheckSilkGdu) {
                            //  return;
                            // }
                            if (!shouldCheckSilkGdu) {
                                return;
                            }
                            var weatherStation = field.get('weatherStation').toLowerCase();
                            var gduToAdd = Math.round(result.get(weatherStation));
                            accumulatedGDU += gduToAdd;
                            // console.log('Field ' + field.get('fieldNumber') + ', Added ' + gduToAdd + ' EST GDU, date ' + result.get('date') + ' total GDU ' + accumulatedGDU);

                            if (shouldCheckSilkGdu && accumulatedGDU >= gduToSilk) {
                                var theSilkDate = result.get('date');
                                field.set('estimatedSilkDate', theSilkDate);
                                shouldCheckSilkGdu = false;
                                var harvestDate = new Date(theSilkDate.getTime());
                                harvestDate.setDate(harvestDate.getDate() + daysToAddForHarvest);
                                field.set('estimatedHarvestDate', harvestDate);
                                // console.log('Field: ' + field.get('fieldNumber') + '; silk date: ' + theSilkDate.getMonth() + '/' + theSilkDate.getDate() + '/' + theSilkDate.getFullYear() + ' - adding ' + daysToAddForHarvest + ' days to make harvest now: ' + harvestDate);

                                // console.log('7.1) field silk date has been set to ' + result.get('date') + ' for ' + field.get('fieldNumber') + ' with EST total GDU ' + accumulatedGDU);
                            }
                            // if (shouldCheckHarvestGdu && accumulatedGDU >= gduToHarvest) {
                            //  field.set('estimatedHarvestDate', result.get('date'));
                            //  shouldCheckHarvestGdu = false;
                            // console.log('7.2) field harvest date as been set for ' + field.get('fieldNumber'));
                            // }

                        });
                        // console.log('7.3) completed iterating through est weather data for ' + field.get('fieldNumber'));
                        // console.log('7.4) current status for ' + field.get('fieldNumber') + ': checkSilk: ' + shouldCheckSilkGdu + ', checkHarvest: ' + shouldCheckHarvestGdu + ', accumulatedGDU: ' + accumulatedGDU);
                        // console.log('7.5) field silk date: ' + field.get('estimatedSilkDate') + '; harvest date: ' + field.get('estimatedHarvestDate'));
                    } else {
                        // console.log('7.e) no estimates for field ' + field.get('fieldNumber'));
                    }

                    return field.save();
                }, function(error) {
                    console.error('there was an error with ' + field.get('fieldNumber') + ' error: ' + error);
                    return "Had an error.";
                }));// push to promises
            })); //each loop


            return Parse.Promise.when(promises);

        }).then(function() {
            status.success('Completed Updating Estimated Dates job.');
        }, function(error) {
            status.error('Error getting Fields for Est Dates ' + error.code + error.message);
            pushErrorMessageToAdministrator(error);
        }); // query.find

    });

    var getDailyWeatherForDate = function getDailyWeatherSummariesForDateRange(params) {

        var parameters = params;
        var fieldNumber = parameters.fieldNumber;
        var dateParameter = parameters.date;

        var returnPromise = new Parse.Promise();

        if (!dateParameter) {

            console.error('No date passed in.  Date: ' + dateParameter + ' fieldNumber: ' + fieldNumber);
            console.log('## About to resolve -1');
            return returnPromise.reject("No date");
        }

        var query = new Parse.Query(Field);

        if (fieldNumber) {
            query.equalTo("fieldNumber", fieldNumber);
        } else {
            console.error('No field number provided');
            console.log('## About to resolve -2');
            return returnPromise.reject("No date");
        }

        // console.log('Parameters, date: ' + dateParameter + ' fieldNumber: ' + fieldNumber);

        query.notEqualTo("deleted", true);
        query.doesNotExist('harvestDate');
        query.exists('latitude');
        query.exists('longitude');

        var dateToUse = new Date(dateParameter);
        // dateToUse.setDate(dateToUse.getDate() - 1); // fixes weird moment.js bug that adds a day
        var dateWrapper = moment(dateToUse);

        query.first().then(function(result) {

            // Pull weather info for field from forecast.io
            // console.log('About to process ' + dateWrapper.format() + ' for field ' + fieldNumber + '.');

            var field = result;
            var baseURL = 'https://api.forecast.io/forecast/41362740878deb6113f15b79ae3280bd/';
            // console.log('weather for ' + field.get("guid"));
            var latitude = field.get("latitude");
            var longitude = field.get("longitude");

            var requestURL = baseURL + latitude + ',' + longitude + ',' + dateWrapper.format();
            // console.log('Requesting data for ' + requestURL);

            return rp( requestURL ).then(function(httpResponse) {
                // console.log('got a response at least');
                onHistorySuccess(httpResponse, field, dateToUse).then(function() {
                    // console.log('## About to resolve 1');
                    return Parse.Promise.as('Success');
                }, function(error) {
                    // console.log('## About to resolve 2');
                    return Parse.Promise.error(error);
                })

            }).catch( function(error) {
                console.error('error with ' + field.get('guid'));
                console.error('Error: ' + JSON.stringify(error));
                field.save().then(function() {
                    // console.log('## About to resolve 3');
                    return Parse.Promise.error(error);
                }, function(error) {
                    // console.log('## About to resolve 4');
                    return Parse.Promise.error(error);
                })
            }); // httpRequest
        }).then(function() {
            // console.log('Successful for ' + fieldNumber + ' on ' + dateWrapper.format());
            // console.log('## About to resolve 6');
            returnPromise.resolve("Successful for " + fieldNumber);
        }, function(error) {
            console.error('Full error object: ' + JSON.stringify(error));
            // console.log('## About to resolve 7');
            returnPromise.reject("Failed for " + fieldNumber);
        }); // query.find
        return returnPromise;
    };

    function calculateCurrentGDUsForField(field) {
        var query = new Parse.Query('DailyWeatherSummary');
        query.limit(MAX_QUERY_LIMIT);
        query.equalTo('field', field.get('guid'));
        query.notEqualTo('deleted', true);
        query.greaterThan('date', field.get('plantingDate'));
        query.lessThan("date", field.get("harvestDate"));
        query.find().then(function(results) {

            var totalGDUs = 0;
            _.each(results, function(dailyWeather) {
                totalGDUs += dailyWeather.get('gdu');
            }); // each loop
            // console.log('Setting ' + totalGDUs + ' for ' + field.get('guid'));
            return field.save({
                accumulatedGDU : totalGDUs
            });
        }, function(error) {
            console.log('ERROR setting GDU for ' + field.get('guid'));
            return Parse.Promise.error('Could not find weather summaries');
        }); // DailyWeatherSummary query
    }; // function calculateCurrentGDUsForField

    function femaleInbredForField(field) {

        var hybridGuid = field.get('hybrid');
        // console.log('looking for femaleInbred for hybrid ' + hybridGuid);

        var femaleQuery = new Parse.Query('Inbred');
        femaleQuery.equalTo('hybridsAsFemale', hybridGuid);

        return femaleQuery.first();

    }; // femaleInbredForField
//
    function harvestDaysForAllFacilities() {
        console.log('here');
        var allFacilitiesQuery = new Parse.Query('Facility');
        var facilitiesHarvestDays = new Object();

        return allFacilitiesQuery.find().then(function(results) {
            _.each(results, function(facility) {
                var guid = facility.get('guid');
                console.log('guid is: ' + guid);
                var days = facility.get('daysUntilHarvest');
                console.log('days is: ' + days);
                if (guid && days) {
                    facilitiesHarvestDays[guid] = days;
                }
            });

            console.log('facility harvest days: ' + JSON.stringify(facilitiesHarvestDays));

            return Parse.Promise.as(facilitiesHarvestDays);

        });

    } // harvestDaysForAllFacilities

    function historicalGduDataAfter(afterDate) {

        var estimatedQuery = new Parse.Query('HistoricalGDU');
        afterDate.setHours(23);
        estimatedQuery.greaterThan('date', afterDate);
        estimatedQuery.limit(MAX_QUERY_LIMIT);
        estimatedQuery.ascending("date");
        return estimatedQuery.find();

    }; // historicalGduDataAfter

    function precipitationForResponse(httpResponse, field, date) {

        var PrecipitationInfo = Parse.Object.extend('PrecipitationInfo');
        var precipObject = new PrecipitationInfo();
        var jsonObject = JSON.parse(httpResponse.text);
        console.log('Recieved Data: ' + JSON.stringify(jsonObject));
        var hourlyResults = jsonObject.list;
        console.log('List data: ' + JSON.stringify(hourlyResults));
        var totalPrecipitation = 0;
        var hiTemp = 0;
        var loTemp = 1000;
        _.each(hourlyResults, function(hourlyObject, index) {
            console.log('Index is ' + index);
            if ((index + 1) % 3 == 0) {
                console.log('Modulus index is ' + index);
                console.log('Checking hourly data: ' + JSON.stringify(hourlyObject));
                var rain = hourlyObject.rain;
                if (rain) {
                    console.log("Evaluating rain: " + JSON.stringify(rain));
                    var precip = rain["1h"];
                    if (precip) {
                        totalPrecipitation += precip;
                    }
                }
            }
            if (hourlyObject.main.temp_min < loTemp) {
                loTemp = hourlyObject.main.temp_min;
            }
            if (hourlyObject.main.temp_max > hiTemp) {
                hiTemp = hourlyObject.main.temp_max;
            }
        });
        if (loTemp < 1000) {
            var loTempInF = (loTemp - 273.15) * 1.8;
            loTempInF += 32;
            loTempInF = Math.round(loTempInF);
            precipObject.set('loTemp', loTempInF);
        }
        if (hiTemp > 0) {
            var hiTempInF = (hiTemp - 273.15) * 1.8;
            hiTempInF += 32;
            hiTempInF = Math.round(hiTempInF);
            precipObject.set('hiTemp', hiTempInF);
        }
        //convert precip to inches
        if (totalPrecipitation > 0) {
            totalPrecipitation *= 0.039370;
        }
        precipObject.set('precipitation', totalPrecipitation);
        precipObject.set('field', field.get('guid'));
        if (date) {
            precipObject.set('date', date);
        }
        return precipObject.save();
    }; // precipitationForResponse

    function onHistorySuccess(httpResponse, field, date) {

        var DailyWeatherSummary = Parse.Object.extend("DailyWeatherSummary");
        var weatherSummary = new DailyWeatherSummary();
        var jsonObject = JSON.parse(httpResponse.text);
        // console.log('response is ' + httpResponse.text);
        // console.log('JSON is ' + JSON.stringify(jsonObject));
        var daily = jsonObject.daily.data[0];
        // console.log('daily is ' + JSON.stringify(daily));
        var hiTemp = Math.round(daily.temperatureMax);
        var loTemp = Math.round(daily.temperatureMin);
        weatherSummary.set('hiTemp', hiTemp);
        weatherSummary.set('loTemp', loTemp);

        // var precip = daily.precipAccumulation;
        // if (!precip) {
        //  precip = 0;
        // }
        // weatherSummary.set('precipAccumulation', precip);

        weatherSummary.set('summary', daily.summary);
        weatherSummary.set('icon', daily.icon);

        if (hiTemp > 85) hiTemp = 85;
        if (hiTemp < 50) hiTemp = 50;
        if (loTemp < 50) loTemp = 50;
        if (loTemp > 85) loTemp = 85;
        var gdus = Math.round((hiTemp + loTemp) / 2 - 50);
        weatherSummary.set('gdu', gdus);
        weatherSummary.set('field', field.get('guid'));
        var weatherDate = new Date(date);

        weatherSummary.set('date', weatherDate);
        // console.log('hi ' + hiTemp + ', lo ' + loTemp + ', GDUs ' + gdus);

        // we don't handle a possible save error here.  It's important to return a promise (maybe?),
        // so not sure how to structure that
        return weatherSummary.save();
    };

    function onWeatherInfoSuccess(httpResponse, field) {

        // console.log(httpResponse.data);

        var WeatherInfo = Parse.Object.extend("WeatherInfo");
        var weatherInfo = new WeatherInfo();
        var jsonObject = JSON.parse(httpResponse);
        var currentConditions = jsonObject.currently;
        var temp = Math.round(currentConditions.temperature);
        var currentDate = new Date();
        //    console.log('temp is ' + temp);
        weatherInfo.set('temperature', temp);
        weatherInfo.set('field', field.get('guid'));
        weatherInfo.set('summary', currentConditions.summary);
        weatherInfo.set('icon', currentConditions.icon);
        weatherInfo.set('windSpeed', Math.round(currentConditions.windSpeed));
        weatherInfo.set('windBearing', currentConditions.windBearing);
        weatherInfo.set('weatherDate', currentDate);
        return weatherInfo.save();

    };

    function removeExtraDailyWeatherSummariesForField(field) {

        console.log('remove extra daily summaries for ' + field.get('guid'));

        var DailyWeatherSummary = Parse.Object.extend("DailyWeatherSummary");
        var weatherQuery = new Parse.Query(DailyWeatherSummary);
        weatherQuery.equalTo("field", field.get("guid"));
        weatherQuery.greaterThan("date", field.get('harvestDate'));
        weatherQuery.limit(MAX_QUERY_LIMIT);

        weatherQuery.find().then(function(results) {
            console.log("Found " + results.length + " weather summaries to delete for " + field.get('guid'));

            return Parse.Object.destroyAll(results);
        }).then(function() {
            console.log('Success?');
            return Parse.Promise.as("Success trimming summaries for " + field.get('guid'));
        }, function(error) {
            console.log('Error fetching summaries for ' + field.get('guid') + error.code + error.message);
            return Parse.Promise.as("No summaries to trim for " + field.get('guid'));
        });

    }

    function pushErrorMessageToAdministrator(error) {

        var pushQuery = new Parse.Query(Parse.Installation);
        pushQuery.equalTo('currentUser', 'Aaron Abt Dev');
        var alertString = 'ALERT! CloudCode error: ' + JSON.stringify(error) + '.';
        if (alertString.length > 140) {
            alertString = alertString.substring(0, 137) + "...";
        }
        Parse.Push.send({
            where: pushQuery, // Set our Installation query
            data: {
                alert: alertString,
                sound: 'default'
            }
        }, {
            success: function() {
                // Push was successful
                console.log('Success sending Admin Push alert.');
            },
            error: function(error) {
                // Handle error
                console.error('Error sending Admin Push alert: ' + error.code + error.message);
            }
        });

    };

    function sendFieldInspectionSMS( number, name ) {
        twilio.initialize( 'AC6ab9a93e9aba38b0aca276fae5119a93', 'e0f82f910e691507e8b78ea8c3b0d6f2' );

        var message = 'A high-priority Field Visit has just been created for field ' + name;

        twilio.sendSMS({
            From: '+12036978801',
            To: number,
            Body: message
        }, {
            success: function( httpResponse ) {
                console.log('SMS sent to ' + number );
            },
            error: function( httpResponse ) {
                console.log('Uh oh, something went wrong sending message to ' + number);
                console.log( httpResponse );
            }
        });
    }

    function sendGeofenceChangedSMS( number, fieldNumber ) {
        twilio.initialize( 'AC6ab9a93e9aba38b0aca276fae5119a93', 'e0f82f910e691507e8b78ea8c3b0d6f2' );

        var message = 'A geofence was changed for ' + fieldNumber;

        twilio.sendSMS({
            From: '+12036978801',
            To: number,
            Body: message
        }, {
            success: function( httpResponse ) {
                console.log('SMS sent to ' + number );
            },
            error: function( httpResponse ) {
                console.log('Uh oh, something went wrong sending message to ' + number);
                console.log( httpResponse );
            }
        });
    }

    function logMessage( $message, $actionTaken ) {
        var error = Parse.Object.extend( 'ErrorLog' ),
            errorObj = new error();

        errorObj.set( 'message', $message );
        errorObj.set( 'actionTaken', $actionTaken );

        errorObj.save();
    }

    return _instance;
}() );

module.exports = cloud;