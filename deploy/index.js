var fs = require('fs'),
    AWS = require('aws-sdk'),
    crypto = require('crypto'),
    https = require('https'),
    child_process = require('child_process');

var kms = new AWS.KMS();
var s3 = new AWS.S3();
var ses = new AWS.SES();

var airbrake = null;
var secrets = null;

kms.decrypt({ CiphertextBlob: fs.readFileSync('/var/task/encrypted-secrets') }, function(err, data) {
  if (err) return context.fail(err.message);

  secrets = JSON.parse(data['Plaintext'].toString());
  if (secrets.airbrake_api_key && secrets.airbrake_api_key.length > 0) {
    airbrake = require('airbrake').createClient(secrets.airbrake_api_key);
  }
});
try { fs.mkdirSync('/tmp/gemserver') } catch (e) {};

exports.handler = function(event, context) {
  var signature = event.signature,
      message = event.data,
      type = event.type;

  if (type !== 'create') return context.fail('Event type must be "create"');

  if (secrets === null) {
    console.log('Waiting for secrets');
    return setTimeout(exports.handler.bind(this, event, context), 100);
  }

  // Verify X-Hub-Signature, ensures our requests are really coming from GitHub.
  var hmac = crypto.createHmac('sha1', secrets.github_hookshot_secret);
  hmac.update(JSON.stringify(message));
  var calculatedSignature = 'sha1=' + hmac.digest('hex');
  if (calculatedSignature !== signature) return context.fail('Forbidden');

  // Process only new tags, not branches
  if (message.ref_type !== 'tag') return context.fail('Ref type must be "tag"');

  var tag   = message.ref;
  var owner = message.repository.owner.login;
  var repo  = message.repository.name;

  // Detect whether this repo is a gem by checking for `[repo].gemspec` in the
  // repository.
  var gemspec_url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + repo + '.gemspec?ref=' + tag;
  var command = 'curl -I -u ' + secrets.github_api_user + ':' + secrets.github_api_token + ' ' + gemspec_url + ' | head -n 1 | cut -d$\' \' -f2';
  child_process.exec(command, function(err, stdout, stderr) {
    if (!stdout.match(/200/)) return context.fail('Repository not a gem.');

    var download = [
      'ruby_ship.tar.gz',
      'latest_specs.4.8',
      'latest_specs.4.8.gz',
      'specs.4.8',
      'specs.4.8.gz',
      'prerelease_specs.4.8',
      'prerelease_specs.4.8.gz'
    ];
    (function next(keys) {
      key = keys.shift();
      s3.getObject({Bucket: secrets.s3_bucket, Key: key}, function(err, data) {
        if (err) console.log(err);
        if (data) fs.writeFileSync('/tmp/gemserver/' + key, data.Body);

        if (keys.length > 0) return next(keys);

        var child = child_process.spawn('./build-gem.sh', [], {
          env: {
            owner: owner,
            repo: repo,
            tag: tag,
            github_api_token: secrets.github_api_token,
            PATH: process.env.PATH + ':/var/task/vendor'
          }
        });
        child.stdout.on('data', function (data) { console.log('stdout: ' + data) });
        child.stderr.on('data', function (data) { console.log('stderr: ' + data) });
        child.on('close', function (code) {
          if (code !== 0 && airbrake) {
            err = new Error('./build-gem.sh exited with status ' + code);
            err.url = 'https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#logEvent:group=' + context.logGroupName + ';stream=' + context.logStreamName;
            return airbrake.notify(err, function() {
              context.fail(err.message);
            });
          }

          var keys = fs.readFileSync('/tmp/files').toString().split(/\s+/);
          keys.pop();

          (function upload() {
            key = keys.shift();
            s3.putObject({
              Bucket: secrets.s3_bucket,
              Key: key.replace('/tmp/gemserver/', ''),
              Body: fs.readFileSync(key),
              ACL: 'public-read'
            }, function(err) {
              if (err) console.log(err);
              if (keys.length > 0) return upload();

              var build = fs.readFileSync('/tmp/build').toString();
              var version = build.match(/Version: ([\d\.]*)/)[1];

              // Get previous tag to construct link to diff
              var tags_url = 'https://api.github.com/repos/' + owner + '/' + repo + '/tags';
              var command = 'curl -u ' + secrets.github_api_user + ':' + secrets.github_api_token + ' ' + tags_url;
              child_process.exec(command, function(err, stdout, stderr) {
                if (err) console.log(err);

                // Append a link to what has changed since the last release, if
                // one exists. Assumes that GitHub's tags API endpoint returns
                // tags in reverse chronological order, which seems to be the
                // case but is not promised in the documentation.
                var diff_link = '';
                tags = JSON.parse(stdout);
                tags.forEach(function(t, index) {
                  if (t.name === tag && tags[index + 1]) {
                    diff_link = '\n\nSee what\'s changed: https://github.com/' + owner + '/' + repo + '/compare/' + tags[index + 1].name + '...' + tag;
                  }
                });

                // Send confirmation email
                if (!secrets.from_email || secrets.from_email.length === 0 ||
                    !secrets.to_email || secrets.to_email.length === 0) {
                  return context.succeed(event);
                }

                ses.sendEmail({
                  Destination: { ToAddresses: [secrets.to_email] },
                  Message: {
                    Body: {
                      Text: { Data: 'Test this version of the gem by running:\n    gem install ' + repo + ' -v ' + version + ' --source http://' + secrets.s3_bucket + '\n\nTo add this gem to your Gemfile, add this gemserver as a source:\n    source "http://' + secrets.s3_bucket + '"\n\nOr specify the source as an option for the ' + repo + ' gem:\n    gem "' + repo + '", "' + version + '", source: "http://' + secrets.s3_bucket + '"' + diff_link }
                    },
                    Subject: { Data: '[' + repo + '] ' + tag + ' built successfully on ' + secrets.s3_bucket }
                  },
                  Source: secrets.from_email
                }, function(err, data) {
                  if (err) return context.fail(err.message);
                  context.succeed(event);
                });
              });
            });
          })();
        });
      });
    })(download);

  }).on('error', function(err) {
    context.fail(err.message)
  });
}
