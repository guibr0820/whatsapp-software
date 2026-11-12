// payment_status='paid' historically means the booking deposit was paid.
// Only the recorded net amount covering the total means the entire service is paid.
export function appointmentPayment(item) {
  const cents = value => Math.max(0, Math.round((Number(value) || 0) * 100));
  const total = item.price == null ? null : cents(item.price);
  const deposit = cents(item.deposit);
  const received = Math.max(0, cents(item.paid) - cents(item.refunded));
  const reversed = ['refunded','refund_pending','refund_failed','retained'].includes(item.paymentStatus);
  const fullyPaid = total > 0 && received >= total && !reversed;
  return { total, deposit, received, hasDeposit: deposit > 0, fullyPaid, partial: received > 0 && !fullyPaid && !reversed, remaining: total == null ? null : Math.max(0, total - received), reversed };
}
