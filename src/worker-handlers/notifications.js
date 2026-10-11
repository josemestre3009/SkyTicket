import nodemailer from 'nodemailer';
import { config } from '../config.js';
import * as defaultRepo from '../modules/notifications/repository.js';
import { EMAIL_DELIVERY_JOB_TYPE } from '../modules/notifications/service.js';

/**
 * Build the SMTP transport from config, or return an injected one. Injecting a
 * transport (fake in tests, mock in preview) is the seam that keeps the worker
 * handler deterministic and the business path free of network coupling.
 */
export function createEmailTransport({ smtpUrl = config.mail.smtpUrl, transport = null } = {}) {
  if (transport) return transport;
  if (!smtpUrl) return null;
  return nodemailer.createTransport(smtpUrl);
}

/**
 * Async email delivery, decoupled from the business transaction.
 *
 * Delivery state and attempts live in `email_deliveries`. Every failure
 * increments attempts and is retried by the job queue (limited by the job's
 * max_attempts, which the emitter pins to the delivery's own budget). Once the
 * delivery budget is exhausted it is marked `dead` and the job is completed
 * successfully, so a failing provider never reverses or blocks business state.
 */
export function createNotificationHandlers({
  runner,
  transport = null,
  mailFrom = config.mail.from,
  repo = defaultRepo,
  logger = console,
} = {}) {
  const mailer = transport ?? createEmailTransport();

  async function deliverEmail(job) {
    const deliveryId = job?.payload?.deliveryId;
    if (!deliveryId) throw new Error('email delivery job requires payload.deliveryId');

    const delivery = await repo.findEmailDeliveryById(deliveryId, runner);
    if (!delivery) return { skipped: 'not_found' };
    if (delivery.status === 'sent') return { skipped: 'already_sent' };
    if (delivery.status === 'dead') return { skipped: 'dead' };
    if (!mailer) throw new Error('email transport is not configured');

    try {
      const info = await mailer.sendMail({
        from: mailFrom,
        to: delivery.recipient_email,
        subject: delivery.subject || delivery.title,
        text: delivery.body || delivery.title,
      });
      await repo.markDeliverySent(deliveryId, runner);
      return { sent: true, messageId: info?.messageId ?? null };
    } catch (err) {
      const updated = await repo.recordDeliveryFailure(deliveryId, err.message, runner);
      if (updated && updated.status === 'dead') {
        logger.warn(`[notifications] email delivery ${deliveryId} exhausted attempts: ${err.message}`);
        return { dead: true, attempts: updated.attempts };
      }
      throw err;
    }
  }

  return { [EMAIL_DELIVERY_JOB_TYPE]: deliverEmail };
}

/** Register every notification job handler with the worker's `registerHandler`. */
export function registerNotificationHandlers(register, options) {
  const handlers = createNotificationHandlers(options);
  for (const [type, handler] of Object.entries(handlers)) register(type, handler);
  return handlers;
}
