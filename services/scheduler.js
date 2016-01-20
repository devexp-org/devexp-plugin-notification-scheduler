'use strict';

import moment from 'moment';
import scheduler from 'node-schedule';
import { isEmpty } from 'lodash';

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
  const logger = imports.logger;
  const PullRequestModel = model.get('pull_request');
  const events = imports.events;

  function cancelJob(pullId) {
    if (isEmpty(scheduler.scheduledJobs)) {
      return Promise.resolve();
    }

    const job = scheduler.scheduledJobs['pull-' + pullId];

    if (!job) {
      return Promise.resolve();
    }

    return Promise.resolve(job.cancel());
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

    return new Promise((resolve) => {
      const job = scheduler.scheduleJob('pull-' + id, expirationTime.toDate(), function () {
        PullRequestModel
          .findById(id)
          .then(pullRequest => {

            // nobody cares about review
            if (!pullRequest.review_comments && pullRequest.state !== 'closed') {
              events.emit(EVENT_NAME, { pullRequest });
              createJob(payload);
            } else {
              cancelJob(id);
            }

          }, ::logger.error);
      });

      return resolve(job);

    });

  }

  function onReviewDone(payload) {
    return cancelJob(payload.pullRequest.id).catch(::logger.error);
  }

  function onReviewStart(payload) {
    return createJob(payload).catch(::logger.error);
  }

  events.on('review:approved', onReviewDone);
  events.on('review:complete', onReviewDone);

  events.on('review:command:start', onReviewStart);
  events.on('review:command:stop', onReviewDone);

  return new Promise(resolve => {
    // Beware! this is not a native Promise (Mongoose)
    PullRequestModel
      .find({
        state: 'open',
        'review.status': 'inprogress'
      })
      .then(result => {
        result.forEach(pullRequest => {
          return createJob({ pullRequest });
        });

        resolve();
      });
  });

}
