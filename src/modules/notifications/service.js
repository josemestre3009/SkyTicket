import { AuthError, ForbiddenError } from '../../auth/errors.js';
import * as jobs from '../../jobs/repository.js';
import { planNotification, NOTIFICATION_TYPES } from './matrix.js';
import * as repo from './repository.js';

export const EMAIL_DELIVERY_JOB_TYPE = 'notifications.email.deliver';

export class ValidationError extends AuthError {
  constructor(message, code = 'validation_error') {
    super(message, { statusCode: 400, code });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AuthError {
  constructor(message, code = 'not_found') {
    super(message, { statusCode: 404, code });
    this.name = 'NotFoundError';
  }
}

const SEVERITY_BY_TYPE = Object.freeze({
  [NOTIFICATION_TYPES.LOW_BALANCE]: 'warning',
  [NOTIFICATION_TYPES.TOPUP]: 'info',
  [NOTIFICATION_TYPES.ISSUE_COMPLETED]: 'info',
  [NOTIFICATION_TYPES.ISSUE_UNCERTAIN]: 'critical',
  [NOTIFICATION_TYPES.SUSPENSION]: 'warning',
  [NOTIFICATION_TYPES.SYNC_FAILURE]: 'warning',
});

/** Resource links are resolved lazily and only after a tenant check. */
const RESOURCE_LINK_BUILDERS = Object.freeze({
  voucher_order: (id) => `/orders/${id}`,
});

export function toNotificationDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    channel: row.channel,
    title: row.title,
    body: row.body,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function requireUser(auth) {
  if (!auth?.user?.id) throw new ForbiddenError('Authentication required', 'unauthorized');
  return auth.user;
}

export function createNotificationService(options = {}) {
  const runner = options.runner;
  const now = options.now ?? (() => Date.now());
  const enqueue = options.enqueue ?? jobs.enqueue;

  /**
   * Fan out one domain event to the matrix channels/recipients, inserting one
   * notification row per (recipient user, channel). Dedupe is enforced by the
   * unique index, so re-running an event is a no-op. Pass `opts.runner` (a
   * transaction client) to commit notifications atomically with the business
   * change; email is only *enqueued* here and sent later by the worker.
   */
  async function emit(event, opts = {}) {
    const client = opts.runner ?? runner;
    const {
      type,
      resourceType = null,
      resourceId = null,
      resellerId = null,
      title,
      body = null,
      severity = SEVERITY_BY_TYPE[type] ?? 'info',
    } = event;

    if (!title || !String(title).trim()) throw new ValidationError('title is required', 'title_required');
    const plan = planNotification({ type, resourceType, resourceId, now: now() });
    const needsReseller = plan.recipientTypes.includes('reseller');
    if (needsReseller && !resellerId) {
      throw new ValidationError('resellerId is required for this notification type', 'reseller_id_required');
    }

    const created = [];
    let skipped = 0;

    for (const recipientType of plan.recipientTypes) {
      const users = await repo.findRecipientUsers(
        { recipientType, resellerId: recipientType === 'reseller' ? resellerId : (resellerId ?? null) },
        client,
      );
      for (const user of users) {
        for (const channel of plan.channels) {
          const notification = await repo.insertNotification(
            {
              type,
              severity,
              channel,
              recipientUserId: user.id,
              recipientResellerId: user.reseller_id ?? (recipientType === 'reseller' ? resellerId : null),
              resourceType,
              resourceId,
              title,
              body,
              dedupeKey: plan.dedupeKey,
            },
            client,
          );
          if (!notification) {
            skipped += 1;
            continue;
          }
          created.push(notification);

          if (channel === 'email') {
            const delivery = await repo.insertEmailDelivery(
              { notificationId: notification.id, recipientEmail: user.email, subject: title },
              client,
            );
            if (delivery) {
              await enqueue(
                {
                  type: EMAIL_DELIVERY_JOB_TYPE,
                  payload: { deliveryId: delivery.id },
                  maxAttempts: delivery.max_attempts,
                  dedupeKey: `notif-email:${notification.id}`,
                },
                client,
              );
            }
          }
        }
      }
    }

    return { created, skipped, plan };
  }

  async function list({ auth, unreadOnly = false, limit = 50, offset = 0 } = {}, opts = {}) {
    const user = requireUser(auth);
    const rows = await repo.listForUser(user.id, { unreadOnly, limit, offset }, opts.runner ?? runner);
    return rows.map(toNotificationDto);
  }

  async function unreadCount({ auth } = {}, opts = {}) {
    const user = requireUser(auth);
    return repo.countUnread(user.id, opts.runner ?? runner);
  }

  async function markRead({ auth, notificationId } = {}, opts = {}) {
    const user = requireUser(auth);
    if (!notificationId) throw new ValidationError('notificationId is required', 'notification_id_required');
    const row = await repo.markRead({ notificationId, userId: user.id }, opts.runner ?? runner);
    if (!row) throw new NotFoundError('Notification not found', 'notification_not_found');
    return toNotificationDto(row);
  }

  /**
   * Return a safe link to the notification's resource, or null when the
   * resource is unknown or belongs to another tenant. A reseller-scoped user
   * can only link to resources owned by their own reseller.
   */
  async function resolveResourceLink({ auth, notification } = {}, opts = {}) {
    const user = requireUser(auth);
    if (!notification?.resourceType || !notification.resourceId) return null;
    const build = RESOURCE_LINK_BUILDERS[notification.resourceType];
    if (!build) return null;

    if (user.role !== 'admin') {
      const owner = await repo.findResourceOwner(
        { resourceType: notification.resourceType, resourceId: notification.resourceId },
        opts.runner ?? runner,
      );
      if (!owner || owner.reseller_id !== user.reseller_id) return null;
    }
    return { resourceType: notification.resourceType, resourceId: notification.resourceId, href: build(notification.resourceId) };
  }

  return { emit, list, unreadCount, markRead, resolveResourceLink };
}
