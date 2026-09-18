const express = require('express');
const router = express.Router();
const { connectMongo, toObjectId } = require('../config/mongodb');
const { authenticateToken, requireOwnerOrAdmin, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

const allowedTypes = ['sedan', 'suv', 'van', 'truck'];
const activeBookingStatuses = ['confirmed', 'active', 'pending'];

async function collections() {
  const database = await connectMongo();
  return {
    vehicles: database.collection('vehicles'),
    users: database.collection('users'),
    bookings: database.collection('bookings')
  };
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch { return value.split(',').map((item) => item.trim()).filter(Boolean); }
  }
  return [];
}

function publicVehicle(vehicle, owner, bookingsCount = 0, isBooked = false) {
  const images = parseArray(vehicle.images);
  const features = parseArray(vehicle.features);
  const listingType = vehicle.listing_type || 'rent';
  const displayPrice = listingType === 'sale' ? vehicle.selling_price : vehicle.daily_rate;
  const displayStatus = listingType === 'sale' && ['rented', 'inactive'].includes(vehicle.status)
    ? 'Sold'
    : isBooked ? 'Rented' : (vehicle.status ? `${vehicle.status[0].toUpperCase()}${vehicle.status.slice(1)}` : '');

  return {
    ...vehicle,
    id: vehicle._id.toString(),
    _id: undefined,
    legacyId: undefined,
    owner_id: vehicle.owner_id?.toString?.() || vehicle.owner_id,
    owner_first_name: owner?.first_name,
    owner_last_name: owner?.last_name,
    owner_phone: owner?.phone,
    owner_email: owner?.email,
    features,
    images,
    bookings: bookingsCount,
    price: displayPrice,
    price_label: listingType === 'sale' ? 'For Sale' : 'Per Day',
    listing_type: listingType,
    plate: vehicle.license_plate,
    status: displayStatus,
    type: vehicle.type ? `${vehicle.type[0].toUpperCase()}${vehicle.type.slice(1)}` : '',
    image: images[0] || null,
    locationLat: vehicle.location_lat,
    locationLng: vehicle.location_lng,
    locationAddress: vehicle.location_address
  };
}

async function isVehicleBooked(bookings, vehicleId, pickupDate, returnDate) {
  const start = pickupDate ? new Date(pickupDate) : new Date();
  const end = returnDate ? new Date(returnDate) : start;
  const booking = await bookings.findOne({
    vehicle_id: vehicleId,
    status: { $in: activeBookingStatuses },
    start_date: { $lte: end },
    end_date: { $gte: start }
  });
  return Boolean(booking);
}

function vehicleFilter(query) {
  const filter = {};
  if (query.type) filter.type = query.type.toLowerCase();
  if (query.status) filter.status = query.status.toLowerCase();
  if (query.listing_type) filter.listing_type = query.listing_type;
  if (query.location) filter.location_address = { $regex: query.location, $options: 'i' };
  if (query.search) {
    filter.$or = [
      { make: { $regex: query.search, $options: 'i' } },
      { model: { $regex: query.search, $options: 'i' } },
      { description: { $regex: query.search, $options: 'i' } }
    ];
  }
  const minPrice = query.minPrice !== undefined ? Number(query.minPrice) : null;
  const maxPrice = query.maxPrice !== undefined ? Number(query.maxPrice) : null;
  if (minPrice !== null || maxPrice !== null) {
    const priceConditions = [];
    for (const field of ['daily_rate', 'selling_price']) {
      const condition = {};
      if (minPrice !== null && Number.isFinite(minPrice)) condition.$gte = minPrice;
      if (maxPrice !== null && Number.isFinite(maxPrice)) condition.$lte = maxPrice;
      priceConditions.push({ [field]: condition });
    }
    filter.$and = [{ $or: priceConditions }];
  }
  return filter;
}

router.get('/', async (req, res) => {
  try {
    const { vehicles, users, bookings } = await collections();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
    const sortBy = ['created_at', 'daily_rate', 'selling_price', 'make', 'model', 'year'].includes(req.query.sortBy) ? req.query.sortBy : 'created_at';
    const sortDirection = String(req.query.sortOrder).toUpperCase() === 'ASC' ? 1 : -1;
    const filter = vehicleFilter(req.query);
    const total = await vehicles.countDocuments(filter);
    const records = await vehicles.find(filter).sort({ [sortBy]: sortDirection }).skip((page - 1) * limit).limit(limit).toArray();
    const result = [];

    for (const vehicle of records) {
      const owner = vehicle.owner_id ? await users.findOne({ _id: vehicle.owner_id }) : null;
      const bookingsCount = await bookings.countDocuments({ vehicle_id: vehicle._id });
      const isBooked = await isVehicleBooked(bookings, vehicle._id, req.query.pickupDate, req.query.returnDate);
      result.push(publicVehicle(vehicle, owner, bookingsCount, isBooked));
    }

    return successResponse(res, {
      vehicles: result,
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit), totalVehicles: total, hasNext: page * limit < total, hasPrev: page > 1 },
      filters: { ...req.query, sortBy, sortOrder: sortDirection === 1 ? 'ASC' : 'DESC' }
    }, 'Vehicles retrieved successfully');
  } catch (error) {
    console.error('MongoDB vehicle list error:', error);
    return errorResponse(res, `Vehicle database error: ${error.message}`, 500);
  }
});

router.get('/featured', async (req, res) => {
  req.query.status = req.query.status || 'available';
  req.query.limit = req.query.limit || 3;
  try {
    const { vehicles, users, bookings } = await collections();
    const filter = vehicleFilter(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 3, 1), 50);
    const records = await vehicles.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
    const result = [];
    for (const vehicle of records) {
      const owner = vehicle.owner_id ? await users.findOne({ _id: vehicle.owner_id }) : null;
      const isBooked = await isVehicleBooked(bookings, vehicle._id, req.query.pickupDate, req.query.returnDate);
      const item = publicVehicle(vehicle, owner, 0, isBooked);
      result.push({ id: item.id, name: `${vehicle.make} ${vehicle.model}`, price: item.price, daily_rate: vehicle.daily_rate, selling_price: vehicle.selling_price, listing_type: item.listing_type, price_label: item.price_label, type: `${item.type}${vehicle.transmission ? ` • ${vehicle.transmission}` : ''}`, status: item.status, img: item.image, rating: 4.8, reviews: 127 });
    }
    return successResponse(res, { vehicles: result, pagination: { currentPage: 1, totalPages: 1, totalVehicles: result.length, hasNext: false, hasPrev: false }, filters: req.query }, 'Featured vehicles retrieved successfully');
  } catch (error) {
    console.error('MongoDB featured vehicles error:', error);
    return errorResponse(res, `Vehicle database error: ${error.message}`, 500);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { vehicles, users, bookings } = await collections();
    const vehicle = await vehicles.findOne({ _id: toObjectId(req.params.id) });
    if (!vehicle) return errorResponse(res, 'Vehicle not found', 404);
    const owner = vehicle.owner_id ? await users.findOne({ _id: vehicle.owner_id }) : null;
    const isBooked = await isVehicleBooked(bookings, vehicle._id);
    return successResponse(res, publicVehicle(vehicle, owner, await bookings.countDocuments({ vehicle_id: vehicle._id }), isBooked), 'Vehicle retrieved successfully');
  } catch (error) {
    return errorResponse(res, `Vehicle database error: ${error.message}`, 500);
  }
});

router.post('/', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { vehicles } = await collections();
    const { make, model, year, category, type, plateNumber, licensePlate, color, seats, transmission, fuelType, daily_rate, description, features, images, locationLat, locationLng, locationAddress, listing_type = 'rent', selling_price } = req.body;
    const vehicleType = String(category || type || '').toLowerCase();
    const license = String(plateNumber || licensePlate || '').trim();
    if (!make || !model || !year || !vehicleType || !license) return errorResponse(res, 'Make, model, year, type, and license plate are required', 400);
    if (!allowedTypes.includes(vehicleType)) return errorResponse(res, 'Invalid vehicle type', 400);
    if (listing_type === 'rent' && Number(daily_rate) <= 0) return errorResponse(res, 'Daily rate must be greater than 0', 400);
    if (listing_type === 'sale' && Number(selling_price) <= 0) return errorResponse(res, 'Selling price must be greater than 0', 400);
    if (await vehicles.findOne({ license_plate: license })) return errorResponse(res, 'Vehicle with this license plate already exists', 409);

    const now = new Date();
    const vehicle = { owner_id: toObjectId(req.user.id), make: String(make).trim(), model: String(model).trim(), year: Number(year), type: vehicleType, license_plate: license, color: color || null, seats: seats ? Number(seats) : null, transmission: transmission || 'automatic', fuel_type: fuelType || 'gasoline', daily_rate: listing_type === 'rent' ? Number(daily_rate) : null, description: description || null, features: parseArray(features), images: parseArray(images), status: 'inactive', location_lat: locationLat == null ? null : Number(locationLat), location_lng: locationLng == null ? null : Number(locationLng), location_address: locationAddress || null, listing_type, selling_price: listing_type === 'sale' ? Number(selling_price) : null, created_at: now, updated_at: now };
    const result = await vehicles.insertOne(vehicle);
    return successResponse(res, { vehicleId: result.insertedId.toString() }, 'Vehicle submitted for approval successfully');
  } catch (error) {
    console.error('MongoDB add vehicle error:', error);
    return errorResponse(res, `Internal server error: ${error.message}`, 500);
  }
});

router.put('/admin/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { vehicles } = await collections();
    const status = String(req.body.status || '').toLowerCase();
    if (!['available', 'inactive', 'maintenance', 'rented'].includes(status)) return errorResponse(res, 'Valid status is required', 400);
    const result = await vehicles.updateOne({ _id: toObjectId(req.params.id) }, { $set: { status, updated_at: new Date() } });
    if (!result.matchedCount) return errorResponse(res, 'Vehicle not found', 404);
    return successResponse(res, null, 'Vehicle status updated successfully');
  } catch (error) { return errorResponse(res, `Vehicle database error: ${error.message}`, 500); }
});

router.put('/:id', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { vehicles } = await collections();
    const id = toObjectId(req.params.id);
    const current = await vehicles.findOne({ _id: id });
    if (!current) return errorResponse(res, 'Vehicle not found', 404);
    if (req.user.role !== 'admin' && current.owner_id?.toString() !== req.user.id) return errorResponse(res, 'Access denied', 403);
    const allowed = ['make', 'model', 'year', 'type', 'color', 'seats', 'transmission', 'fuel_type', 'daily_rate', 'description', 'features', 'images', 'location_lat', 'location_lng', 'location_address', 'status', 'listing_type', 'selling_price'];
    const updates = {};
    for (const field of allowed) if (req.body[field] !== undefined) updates[field] = req.body[field];
    if (req.body.licensePlate !== undefined) updates.license_plate = req.body.licensePlate;
    if (req.body.locationLat !== undefined) updates.location_lat = Number(req.body.locationLat);
    if (req.body.locationLng !== undefined) updates.location_lng = Number(req.body.locationLng);
    updates.updated_at = new Date();
    await vehicles.updateOne({ _id: id }, { $set: updates });
    return successResponse(res, null, 'Vehicle updated successfully');
  } catch (error) { return errorResponse(res, `Vehicle database error: ${error.message}`, 500); }
});

router.delete('/:id', authenticateToken, requireOwnerOrAdmin, async (req, res) => {
  try {
    const { vehicles } = await collections();
    const id = toObjectId(req.params.id);
    const current = await vehicles.findOne({ _id: id });
    if (!current) return errorResponse(res, 'Vehicle not found', 404);
    if (req.user.role !== 'admin' && current.owner_id?.toString() !== req.user.id) return errorResponse(res, 'Access denied', 403);
    await vehicles.deleteOne({ _id: id });
    return successResponse(res, null, 'Vehicle deleted successfully');
  } catch (error) { return errorResponse(res, `Vehicle database error: ${error.message}`, 500); }
});

module.exports = router;
