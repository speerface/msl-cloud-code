var response = ( function() {
    var _instance = {};

    _instance.success = function( message ){
        return { status: 'success', message: message };
    };

    _instance.error = function( message ){
        return { status: 'error', message: message };
    };

    return _instance;
}() );

module.exports = response;