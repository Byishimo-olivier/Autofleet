const pool = require('../config/database');
const PaypackService = require('./PaypackService');

let isRunning = false;

const parseInterval = () => {
  const raw = process.env.PAYPACK_SYNC_INTERVAL_MS;
  const ms = raw ? parseInt(raw, 10) : 60000;
  return Number.isFinite(ms) && ms >= 10000 ? ms : 60000;
};

const shouldRun = () => {
  if (process.env.NODE_ENV === 'test') return false;
  const flag = process.env.PAYPACK_AUTO_SYNC;
  return flag === undefined || String(flag).toLowerCase() !== 'false';
};

const syncPendingPayments = async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const { rows: bookings } = await pool.query(
      `SELECT id, vehicle_id, payment_transaction_id
       FROM bookings
       WHERE payment_status = 'pending'
         AND payment_method = 'mobile'
         AND payment_transaction_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 50`
    );

    if (!bookings.length) return;

    const paypack = new PaypackService();

    for (const booking of bookings) {
      try {
        const ref = booking.payment_transaction_id;
        if (!ref || ref.startsWith('TXN_')) {
          continue;
        }

        const transactionData = await paypack.verifyPayment(ref);
        const status = transactionData?.status;
        const isSuccess = status === 'completed' || status === 'successful' || (!status && process.env.PAYPACK_TEST_MODE === 'true' && transactionData?.ref);
        if (transactionData && isSuccess) {
          await paypack.handlePaypackWebhook({
            reference: ref,
            status: 'completed',
            amount: transactionData.amount,
            paid_at: new Date().toISOString(),
            booking_id: booking.id
          });

          const { rows: vehicleRows } = await pool.query(
            'SELECT listing_type FROM vehicles WHERE id = $1',
            [booking.vehicle_id]
          );
          const vehicle = vehicleRows[0];
          if (vehicle) {
            const newStatus = vehicle.listing_type === 'sale' ? 'sold' : 'rented';
            await pool.query('UPDATE vehicles SET status = $1 WHERE id = $2', [newStatus, booking.vehicle_id]);
          }
        }
      } catch (err) {
        // Keep going; one failure shouldn't stop the batch
      }
    }
  } catch (err) {
    // Swallow to avoid crashing the server
  } finally {
    isRunning = false;
  }
};

const startPaypackAutoSync = () => {
  if (!shouldRun()) return;
  const interval = parseInterval();
  setInterval(syncPendingPayments, interval);
  // Kick off once at startup
  syncPendingPayments();
};

module.exports = { startPaypackAutoSync };
