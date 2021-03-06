
var gravatar = require('gravatar')
  , superagent = require('superagent')
  , crypto = require('crypto')
  , _ = require('lodash')

module.exports = {
  receiveWebhook: receiveWebhook,
  verifySignature: verifySignature,
  pushJob: pushJob,
  pullRequestJob: pullRequestJob
}

function makeJob(project, config) {
  var now = new Date()
    , deploy = false
    , commit
    , trigger
    , branch
    , ref
    , job
  branch = project.branch(config.branch) || {active: true, mirror_master: true, deploy_on_green: false}
  if (!branch.active) return false
  if (config.branch !== 'master' && branch.mirror_master) {
    // mirror_master branches don't deploy
    deploy = false
  } else {
    deploy = config.deploy && branch.deploy_on_green
  }
  job = {
    type: deploy ? 'TEST_AND_DEPLOY' : 'TEST_ONLY',
    trigger: config.trigger,
    project: project.name,
    ref: config.ref,
    user_id: project.creator._id,
    created: now
  }
  return job
}

function startFromCommit(project, payload, send) {
  var config = pushJob(payload)
    , branch = project.branch(config.branch)
    , job
  if (branch) {
    job = makeJob(project, config)
    if (!job) return false
    return send(job)
  }
  project.addBranch(config.branch, function (err) {
    if (err) return console.error('failed to add branch: ', err.message, err.stack)
    job = makeJob(project, config)
    if (!job) return false
    send(job)
  })
}

// post a comment to the pull request asking for confirmation by a
// whitelisted user
function askToTestPr(account, pull_request) {
  superagent.post(pull_request._links.comments)
    .set('Authorization', 'token ' + account.accessToken)
    .send({
      body: 'Should this PR be tested?'
    })
    .end(function (res) {
      if (res.status !== 201) {
        console.warn('Unexpected response to comment creation.', res.status, res.text)
      }
    })
}

function startFromPullRequest(account, config, project, payload, send) {
  if (payload.action !== 'opened' && payload.action !== 'synchronize') return
  var user
  if (config.pull_requests === 'whitelist') {
    user = _.find(config.whitelist, function (user) {
      return user.name === payload.pull_request.user.login
    })
    if (!user) {
      if (payload.action !== 'opened') return
      if (config.askToPR) askToTestPr(account, payload.pull_request)
      return
    }
  }
  var job = makeJob(project, pullRequestJob(payload.pull_request))
  if (!job) return false
  send(job)
}

function pullRequestJob(pr) {
  var trigger = {
    type: 'pull-request',
    author: {
      user: pr.user.login,
      image: pr.user.avatar_url
    },
    url: pr.html_url,
    message: pr.title,
    timestamp: pr.updated_at,
    source: {
      type: 'plugin',
      plugin: 'github'
    }
  }
  return {
    branch: pr.base.ref,
    trigger: trigger,
    deploy: false,
    ref: {
      fetch: 'refs/pull/' + pr.number + '/merge'
    }
  }
}

// returns : {trigger, branch, deploy}
function pushJob(payload) {
  var branchname
    , commit = payload.head_commit
    , trigger
    , ref
  if (payload.ref.indexOf('refs/heads/') === 0) {
    branchname = payload.ref.substring('refs/heads/'.length)
    ref = {
      branch: branchname,
      id: payload.after
    }
  } else {
    ref = {
      fetch: payload.ref
    }
  }
  trigger = {
    type: 'commit',
    author: {
      email: commit.author.email,
      image: gravatar.url(commit.author.email, {}, true)
    },
    url: commit.url,
    message: commit.message,
    timestamp: commit.timestamp,
    source: {
      type: 'plugin',
      plugin: 'github'
    }
  }
  return {
    branch: branchname,
    trigger: trigger,
    deploy: true,
    ref: ref
  }
}

function startFromComment(account, config, project, payload, send) {
  // not for a PR
  if (!payload.issue.pull_request || !payload.issue.pull_request.html_url) return
  var user = _.find(config.whitelist, function (user) {
    return user.name === payload.comment.user.login
  })
  if (!user) return
  user = _.find(config.whitelist, function (user) {
    return user.name === payload.issue.user.login
  })
  // if the issue was created by a whitelisted user, we assume it's been OKd
  if (user) return
  var body = payload.comment.body
  if (!(/\bstrider\b/.test(body) && /\btest\b/.test(body))) {
    return // they didn't ask us to test
  }
  var pr_number = payload.issue.pull_request.html_url.split('/').slice(-1)[0]
  superagent.get(payload.repository.pulls_url.replace('{/number}', pr_number))
    .set('Authorization', 'token ' + account.accessToken)
    .end(function (res) {
      if (res.status > 299) {
        return console.error('Failed to get pull request', res.text, res.headers, res.status)
      }
      var job = makeJob(project, pullRequestJob(res.body))
      if (!job) return false
      send(job)
  })
}

function receiveWebhook(emitter, req, res) {
  var secret = req.providerConfig().secret
    , account = req.accountConfig()
    , config = req.providerConfig()
  var valid = verifySignature(req.headers['x-hub-signature'], secret, req.post_body)
  if (!valid) {
    console.warn('Someone hit the webhook for ' + req.project.name + ' and it failed to validate')
    return req.send(401, 'Invalid signature')
  }
  console.log('got a body:', req.body)
  var payload
  try {
    payload = JSON.parse(req.body.payload)
  } catch (e) {
    console.error('Webhook payload failed to parse as JSON')
    return req.send(400, 'Invalid JSON in the payload')
  }
  res.send(204)
  // a new pull request was created
  var getConfig
  if (payload.pull_request) {
    if (config.pull_requests === 'none') {
      return console.log('Got pull request, but testing pull requests is disabled')
    }
    return startFromPullRequest(account, config, req.project, payload, sendJob)
  }
  // issue comment
  if (payload.comment) {
    if (config.pull_requests !== 'whitelist') return
    return startFromComment(account, config, req.project, payload, sendJob)
  }
  // otherwise, this is a commit
  startFromCommit(req.project, payload, sendJob)

  function sendJob(job) {
    emitter.emit('job.prepare', job)
  }
}

/*
 * verifySignature
 *
 * Verify HMAC-SHA1 signatures.
 *
 * <sig> Signature.
 * <secret> Shared secret, the HMAC-SHA1 was supposedly generated with this.
 * <body> The message body to sign.
 */
function verifySignature(sig, secret, body) {
  if (!sig || !body) return false
  sig = sig.replace('sha1=','');
  var hmac = crypto.createHmac('sha1', secret);
  hmac.update(body);
  var digest = hmac.digest('hex');
  return sig == digest;
}

