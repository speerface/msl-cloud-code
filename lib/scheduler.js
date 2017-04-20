var schedule  = require('node-schedule');
var CloudCode = require('./hooks');
var Parse     = require('parse/node');

var scheduler = ( function() {
    var _instance = {};

    _instance.initTasks = function() {
        Parse.initialize( '2017GALIVE', "zVw4LTe6k2QmD4n2L2gPdMradqoobe5QXTwsirHE" );
        Parse.serverURL = 'https://api.ga.mysupplylive.com/1';

        schedule.scheduleJob('0 6 * * *', function(){
          CloudCode.triggerFunction( 'DailyWeatherSummary', {} );
        });

        schedule.scheduleJob('30 6 * * *', function () {
            CloudCode.triggerFunction('CalculateEstimatedDates', {});
        });

        schedule.scheduleJob('15 * * * *', function () {
            CloudCode.triggerFunction('currentWeather', {});
        });
    };


    return _instance;
}() );

module.exports = scheduler;