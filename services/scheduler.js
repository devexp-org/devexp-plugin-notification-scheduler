'use strict';

import moment from 'moment';
import scheduler from 'node-schedule';
import { isEmpty, forEach } from 'lodash';

const EVENT_NAME = 'review:scheduler:ping';

/**
 * Service for sending notification by time
 *
 * @param {Object}   options
 * @param {Number} options.days How often to send a reminder.
 * @param {Object}   imports
 *
 * @return {Promise}
 */
export default function (options, imports) {

  const model = imports.model;
  const events = imports.events;
  const logger = imports.logger;
  const PullRequestModel = model.get('pull_request');

  const store = {};

  function cancelJob(payload) {
    const id = payload.pullRequest.id;
    const job = store['pull-' + id];

    if (!job) {
      return Promise.resolve();
    }

    job.cancel();
    delete store['pull-' + id];

    return Promise.resolve();
  }

  function createJob(payload, tf = options.days) {

    const id = payload.pullRequest.id;
    const reviewStartTime = moment(payload.pullRequest.review.started_at);
    const reviewDowntimeFullDays = ~~moment.duration(moment().diff(reviewStartTime)).asDays();
    const expirationTime = reviewStartTime.add(reviewDowntimeFullDays + tf, 'days');

    // exclude weekend
    while (expirationTime.isoWeekday() > 5) {
      expirationTime.add(1, 'days');
    }

    return new Promise((resolve, reject) => {
      const job = scheduler.scheduleJob('pull-' + id, expirationTime.toDate(), function () {
        PullRequestModel
          .findById(id)
          .then(pullRequest => {
            // nobody cares about review
            if (!pullRequest.review_comments && pullRequest.state !== 'closed') {
              events.emit(EVENT_NAME, { pullRequest });
              createJob(payload);
            } else {
              cancelJob(payload);
            }
          })
          .then(resolve, reject);
      });

      store['pull-' + id] = job;
    });

  }

  function shutdown() {
    forEach(store, (job) => job.cancel());

    return Promise.resolve();
  }

  function onReviewStart(payload) {
    return createJob(payload).catch(::logger.error);
  }

  function onReviewDone(payload) {
    return cancelJob(payload).catch(::logger.error);
  }

  events.on('review:approved', onReviewDone);
  events.on('review:complete', onReviewDone);

  events.on('review:command:stop', onReviewDone);
  events.on('review:command:start', onReviewStart);

  return new Promise((resolve, reject) => {
    PullRequestModel
      .findInReview()
      .then(result => {
        result.map(pullRequest => onReviewStart({ pullRequest }));
        return { shutdown };
      })
      .then(resolve, reject);
  });

}
