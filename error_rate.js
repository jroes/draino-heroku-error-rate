#! /usr/bin/env node
// TODO:
//   * Make sure there's no possibility of an infinite rollback cycle.
//   * Prevent rollbacks when migrations have been run.
//   * Address callback hell.
var split   = require('split');
var logfmt  = require('logfmt');
var through = require('through');

if (process.env.REDISTOGO_URL) {
  var rtg   = require("url").parse(process.env.REDISTOGO_URL);
  var redis = require("redis").createClient(rtg.port, rtg.hostname);
  redis.auth(rtg.auth.split(":")[1]);
} else {
  var redis = require("redis").createClient();
}

var Heroku  = require('heroku-client');
var heroku  = new Heroku({token: process.env.HEROKU_API_KEY});

console.log("listening on stdin");

process.stdin
  .pipe(split())
  .pipe(through(function(line){
    if (line === '') return;

    console.log(line);

    var app_name = process.env.APP_NAME || 'jroes-php-test';
    var max_error_count = process.env.MAX_ERROR_COUNT || 1;
    var error_rate_window = process.env.ERROR_RATE_WINDOW || 10;

    var releases_key = app_name + ':releases';
    var error_counter_key = app_name + ':errors';

    var data = JSON.parse(line)
    // If error
    //   increment errors:<app> in redis for this deployment
    //   if value for key is > ENV['max_error_count'], take action
    //   expire after ENV['error_rate_window'] seconds
    // Elseif release
    //   set key <app>:last_release to release uuid
    if (data.at == 'error' || ("heroku[router]:" in data && data.status == "500")) {
      logfmt.log({at: 'error_rate', status: 'error-detected'});

      redis.incr(error_counter_key, function (err, reply) {
        if (err) {
          return logfmt.log({at: 'error_rate', status: 'incr-counter-failed', error: err});
        }

        logfmt.log({at: 'error_rate', status: 'incr-counter-succeeded', reply: reply});
        if (reply > max_error_count) {
          logfmt.log({at: 'error_rate', status: 'error-rate-exceeded', count: reply, max_error_count: max_error_count});

          // Get the next-to-last release. The most recent release is the *current* release.
          redis.lrange(releases_key, 1, 1, function(err, reply) {
            if (err) {
              logfmt.log({at: 'error_rate', status: 'get-last-release-failed', error: err});
              return;
            }
            var last_release = reply[0];
            logfmt.log({at: 'error_rate', status: 'get-last-release-successful', last_release_id: last_release});
            var timer = logfmt.time().namespace({at: 'error_rate', action: 'rollback-release'});
            heroku.apps(app_name).releases().rollback({release: last_release}, function(err){
              console.error(err);
              if (err) timer.error(err);
              else {
                timer.log({status: 'rolled-back'});
                redis.set(error_counter_key, 0, function(err, replies) {
                  if (err) logfmt.log({at: 'error_rate', status: 'reset-counter-failed', error: err});
                  else logfmt.log({at: 'error_rate', status: 'reset-counter-succeeded'});
                });
                redis.lpop(releases_key, function(err, replies) {
                  if (err) logfmt.log({at: 'error_rate', status: 'remove-last-release-failed', error: err});
                  else logfmt.log({at: 'error_rate', status: 'remove-last-release-succeeded'});
                });
              }
            });
          });
        } else {
          redis.ttl(error_counter_key, function(err, replies) {
            logfmt.log({at: 'error_rate', replies: replies});
            if (err) logfmt.log({at: 'error_rate', status: 'get-ttl-failed', error: err});
            else {
              if (replies == -1) {
                redis.expire(error_counter_key, error_rate_window, function(err, replies) {
                  if (err) logfmt.log({at: 'error_rate', status: 'set-expire-failed', error: err});
                  else logfmt.log({at: 'error_rate', status: 'set-expire-succeeded'});
                });
              } else {
                logfmt.log({at: 'error_rate', status: 'expiry-already-set', ttl: replies});
              }
            }
          });
        }
      });
    } else if ("heroku[api]:" in data && "Release" in data) {
      var release_version = "";
      for (var key in data) {
        if (/^v(\d+)/.test(key)) {
          release_version = key.match(/^v(\d+)/)[1];
          break;
        }
      }
      logfmt.log({at: 'error_rate', status: 'release-created', version: release_version});
      var timer = logfmt.time().namespace({at: 'error_rate'});
      heroku.apps(app_name).releases(release_version).info(function(err, response){
          if (err) timer.log(err);
          else {
            //console.log(response);
            var release_id = response.id;
            logfmt.log({at: 'error_rate', status: 'release-retrieved', version: release_version, id: release_id});

            redis.lpush(releases_key, release_id, function(err, replies) {
              if (err) logfmt.log({at: 'error_rate', status: 'save-release-failed', error: err});
              else {
                logfmt.log({at: 'error_rate', status: 'release-push-succeeded'});
                redis.ltrim(releases_key, 0, 10, function(err, replies) {
                  if (err) logfmt.log({at: 'error_rate', status: 'trim-releases-failed', error: err});
                  else logfmt.log({at: 'error_rate', status: 'trim-releases-succeeded'});
                });
              }
            });
          }
        });
    }
  }))
