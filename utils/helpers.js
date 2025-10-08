const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

// Password hashing utilities
const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

// Email configuration
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Send email utility
const sendEmail = async (to, subject, html) => {
  try {
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@autofleet.com',
      to,
      subject,
      html
    };

    const info = await emailTransporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email sending failed:', error);
    return { success: false, error: error.message };
  }
};

// Generate unique ID
const generateId = () => {
  return uuidv4();
};

// Date utilities
const formatDate = (date) => {
  return new Date(date).toISOString().split('T')[0];
};

const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

const calculateDaysBetween = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const timeDiff = end.getTime() - start.getTime();
  return Math.ceil(timeDiff / (1000 * 3600 * 24));
};

// Validation utilities
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
  return phoneRegex.test(phone);
};

// Response utilities
const successResponse = (res, data, message = 'Success') => {
  return res.status(200).json({
    success: true,
    message,
    data
  });
};

const errorResponse = (res, message = 'Error', statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    message,
    error: message
  });
};

// File upload utilities
const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];

const validateImageFile = (file) => {
  return allowedImageTypes.includes(file.mimetype);
};

module.exports = {
  hashPassword,
  comparePassword,
  sendEmail,
  generateId,
  formatDate,
  addDays,
  calculateDaysBetween,
  validateEmail,
  validatePhone,
  successResponse,
  errorResponse,
  validateImageFile
};

