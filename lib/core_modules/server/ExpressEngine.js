var express = require('express'),
  session = require('express-session'),
  mongoStore = require('connect-mongo')(session),
  cookieParser = require('cookie-parser'),
  expressValidator = require('express-validator'),
  bodyParser = require('body-parser'),
  methodOverride = require('method-override'),
  http = require('http'),
  https = require('https'),
  fs = require('fs'),
  Sentry = require('@sentry/node'),
  ServerEngine = require('./engine'),
  Grid = require('gridfs-stream'),
  errorHandler = require('errorhandler'),
  passport = require('passport'),
  Parse = require('node-parse-api').Parse;

var options = {
    app_id: 'WXAuswcNMXVtaUxDpAE9F2SpUzYUWQsOaITBkTdI',
//    api_key: '3e0mqajoRN3MAsFKltBXkSzI3vPt5M6JBcvMmAUI'
    master_key: 'hEHsrslUEl2EZjhYNCA7jUXvwO0UYrIS2aPlxlkg'
}

var appParse = new Parse(options);

function ExpressEngine(){
  ServerEngine.call(this);
  this.app = null;
  this.db = null;
  this.mean = null;
}
ExpressEngine.prototype = Object.create(ServerEngine,{constructor:{
  value: ExpressEngine,
  configurable: false,
  writable: false,
  enumerable: false
}});
ExpressEngine.prototype.destroy = function(){
  this.mean = null;
  this.db = null;
  this.app = null;
  ServerEngine.prototype.destroy.call(this);
};
ExpressEngine.prototype.name = function(){
  return 'express';
};
ExpressEngine.prototype.initApp = function(){
  var config = this.mean.config.clean;
  this.app.use(function(req,res,next){
    res.setHeader('X-Powered-By','Mean.io');
    next();
  });
  // The cookieParser should be above session
  this.app.use(cookieParser());
  // Request body parsing middleware should be above methodOverride
  this.app.use(expressValidator());
  this.app.use(bodyParser.json({limit: '50mb'}));
  this.app.use(bodyParser.urlencoded({
    extended: true
  }));
  this.app.use(methodOverride());

  // Express/Mongo session storage
  this.app.use(session({
    secret: config.sessionSecret,
    store: new mongoStore({
      db: this.db.connection.db,
      collection: config.sessionCollection
    }),
    cookie: config.sessionCookie,
    name: config.sessionName,
    resave: true,
    saveUninitialized: true
  }));

  this.app.use(passport.initialize());
  this.app.use(passport.session());
  this.mean.register('passport',passport);
  require(process.cwd() + '/config/express')(this.app, this.db);
  return this.app;
};
ExpressEngine.prototype.beginBootstrap = function(meanioinstance, database){
  this.mean = meanioinstance;
  this.db = database.connection;
  var config = meanioinstance.config.clean;
  // Express settings
  var app = express();
  app.useStatic = function(a,b){
    if('undefined' === typeof b){
      this.use(express.static(a));
    }else{
      this.use(a,express.static(b));
    }
  };
  this.app = app;

  // Register app dependency;
  meanioinstance.register('app', this.initApp.bind(this));

  var gfs = new Grid(this.db.connection.db, this.db.mongo);

  function themeHandler(req, res) {

    res.setHeader('content-type', 'text/css');

    gfs.files.findOne({
      filename: 'theme.css'
    }, function(err, file) {

      if (!file) {
        fs.createReadStream(config.root + '/bower_components/bootstrap/dist/css/bootstrap.css').pipe(res);
      } else {
        // streaming to gridfs
        var readstream = gfs.createReadStream({
          filename: 'theme.css'
        });

        //error handling, e.g. file does not exist
        readstream.on('error', function(err) {
          console.log('An error occurred!', err.message);
          throw err;
        });

        readstream.pipe(res);
      }
    });
  }

  // We override this file to allow us to swap themes
  // We keep the same public path so we can make use of the bootstrap assets
  app.get('/bower_components/bootstrap/dist/css/bootstrap.css', themeHandler);


  // Listen on http.port (or port as fallback for old configs)
  var httpServer = http.createServer(app);
  meanioinstance.register('http', httpServer);
  httpServer.listen(config.http ? config.http.port : config.port, config.hostname);

  if (config.https && config.https.port) {
    var httpsOptions = {
      key: fs.readFileSync(config.https.ssl.key),
      cert: fs.readFileSync(config.https.ssl.cert)
    };

    var httpsServer = https.createServer(httpsOptions, app);
    meanioinstance.register('https', httpsServer);
    httpsServer.listen(config.https.port);
  }

  meanioinstance.name = config.app.name;
  meanioinstance.app = app;
  meanioinstance.menus = new (meanioinstance.Menus)();
};

function finalRouteHandler(req, res, next) {
  if (!this.template) return next();
  this.template(req, res, next);
}

function NotFoundHandler(err, req, res, next) {
  // Treat as 404
  if (~err.message.indexOf('not found')) return next();

  // Log it
  console.error(err.stack);

  // Error page
  res.status(500).render('500', {
    error: err.stack
  });
}

function FourOFourHandler(req, res) {
  res.status(404).render('404', {
    url: req.originalUrl,
    error: 'Not found'
  });
}

ExpressEngine.prototype.endBootstrap = function(callback){
  // We are going to catch everything else here
  this.app.route('*').get(finalRouteHandler.bind(this));
  
  if (process.env.NODE_ENV === 'development') {
    this.app.use(function (err, req, res, next) {

        var status = err.status,
            stackTab = err.stack,
            stack;

        if (err.message.indexOf('not found')){
            status = 500;
        }

        if(stackTab.length > 30){
            stack = stackTab.toString().substring(0,30);
        } else {
            stack = stackTab.toString();
        }

        var notification = {
            where: {},
            data: {
                code: status,
                title: stack
            }
        };

        appParse.insert('Error', {
            code: status,
            shortDescription: stack,
            longDescription: stackTab,
            occurredAt: {
                "__type": "Date",
                "iso": new Date().toJSON()
            }
        }, function (err, response) {
            console.log(response);
        });

        appParse.sendPush(notification, function(err, resp){
            console.log(resp);
        });

        console.error(err.stack);
        next(err);
    });
  }


  if (process.env.NODE_ENV === 'production') {
    Sentry.init({ dsn: 'https://c26d44afb7554cc5855c9c68c99e31bf@sentry.io/1376941' });
    this.app.use(Sentry.Handlers.requestHandler());
    // app.get('/', function mainHandler(req, res) {
    //     throw new Error('Broke!');
    //   });

    // The error handler must be before any other error middleware
    this.app.use(Sentry.Handlers.errorHandler());

    // Optional fallthrough error handler
    this.app.use(function onError(err, req, res, next) {
        // The error id is attached to `res.sentry` to be returned
        // and optionally displayed to the user for support.
        res.statusCode = 500;
        res.end(res.sentry + '\n');
    });
}

app.set('showStackError', true);
    // if (process.env.NODE_ENV === 'production') {
    //     var raygunClient = new raygun.Client().init({ apiKey: process.env.RAYGUN_API_KEY });
    //     this.app.use(raygunClient.expressHandler);
    //     raygunClient.user = function (req) {
    //         if (req.user) {
    //             return req.user.email;
    //         }
    //     }
    // }
  // Assume "not found" in the error msgs is a 404. this is somewhat
  // silly, but valid, you can do whatever you like, set properties,
  // use instanceof etc.
  this.app.use(NotFoundHandler);

  // Assume 404 since no middleware responded
  this.app.use(FourOFourHandler);

  // Error handler - has to be last
  if (process.env.NODE_ENV === 'development') {
    this.app.use(errorHandler());
  }
  callback(this);
};

module.exports = ExpressEngine;
