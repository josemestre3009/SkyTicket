import { maskCode, maskEmail } from '../lib/redact.js';

const COP = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const DATETIME = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
const DATE = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' });

/** COP is stored as an integer (no cents); render it as whole pesos. */
export function formatCop(minor) {
  if (minor === null || minor === undefined || minor === '') return '—';
  const value = Number(minor);
  if (!Number.isFinite(value)) return '—';
  return `$ ${COP.format(value)}`;
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value) {
  const date = asDate(value);
  return date ? DATETIME.format(date) : '—';
}

export function formatDate(value) {
  const date = asDate(value);
  return date ? DATE.format(date) : '—';
}

export function label(value) {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value).replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const STATUS_LABELS = Object.freeze({
  pending: 'Pendiente',
  active: 'Activo',
  suspended: 'Suspendido',
  restricted: 'Restringido',
  closed: 'Cerrado',
  disabled: 'Deshabilitado',
});

/** Spanish label for a reseller, site or user status. */
export function statusLabel(value) {
  if (value === null || value === undefined || value === '') return '—';
  return STATUS_LABELS[value] ?? label(value);
}

const DOMAIN_LABELS = Object.freeze({
  admin: 'Administrador',
  reseller: 'Revendedor',
  draft: 'Borrador',
  reserved: 'Reservada',
  issuing: 'Emitiendo',
  issued: 'Emitida',
  partially_issued: 'Emision parcial',
  needs_reconciliation: 'Verificando resultado',
  failed: 'Fallida',
  canceled: 'Cancelada',
  captured: 'Capturada',
  released: 'Liberada',
  recharge: 'Recarga',
  adjustment_credit: 'Ajuste a favor',
  adjustment_debit: 'Ajuste en contra',
  reversal: 'Reverso',
  success: 'Exitoso',
  succeeded: 'Exitoso',
  failure: 'Fallido',
  denied: 'Denegado',
  info: 'Informativo',
  warning: 'Advertencia',
  high: 'Alta',
  critical: 'Critica',
  user: 'Usuario',
  session: 'Sesion',
  reseller_site: 'Sitio del revendedor',
  voucher_order: 'Orden',
  voucher: 'Bono',
  price_version: 'Precio',
  status_change: 'Cambio de estado',
});

export function domainLabel(value) {
  if (value === null || value === undefined || value === '') return '—';
  return STATUS_LABELS[value] ?? DOMAIN_LABELS[value] ?? label(value);
}

export function failureLabel(value) {
  const labels = {
    emission_disabled: 'La emisión real estaba desactivada.',
    ruijie_rejected: 'Ruijie rechazó la solicitud.',
    insufficient_balance: 'Saldo insuficiente.',
    circuit_open: 'Ruijie no está disponible temporalmente.',
  };
  return labels[value] ?? label(value);
}

const VOUCHER_STATUS_LABELS = Object.freeze({
  unused: 'Disponible',
  in_use: 'En uso',
  expired: 'Vencido',
  unknown: 'Desconocido',
});

/** Spanish label for a normalized remote-voucher status. */
export function voucherStatusLabel(status) {
  if (status === null || status === undefined || status === '') return '—';
  return VOUCHER_STATUS_LABELS[status] ?? label(status);
}

const BADGE_TONE = Object.freeze({
  active: 'ok',
  issued: 'ok',
  succeeded: 'ok',
  success: 'ok',
  sent: 'ok',
  confirmed: 'ok',
  resolved: 'ok',
  pending: 'warn',
  reserved: 'warn',
  issuing: 'warn',
  in_use: 'ok',
  in_review: 'warn',
  partially_issued: 'warn',
  needs_reconciliation: 'warn',
  restricted: 'warn',
  unused: 'warn',
  draft: 'neutral',
  info: 'neutral',
  suspended: 'danger',
  failed: 'danger',
  canceled: 'danger',
  closed: 'danger',
  critical: 'danger',
  denied: 'danger',
  failure: 'danger',
  high: 'danger',
  warning: 'warn',
  expired: 'danger',
});

export function badgeTone(status) {
  return BADGE_TONE[status] ?? 'neutral';
}

export function badgeClass(status) {
  return `badge badge--${badgeTone(status)}`;
}

export const helpers = Object.freeze({
  formatCop,
  formatDateTime,
  formatDate,
  label,
  statusLabel,
  domainLabel,
  failureLabel,
  voucherStatusLabel,
  badgeTone,
  badgeClass,
  maskCode,
  maskEmail,
});

export default helpers;
