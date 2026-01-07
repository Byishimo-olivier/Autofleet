const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

class EmailService {
  constructor() {
    this.transporter = this.createTransporter();
    this.from = process.env.SMTP_FROM || 'AutoFleet Hub <noreply@autofleet.com>';
    this.baseUrl = process.env.CLIENT_URL || 'http://localhost:3000';
  }

  createTransporter() {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: process.env.SMTP_PORT || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  // Test email configuration
  async testConnection() {
    try {
      await this.transporter.verify();
      console.log('✅ Email service is ready');
      return true;
    } catch (error) {
      console.error('❌ Email service error:', error);
      return false;
    }
  }

  // Generic email sender
  async sendEmail(to, subject, html, attachments = []) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject,
        html,
        attachments
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Email sending failed:', error);
      return { success: false, error: error.message };
    }
  }

  // 🔐 AUTHENTICATION EMAILS
  
  // Welcome email for new users
  async sendWelcomeEmail(user) {
    const subject = 'Welcome to AutoFleet Hub!';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2c3e7d; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .button { display: inline-block; background: #2c3e7d; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to AutoFleet Hub!</h1>
          </div>
          <div class="content">
            <h2>Hello ${user.firstName} ${user.lastName}!</h2>
            <p>Thank you for joining AutoFleet Hub. Your account has been successfully created.</p>
            
            <h3>Account Details:</h3>
            <ul>
              <li><strong>Email:</strong> ${user.email}</li>
              <li><strong>Role:</strong> ${user.role.charAt(0).toUpperCase() + user.role.slice(1)}</li>
              <li><strong>Phone:</strong> ${user.phone || 'Not provided'}</li>
            </ul>

            ${user.role === 'customer' ? `
              <p>As a customer, you can now:</p>
              <ul>
                <li>Browse and rent vehicles</li>
                <li>Manage your bookings</li>
                <li>Leave feedback and reviews</li>
                <li>Get support when needed</li>
              </ul>
            ` : user.role === 'owner' ? `
              <p>As a vehicle owner, you can now:</p>
              <ul>
                <li>List your vehicles for rent or sale</li>
                <li>Manage bookings and availability</li>
                <li>Track your earnings</li>
                <li>Communicate with customers</li>
              </ul>
            ` : ''}

            <a href="${this.baseUrl}/login" class="button">Get Started</a>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // Password reset email
  async sendPasswordResetEmail(user, resetToken) {
    const subject = 'Reset Your Password - AutoFleet Hub';
    const resetUrl = `${this.baseUrl}/reset-password?token=${resetToken}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2c3e7d; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .button { display: inline-block; background: #dc3545; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Password Reset Request</h1>
          </div>
          <div class="content">
            <h2>Hello ${user.first_name}!</h2>
            <p>We received a request to reset your password for your AutoFleet Hub account.</p>
            
            <div class="warning">
              <strong>⚠️ Security Notice:</strong> If you didn't request this password reset, please ignore this email and your password will remain unchanged.
            </div>

            <p>To reset your password, click the button below:</p>
            <a href="${resetUrl}" class="button">Reset Password</a>
            
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 5px;">${resetUrl}</p>
            
            <p><strong>This link will expire in 1 hour for security reasons.</strong></p>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // Password change confirmation
  async sendPasswordChangeConfirmation(user) {
    const subject = 'Password Changed Successfully - AutoFleet Hub';
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Password Changed Successfully</h1>
          </div>
          <div class="content">
            <h2>Hello ${user.first_name}!</h2>
            
            <div class="success">
              <strong>Your password has been successfully changed.</strong>
            </div>

            <p>Your AutoFleet Hub account password was updated on ${new Date().toLocaleString()}.</p>
            
            <p>If you didn't make this change, please contact our support team immediately at support@autofleet.com</p>

            <h3>Security Tips:</h3>
            <ul>
              <li>Use a strong, unique password for your account</li>
              <li>Don't share your password with anyone</li>
              <li>Log out from shared or public computers</li>
            </ul>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // 🚗 BOOKING EMAILS

  // Booking confirmation email
  async sendBookingConfirmation(booking, customer, vehicle, owner) {
    const subject = `Booking Confirmation #BK-${booking.id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .booking-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .button { display: inline-block; background: #2c3e7d; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎉 Booking Confirmed!</h1>
            <h2>Booking #BK-${booking.id}</h2>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>Great news! Your vehicle booking has been confirmed.</p>
            
            <div class="booking-details">
              <h3>📋 Booking Details</h3>
              <div class="detail-row">
                <span><strong>Booking ID:</strong></span>
                <span>#BK-${booking.id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year}</span>
              </div>
              <div class="detail-row">
                <span><strong>License Plate:</strong></span>
                <span>${vehicle.license_plate}</span>
              </div>
              <div class="detail-row">
                <span><strong>Pickup Date:</strong></span>
                <span>${new Date(booking.start_date).toLocaleDateString()}</span>
              </div>
              <div class="detail-row">
                <span><strong>Return Date:</strong></span>
                <span>${new Date(booking.end_date).toLocaleDateString()}</span>
              </div>
              <div class="detail-row">
                <span><strong>Duration:</strong></span>
                <span>${booking.duration_days || 'N/A'} days</span>
              </div>
              <div class="detail-row">
                <span><strong>Total Amount:</strong></span>
                <span><strong>$${booking.total_amount}</strong></span>
              </div>
              <div class="detail-row">
                <span><strong>Payment Status:</strong></span>
                <span>${booking.payment_status}</span>
              </div>
              <div class="detail-row">
                <span><strong>Pickup Location:</strong></span>
                <span>${booking.pickup_location}</span>
              </div>
            </div>

            <div class="booking-details">
              <h3>👤 Owner Contact</h3>
              <p><strong>Name:</strong> ${owner.first_name} ${owner.last_name}</p>
              <p><strong>Phone:</strong> ${owner.phone || 'Not provided'}</p>
              <p><strong>Email:</strong> ${owner.email}</p>
            </div>

            <h3>📱 Next Steps:</h3>
            <ul>
              <li>Contact the vehicle owner to arrange pickup details</li>
              <li>Bring a valid driver's license</li>
              <li>Inspect the vehicle before pickup</li>
              <li>Take photos of any existing damage</li>
            </ul>

            <a href="${this.baseUrl}/bookings/${booking.id}" class="button">View Booking Details</a>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // New booking notification to owner
  async sendNewBookingNotification(booking, customer, vehicle, owner) {
    const subject = `New Booking Request #BK-${booking.id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2c3e7d; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .booking-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .button { display: inline-block; background: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
          .button-danger { background: #dc3545; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚗 New Booking Request!</h1>
            <h2>Booking #BK-${booking.id}</h2>
          </div>
          <div class="content">
            <h2>Hello ${owner.first_name}!</h2>
            <p>You have received a new booking request for your vehicle.</p>
            
            <div class="booking-details">
              <h3>📋 Booking Details</h3>
              <div class="detail-row">
                <span><strong>Booking ID:</strong></span>
                <span>#BK-${booking.id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year}</span>
              </div>
              <div class="detail-row">
                <span><strong>Customer:</strong></span>
                <span>${customer.first_name} ${customer.last_name}</span>
              </div>
              <div class="detail-row">
                <span><strong>Customer Phone:</strong></span>
                <span>${customer.phone || 'Not provided'}</span>
              </div>
              <div class="detail-row">
                <span><strong>Pickup Date:</strong></span>
                <span>${new Date(booking.start_date).toLocaleDateString()}</span>
              </div>
              <div class="detail-row">
                <span><strong>Return Date:</strong></span>
                <span>${new Date(booking.end_date).toLocaleDateString()}</span>
              </div>
              <div class="detail-row">
                <span><strong>Total Amount:</strong></span>
                <span><strong>$${booking.total_amount}</strong></span>
              </div>
            </div>

            <p><strong>Please review and respond to this booking request as soon as possible.</strong></p>
            
            <div style="text-align: center;">
              <a href="${this.baseUrl}/bookings/${booking.id}?action=confirm" class="button">Confirm Booking</a>
              <a href="${this.baseUrl}/bookings/${booking.id}?action=reject" class="button button-danger">Reject Booking</a>
            </div>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(owner.email, subject, html);
  }

  // Booking status update email
  async sendBookingStatusUpdate(booking, user, newStatus, oldStatus) {
    const subject = `Booking #BK-${booking.id} Status Updated - AutoFleet Hub`;
    
    const statusMessages = {
      confirmed: '✅ Your booking has been confirmed!',
      cancelled: '❌ Your booking has been cancelled',
      completed: '🎉 Your booking has been completed',
      active: '🚗 Your booking is now active'
    };

    const statusColors = {
      confirmed: '#28a745',
      cancelled: '#dc3545',
      completed: '#6c757d',
      active: '#007bff'
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${statusColors[newStatus] || '#2c3e7d'}; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .status-change { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; text-align: center; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Booking Status Update</h1>
            <h2>Booking #BK-${booking.id}</h2>
          </div>
          <div class="content">
            <h2>Hello ${user.first_name}!</h2>
            
            <div class="status-change">
              <h3>${statusMessages[newStatus] || 'Booking status has been updated'}</h3>
              <p><strong>Previous Status:</strong> ${oldStatus.charAt(0).toUpperCase() + oldStatus.slice(1)}</p>
              <p><strong>New Status:</strong> ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}</p>
            </div>

            ${newStatus === 'confirmed' ? `
              <p>Great! Your booking has been confirmed. You can now proceed with the vehicle pickup.</p>
            ` : newStatus === 'cancelled' ? `
              <p>Your booking has been cancelled. If you have any questions, please contact support.</p>
            ` : newStatus === 'completed' ? `
              <p>Thank you for using AutoFleet Hub! We hope you had a great experience.</p>
              <p>Don't forget to leave a review about your experience.</p>
            ` : ''}

            <p>For more details about your booking, please visit your dashboard.</p>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // Payment confirmation email
  async sendPaymentConfirmation(booking, customer, paymentDetails) {
    const subject = `Payment Confirmation #BK-${booking.id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .payment-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💳 Payment Confirmed!</h1>
            <h2>Booking #BK-${booking.id}</h2>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>Your payment has been successfully processed.</p>
            
            <div class="payment-details">
              <h3>💰 Payment Details</h3>
              <div class="detail-row">
                <span><strong>Booking ID:</strong></span>
                <span>#BK-${booking.id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Amount Paid:</strong></span>
                <span><strong>$${booking.total_amount}</strong></span>
              </div>
              <div class="detail-row">
                <span><strong>Payment Method:</strong></span>
                <span>${booking.payment_method}</span>
              </div>
              <div class="detail-row">
                <span><strong>Transaction ID:</strong></span>
                <span>${booking.payment_transaction_id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Payment Date:</strong></span>
                <span>${new Date().toLocaleDateString()}</span>
              </div>
            </div>

            <p>Your booking is now confirmed and you can proceed with the vehicle pickup.</p>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // 🎫 SUPPORT EMAILS

  // Support ticket created confirmation
  async sendSupportTicketCreated(ticket, user) {
    const subject = `Support Ticket Created: ${ticket.ticket_id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #17a2b8; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .ticket-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎫 Support Ticket Created</h1>
            <h2>Ticket ${ticket.ticket_id}</h2>
          </div>
          <div class="content">
            <h2>Hello ${user.first_name}!</h2>
            <p>Your support ticket has been created successfully. We'll get back to you as soon as possible.</p>
            
            <div class="ticket-details">
              <h3>📋 Ticket Details</h3>
              <div class="detail-row">
                <span><strong>Ticket ID:</strong></span>
                <span>${ticket.ticket_id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Subject:</strong></span>
                <span>${ticket.subject}</span>
              </div>
              <div class="detail-row">
                <span><strong>Category:</strong></span>
                <span>${ticket.category}</span>
              </div>
              <div class="detail-row">
                <span><strong>Priority:</strong></span>
                <span>${ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1)}</span>
              </div>
              <div class="detail-row">
                <span><strong>Status:</strong></span>
                <span>${ticket.status.charAt(0).toUpperCase() + ticket.status.slice(1)}</span>
              </div>
              <div class="detail-row">
                <span><strong>Created:</strong></span>
                <span>${new Date(ticket.created_at).toLocaleString()}</span>
              </div>
            </div>

            <div style="background: white; padding: 20px; border-radius: 5px;">
              <h3>📝 Your Message:</h3>
              <p style="background: #f8f9fa; padding: 15px; border-radius: 5px;">${ticket.description}</p>
            </div>

            <h3>⏱️ What happens next?</h3>
            <ul>
              <li>Our support team will review your request</li>
              <li>You'll receive updates via email</li>
              <li>Expected response time: 24-48 hours</li>
            </ul>
          </div>
          <div class="footer">
            <p>Reference your ticket with ID: ${ticket.ticket_id}</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // Support ticket response notification
  async sendSupportTicketResponse(ticket, user, response, responder) {
    const subject = `Response to Ticket ${ticket.ticket_id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #6f42c1; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .response { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #6f42c1; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💬 New Response to Your Ticket</h1>
            <h2>Ticket ${ticket.ticket_id}</h2>
          </div>
          <div class="content">
            <h2>Hello ${user.first_name}!</h2>
            <p>You have received a new response to your support ticket.</p>
            
            <div class="response">
              <h3>Response from ${responder.first_name} ${responder.last_name} (${responder.role})</h3>
              <p><strong>Date:</strong> ${new Date(response.created_at).toLocaleString()}</p>
              <hr>
              <p>${response.message}</p>
            </div>

            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Current Status:</strong> ${ticket.status.charAt(0).toUpperCase() + ticket.status.slice(1)}</p>

            <p>You can reply to this ticket by logging into your account or replying to this email.</p>
          </div>
          <div class="footer">
            <p>Reference your ticket with ID: ${ticket.ticket_id}</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // Dispute created notification
  async sendDisputeCreated(dispute, customer, booking, vehicle) {
    const subject = `Dispute Created: DSP-${dispute.id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .dispute-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚖️ Dispute Created</h1>
            <h2>Dispute DSP-${dispute.id}</h2>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>Your dispute has been created and submitted for review.</p>
            
            <div class="dispute-details">
              <h3>📋 Dispute Details</h3>
              <div class="detail-row">
                <span><strong>Dispute ID:</strong></span>
                <span>DSP-${dispute.id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Related Booking:</strong></span>
                <span>#BK-${booking.id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year}</span>
              </div>
              <div class="detail-row">
                <span><strong>Reason:</strong></span>
                <span>${dispute.reason}</span>
              </div>
              <div class="detail-row">
                <span><strong>Priority:</strong></span>
                <span>${dispute.priority.charAt(0).toUpperCase() + dispute.priority.slice(1)}</span>
              </div>
              <div class="detail-row">
                <span><strong>Status:</strong></span>
                <span>${dispute.status.charAt(0).toUpperCase() + dispute.status.slice(1)}</span>
              </div>
            </div>

            <div style="background: white; padding: 20px; border-radius: 5px;">
              <h3>📝 Your Message:</h3>
              <p style="background: #f8f9fa; padding: 15px; border-radius: 5px;">${dispute.description}</p>
            </div>

            <h3>⏱️ What happens next?</h3>
            <ul>
              <li>Our team will review your dispute within 24-48 hours</li>
              <li>We may contact you for additional information</li>
              <li>You'll receive updates via email</li>
              <li>All parties will be notified of the resolution</li>
            </ul>
          </div>
          <div class="footer">
            <p>Reference your dispute with ID: DSP-${dispute.id}</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // 🔧 VEHICLE MANAGEMENT EMAILS

  // Vehicle approval notification
  async sendVehicleApproved(vehicle, owner) {
    const subject = `Vehicle Approved: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .vehicle-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .button { display: inline-block; background: #2c3e7d; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Vehicle Approved!</h1>
          </div>
          <div class="content">
            <h2>Hello ${owner.first_name}!</h2>
            <p>Great news! Your vehicle has been approved and is now available for booking.</p>
            
            <div class="vehicle-details">
              <h3>🚗 Vehicle Details</h3>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year}</span>
              </div>
              <div class="detail-row">
                <span><strong>License Plate:</strong></span>
                <span>${vehicle.license_plate}</span>
              </div>
              <div class="detail-row">
                <span><strong>Type:</strong></span>
                <span>${vehicle.type}</span>
              </div>
              <div class="detail-row">
                <span><strong>Daily Rate:</strong></span>
                <span>$${vehicle.daily_rate || 'N/A'}</span>
              </div>
              <div class="detail-row">
                <span><strong>Status:</strong></span>
                <span>Available</span>
              </div>
            </div>

            <h3>🎉 What's Next?</h3>
            <ul>
              <li>Your vehicle is now visible to customers</li>
              <li>You'll receive notifications for new bookings</li>
              <li>Monitor your dashboard for analytics</li>
              <li>Keep your vehicle information updated</li>
            </ul>

            <a href="${this.baseUrl}/owner/vehicles" class="button">Manage My Vehicles</a>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(owner.email, subject, html);
  }

  // Vehicle rejected notification
  async sendVehicleRejected(vehicle, owner, reason) {
    const subject = `Vehicle Requires Updates: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ffc107; color: #333; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .vehicle-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .reason { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .button { display: inline-block; background: #2c3e7d; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ Vehicle Needs Updates</h1>
          </div>
          <div class="content">
            <h2>Hello ${owner.first_name}!</h2>
            <p>Your vehicle submission requires some updates before it can be approved.</p>
            
            <div class="vehicle-details">
              <h3>🚗 Vehicle Details</h3>
              <p><strong>Vehicle:</strong> ${vehicle.make} ${vehicle.model} ${vehicle.year}</p>
              <p><strong>License Plate:</strong> ${vehicle.license_plate}</p>
            </div>

            <div class="reason">
              <h3>📝 Reason for Update Request:</h3>
              <p>${reason || 'Please ensure all required information is complete and accurate.'}</p>
            </div>

            <h3>🔧 Next Steps:</h3>
            <ul>
              <li>Review and update your vehicle information</li>
              <li>Ensure all required photos are uploaded</li>
              <li>Verify all details are accurate</li>
              <li>Resubmit for approval</li>
            </ul>

            <a href="${this.baseUrl}/owner/vehicles/${vehicle.id}/edit" class="button">Update Vehicle</a>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(owner.email, subject, html);
  }

  // 💬 FEEDBACK EMAILS

  // Feedback reminder email
  async sendFeedbackReminder(booking, customer, vehicle) {
    const subject = `Share Your Experience - Booking #BK-${booking.id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ff6b35; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .stars { text-align: center; font-size: 24px; margin: 20px 0; }
          .button { display: inline-block; background: #ff6b35; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⭐ How was your experience?</h1>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>We hope you had a great experience with your recent vehicle rental. We'd love to hear about it!</p>
            
            <div style="background: white; padding: 20px; border-radius: 5px; margin: 15px 0; text-align: center;">
              <h3>Your Recent Booking</h3>
              <p><strong>${vehicle.make} ${vehicle.model} ${vehicle.year}</strong></p>
              <p>Booking #BK-${booking.id}</p>
              <p>${new Date(booking.start_date).toLocaleDateString()} - ${new Date(booking.end_date).toLocaleDateString()}</p>
            </div>

            <div class="stars">
              ⭐ ⭐ ⭐ ⭐ ⭐
            </div>

            <p style="text-align: center;">Your feedback helps us improve our service and helps other customers make informed decisions.</p>

            <div style="text-align: center;">
              <a href="${this.baseUrl}/feedback/create?booking=${booking.id}" class="button">Leave a Review</a>
            </div>

            <h3>📝 What we'd like to know:</h3>
            <ul>
              <li>Overall rating of your experience</li>
              <li>Vehicle condition and cleanliness</li>
              <li>Quality of customer service</li>
              <li>Any additional comments</li>
            </ul>
          </div>
          <div class="footer">
            <p>Thank you for choosing AutoFleet Hub!</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // New feedback notification to owner
  async sendNewFeedbackNotification(feedback, vehicle, owner, customer) {
    const subject = `New Review for ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
    
    const starRating = '⭐'.repeat(feedback.rating) + '☆'.repeat(5 - feedback.rating);
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .review { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #28a745; }
          .rating { font-size: 20px; margin: 10px 0; color: #28a745; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🌟 New Review Received!</h1>
          </div>
          <div class="content">
            <h2>Hello ${owner.first_name}!</h2>
            <p>You've received a new review for your vehicle.</p>
            
            <div class="review">
              <h3>Vehicle: ${vehicle.make} ${vehicle.model} ${vehicle.year}</h3>
              <p><strong>Customer:</strong> ${customer.first_name} ${customer.last_name}</p>
              
              <div class="rating">
                <strong>Overall Rating:</strong> ${starRating} (${feedback.rating}/5)
              </div>
              
              ${feedback.service_rating ? `<p><strong>Service Rating:</strong> ${'⭐'.repeat(feedback.service_rating)} (${feedback.service_rating}/5)</p>` : ''}
              
              ${feedback.vehicle_condition_rating ? `<p><strong>Vehicle Condition:</strong> ${'⭐'.repeat(feedback.vehicle_condition_rating)} (${feedback.vehicle_condition_rating}/5)</p>` : ''}
              
              ${feedback.comment ? `
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0;">
                  <strong>Comment:</strong>
                  <p>${feedback.comment}</p>
                </div>
              ` : ''}
            </div>

            <p>Keep up the great work! Positive reviews help attract more customers to your vehicles.</p>
          </div>
          <div class="footer">
            <p>View all your reviews in your owner dashboard</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(owner.email, subject, html);
  }

  // Send low rating alert to admin
  async sendLowRatingAlert(adminEmail, feedback, vehicle, customer, owner, booking) {
    const subject = `⚠️ Low Rating Alert: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .alert-box { background: #f8d7da; border: 1px solid #f5c6cb; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .comment-box { background: #fff; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .actions { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ Low Rating Alert</h1>
          </div>
          <div class="content">
            <div class="alert-box">
              <h3>🚨 Action Required: Low Rating Received</h3>
              <p>A customer has left a low rating (${feedback.rating}⭐) that requires immediate attention.</p>
            </div>
            
            <h3>📋 Feedback Details</h3>
            <div class="detail-row">
              <span><strong>Rating:</strong></span>
              <span>${feedback.rating}/5 ⭐</span>
            </div>
            <div class="detail-row">
              <span><strong>Vehicle:</strong></span>
              <span>${vehicle.make} ${vehicle.model} ${vehicle.year} (${vehicle.license_plate})</span>
            </div>
            <div class="detail-row">
              <span><strong>Customer:</strong></span>
              <span>${customer.first_name} ${customer.last_name} (${customer.email})</span>
            </div>
            <div class="detail-row">
              <span><strong>Owner:</strong></span>
              <span>${owner.first_name} ${owner.last_name} (${owner.email})</span>
            </div>
            <div class="detail-row">
              <span><strong>Booking ID:</strong></span>
              <span>#${booking.id}</span>
            </div>
            <div class="detail-row">
              <span><strong>Rental Period:</strong></span>
              <span>${new Date(booking.start_date).toLocaleDateString()} - ${new Date(booking.end_date).toLocaleDateString()}</span>
            </div>
            
            ${feedback.comment ? `
              <div class="comment-box">
                <strong>Customer Comment:</strong><br>
                "${feedback.comment}"
              </div>
            ` : ''}
            
            <div class="actions">
              <h4>🎯 Recommended Actions:</h4>
              <ul>
                <li>Contact the customer to understand and resolve their concerns</li>
                <li>Review the vehicle owner's service quality</li>
                <li>Consider vehicle inspection if condition was rated poorly</li>
                <li>Follow up with appropriate support or training</li>
                <li>Document any corrective actions taken</li>
              </ul>
            </div>
          </div>
          <div class="footer">
            <p>AutoFleet Hub Admin Dashboard - Quality Management</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(adminEmail, subject, html);
  }

  // Send feedback update notification
  async sendFeedbackUpdateNotification(owner, feedback, vehicle, customer) {
    const subject = `Feedback Updated: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #17a2b8; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .update-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .rating-change { display: flex; justify-content: center; align-items: center; margin: 15px 0; font-size: 18px; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔄 Feedback Updated</h1>
          </div>
          <div class="content">
            <h2>Hello ${owner.first_name}!</h2>
            <p>A customer has updated their feedback for your vehicle.</p>
            
            <div class="update-box">
              <h3>🚗 Vehicle: ${vehicle.make} ${vehicle.model} ${vehicle.year}</h3>
              <p><strong>Customer:</strong> ${customer.first_name} ${customer.last_name}</p>
              
              <div class="rating-change">
                <span>${feedback.old_rating}⭐</span>
                <span style="margin: 0 15px;">→</span>
                <span>${feedback.new_rating}⭐</span>
              </div>
              
              ${feedback.comment ? `<p><strong>Updated Comment:</strong><br><em>"${feedback.comment}"</em></p>` : ''}
            </div>

            <p>Updated feedback helps maintain accurate ratings and reviews for your vehicle.</p>
          </div>
          <div class="footer">
            <p>Check your dashboard for the latest feedback analytics.</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(owner.email, subject, html);
  }

  // Send feedback deletion notification
  async sendFeedbackDeletionNotification(user, feedback, vehicle) {
    const subject = `Feedback Removed: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #6c757d; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .notice-box { background: #e2e3e5; border: 1px solid #d1d3d5; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🗑️ Feedback Removed</h1>
          </div>
          <div class="content">
            <h2>Hello ${user.first_name}!</h2>
            
            <div class="notice-box">
              <h3>📋 Feedback Removal Notice</h3>
              <p>A feedback entry has been removed by our admin team.</p>
              <p><strong>Vehicle:</strong> ${vehicle.make} ${vehicle.model} ${vehicle.year}</p>
              <p><strong>Original Rating:</strong> ${feedback.rating}⭐</p>
              <p><strong>Removed:</strong> ${new Date().toLocaleString()}</p>
            </div>

            <p>This action was taken as part of our content moderation policy. If you have questions about this removal, please contact our support team.</p>
          </div>
          <div class="footer">
            <p>If you have any questions, contact us at support@autofleet.com</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // Send thank you email to customer for feedback
  async sendFeedbackThankYou(customer, feedback, vehicle, booking) {
    const subject = `Thank You for Your Feedback - AutoFleet Hub`;
    
    const getRatingStars = (rating) => '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ffc107; color: #333; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .feedback-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .rating-display { font-size: 24px; text-align: center; margin: 15px 0; color: #28a745; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⭐ Thank You for Your Feedback!</h1>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>Thank you for taking the time to share your experience with us. Your feedback helps us improve our service and assists other customers in making informed decisions.</p>
            
            <div class="feedback-box">
              <h3>📝 Your Feedback Summary</h3>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year}</span>
              </div>
              <div class="detail-row">
                <span><strong>Booking ID:</strong></span>
                <span>#${booking.id}</span>
              </div>
              <div class="rating-display">
                <strong>Overall Rating:</strong><br>
                ${getRatingStars(feedback.rating)}
              </div>
              ${feedback.service_rating ? `<p><strong>Service Rating:</strong> ${getRatingStars(feedback.service_rating)}</p>` : ''}
              
              ${feedback.vehicle_condition_rating ? `<p><strong>Vehicle Condition:</strong> ${getRatingStars(feedback.vehicle_condition_rating)}</p>` : ''}
              
              ${feedback.comment ? `<p><strong>Your Comment:</strong><br><em>"${feedback.comment}"</em></p>` : ''}
            </div>

            <p>We're always working to provide the best car rental experience. If you have any additional concerns or suggestions, please don't hesitate to contact us.</p>
            
            <p><strong>Want to rent again?</strong> Browse our available vehicles and enjoy special discounts for returning customers!</p>
          </div>
          <div class="footer">
            <p>Thank you for choosing AutoFleet Hub!</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // Send feedback notification to vehicle owner
  async sendFeedbackNotificationToOwner(owner, feedback, vehicle, customer, booking) {
    const subject = `New Feedback Received: ${vehicle.make} ${vehicle.model} - AutoFleet Hub`;
    
    const getRatingStars = (rating) => '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
    const getRatingColor = (rating) => rating >= 4 ? '#28a745' : rating >= 3 ? '#ffc107' : '#dc3545';
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007bff; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .feedback-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border-left: 4px solid ${getRatingColor(feedback.rating)}; }
          .rating-display { font-size: 20px; margin: 10px 0; color: ${getRatingColor(feedback.rating)}; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .comment-box { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; font-style: italic; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📋 New Feedback Received</h1>
          </div>
          <div class="content">
            <h2>Hello ${owner.first_name}!</h2>
            <p>You've received new feedback for your vehicle. Here are the details:</p>
            
            <div class="feedback-box">
              <h3>🚗 Vehicle: ${vehicle.make} ${vehicle.model} ${vehicle.year}</h3>
              <div class="detail-row">
                <span><strong>Customer:</strong></span>
                <span>${customer.first_name} ${customer.last_name}</span>
              </div>
              <div class="detail-row">
                <span><strong>Booking ID:</strong></span>
                <span>#${booking.id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Rental Period:</strong></span>
                <span>${new Date(booking.start_date).toLocaleDateString()} - ${new Date(booking.end_date).toLocaleDateString()}</span>
              </div>
              
              <div class="rating-display">
                <strong>Overall Rating: ${getRatingStars(feedback.rating)}</strong>
              </div>
              
              ${feedback.service_rating ? `<p><strong>Service Rating:</strong> ${getRatingStars(feedback.service_rating)}</p>` : ''}
              
              ${feedback.vehicle_condition_rating ? `<p><strong>Vehicle Condition:</strong> ${getRatingStars(feedback.vehicle_condition_rating)}</p>` : ''}
              
              ${feedback.comment ? `
                <div class="comment-box">
                  <strong>Customer Comment:</strong><br>
                  "${feedback.comment}"
                </div>
              ` : ''}
            </div>

            ${feedback.rating >= 4 ? 
              '<p>🎉 <strong>Great news!</strong> This positive feedback will help attract more customers to your vehicle.</p>' :
              '<p>📈 <strong>Improvement Opportunity:</strong> Consider reaching out to understand how you can enhance the customer experience.</p>'
            }
            
            <p>Keep providing excellent service to maintain high ratings and attract more bookings!</p>
          </div>
          <div class="footer">
            <p>Check your owner dashboard for detailed analytics and insights.</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(owner.email, subject, html);
  }

  // Send urgent support alert
  async sendUrgentSupportAlert(adminEmail, ticket, customer) {
    const subject = `🚨 URGENT Support Ticket: ${ticket.ticket_id} - Immediate Attention Required`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .urgent-alert { background: #f8d7da; border: 2px solid #dc3545; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .ticket-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border-left: 5px solid #dc3545; }
          .customer-info { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .description-box { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .button { display: inline-block; background: #dc3545; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚨 URGENT SUPPORT ALERT</h1>
          </div>
          <div class="content">
            <div class="urgent-alert">
              <h2>⚠️ IMMEDIATE ATTENTION REQUIRED</h2>
              <p>An urgent support ticket has been submitted and requires immediate response!</p>
              <p><strong>Expected Response Time: 1-2 Hours Maximum</strong></p>
            </div>
            
            <div class="customer-info">
              <h3>👤 Customer Information</h3>
              <p><strong>Name:</strong> ${customer.first_name} ${customer.last_name}</p>
              <p><strong>Email:</strong> ${customer.email}</p>
              <p><strong>Contact Priority:</strong> High - May require phone follow-up</p>
            </div>
            
            <div class="ticket-box">
              <h3>🎫 Urgent Ticket Details</h3>
              <div class="detail-row">
                <span><strong>Ticket ID:</strong></span>
                <span><strong style="color: #dc3545;">${ticket.ticket_id}</strong></span>
              </div>
              <div class="detail-row">
                <span><strong>Subject:</strong></span>
                <span>${ticket.subject}</span>
              </div>
              <div class="detail-row">
                <span><strong>Category:</strong></span>
                <span>${ticket.category}</span>
              </div>
              <div class="detail-row">
                <span><strong>Priority:</strong></span>
                <span><strong style="color: #dc3545;">🚨 ${ticket.priority.toUpperCase()}</strong></span>
              </div>
              <div class="detail-row">
                <span><strong>Created:</strong></span>
                <span>${new Date(ticket.created_at).toLocaleString()}</span>
              </div>
              ${ticket.has_attachment ? '<div class="detail-row"><span><strong>Attachment:</strong></span><span>✅ File attached - Review immediately</span></div>' : ''}
              
              <div class="description-box">
                <strong>Urgent Issue Description:</strong><br>
                ${ticket.description}
              </div>
            </div>

            <div style="text-align: center; background: #dc3545; color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
              <h3>🚨 ACTION REQUIRED NOW</h3>
              <p>This ticket requires immediate attention. Please respond within 1-2 hours.</p>
              <a href="${this.baseUrl}/admin/support/tickets/${ticket.ticket_id}" class="button" style="background: white; color: #dc3545; border: 2px solid white;">RESPOND NOW</a>
            </div>
          </div>
          <div class="footer">
            <p style="color: #dc3545;"><strong>URGENT - AutoFleet Hub Support Alert System</strong></p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(adminEmail, subject, html);
  }

  // Send support response notification to customer
  async sendSupportResponseNotification(customer, ticket, responder) {
    const subject = `Support Update: ${ticket.ticket_id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .response-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .responder-info { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .message-box { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💬 Support Team Response</h1>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>Great news! Our support team has responded to your ticket.</p>
            
            <div class="response-box">
              <h3>Response from ${responder.first_name} ${responder.last_name} (${responder.role})</h3>
              <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
              <hr>
              <p>${response.message}</p>
            </div>

            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Current Status:</strong> ${ticket.status.charAt(0).toUpperCase() + ticket.status.slice(1)}</p>

            <p>You can reply to this ticket by logging into your account or replying to this email.</p>
          </div>
          <div class="footer">
            <p>Reference your ticket with ID: ${ticket.ticket_id}</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // Send customer response notification to admin
  async sendSupportCustomerResponse(adminEmail, ticket, customer) {
    const subject = `Customer Response: ${ticket.ticket_id} - ${customer.first_name} ${customer.last_name}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width:  600px; margin: 0 auto; padding: 20px; }
          .header { background: #ffc107; color: #333; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .response-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border-left: 5px solid #ffc107; }
          .customer-info { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .message-box { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .button { display: inline-block; background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💬 Customer Response</h1>
          </div>
          <div class="content">
            <h2>Customer Has Responded</h2>
            <p>A customer has added a new response to their support ticket.</p>
            
            <div class="customer-info">
              <h3>👤 Customer Information</h3>
              <p><strong>Name:</strong> ${customer.first_name} ${customer.last_name}</p>
              <p><strong>Email:</strong> ${customer.email}</p>
            </div>
            
            <div class="response-box">
              <h3>📩 Response Details</h3>
              <div class="detail-row">
                <span><strong>Ticket ID:</strong></span>
                <span>${ticket.ticket_id}</span>
              </div>
              <div class="detail-row">
                <span><strong>Subject:</strong></span>
                <span>${ticket.subject}</span>
              </div>
              <div class="detail-row">
                <span><strong>Category:</strong></span>
                <span>${ticket.category}</span>
              </div>
              <div class="detail-row">
                <span><strong>Response Time:</strong></span>
                <span>${new Date().toLocaleString()}</span>
              </div>
            </div>
            
            <div class="message-box">
              <strong>Customer Message:</strong><br><br>
              ${ticket.response_message}
            </div>

            <div style="text-align: center; margin: 20px 0;">
              <p><strong>Action Required:</strong> Please review and respond to the customer's message.</p>
              <a href="${this.baseUrl}/admin/support/tickets/${ticket.ticket_id}" class="button">View & Respond</a>
            </div>
          </div>
          <div class="footer">
            <p>AutoFleet Hub Support Management</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(adminEmail, subject, html);
  }

  // Send support status update notification
  async sendSupportStatusUpdate(customer, ticket, resolutionNotes) {
    const subject = `Ticket Status Update: ${ticket.ticket_id} - ${ticket.new_status.charAt(0).toUpperCase() + ticket.new_status.slice(1)}`;
    
    const getStatusColor = (status) => {
      switch(status) {
        case 'resolved': return '#28a745';
        case 'closed': return '#6c757d';
        case 'pending': return '#ffc107';
        case 'open': return '#007bff';
        default: return '#6c757d';
      }
    };

    const getStatusIcon = (status) => {
      switch(status) {
        case 'resolved': return '✅';
        case 'closed': return '🔒';
        case 'pending': return '⏳';
        case 'open': return '📝';
        default: return '📝';
      }
    };
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${getStatusColor(ticket.new_status)}; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .status-change { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; text-align: center; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${getStatusIcon(ticket.new_status)} Ticket Status Update</h1>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>The status of your support ticket has been updated.</p>
            
            <div class="status-change">
              <h3>${ticket.new_status.charAt(0).toUpperCase() + ticket.new_status.slice(1)}</h3>
              <p><strong>Previous Status:</strong> ${ticket.old_status.charAt(0).toUpperCase() + ticket.old_status.slice(1)}</p>
              <p><strong>New Status:</strong> ${ticket.new_status.charAt(0).toUpperCase() + ticket.new_status.slice(1)}</p>
            </div>

            ${ticket.new_status === 'resolved' ? `
              <p>Great news! Your issue has been resolved. Our team has addressed your concern and the ticket is now marked as resolved.</p>
            ` : ticket.new_status === 'closed' ? `
              <p>Your ticket has been closed. This means the matter has been fully resolved and no further action is required.</p>
            ` : `
              <p>Our support team continues to work on your ticket. You'll receive updates as we make progress on your request.</p>
            `}
            
            <p><strong>Questions?</strong> Contact our support team at support@autofleet.com</p>
          </div>
          <div class="footer">
            <p>AutoFleet Hub Support Team</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // Send dispute confirmation to customer
  async sendDisputeConfirmation(customer, dispute, booking, vehicle) {
    const subject = `Dispute Submitted: ${dispute.dispute_id} - AutoFleet Hub`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .dispute-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚖️ Dispute Submitted</h1>
          </div>
          <div class="content">
            <h2>Hello ${customer.first_name}!</h2>
            <p>We've received your dispute and our team will review it carefully. We're committed to resolving this matter fairly and promptly.</p>
            
            <div class="dispute-details">
              <h3>📋 Dispute Details</h3>
              <div class="detail-row">
                <span><strong>Dispute ID:</strong></span>
                <span><strong>${dispute.dispute_id}</strong></span>
              </div>
              <div class="detail-row">
                <span><strong>Booking:</strong></span>
                <span>${dispute.booking_reference}</span>
              </div>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year}</span>
              </div>
              <div class="detail-row">
                <span><strong>Reason:</strong></span>
                <span>${dispute.reason}</span>
              </div>
              <div class="detail-row">
                <span><strong>Priority:</strong></span>
                <span>${dispute.priority.charAt(0).toUpperCase() + dispute.priority.slice(1)}</span>
              </div>
              <div class="detail-row">
                <span><strong>Status:</strong></span>
                <span>${dispute.status.charAt(0).toUpperCase() + dispute.status.slice(1)}</span>
              </div>
            </div>

            <div style="background: white; padding: 20px; border-radius: 5px;">
              <h3>📝 Your Message:</h3>
              <p style="background: #f8f9fa; padding: 15px; border-radius: 5px;">${dispute.description}</p>
            </div>

            <h3>⏱️ What happens next?</h3>
            <ul>
              <li>Our team will review your dispute within 24-48 hours</li>
              <li>We may contact you for additional information</li>
              <li>You'll receive updates via email</li>
              <li>All parties will be notified of the resolution</li>
            </ul>
          </div>
          <div class="footer">
            <p>Reference your dispute with ID: DSP-${dispute.id}</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(customer.email, subject, html);
  }

  // Send dispute notification to vehicle owner
  async sendDisputeNotificationToOwner(owner, dispute, booking, vehicle, customer) {
    const subject = `Dispute Notice: ${dispute.dispute_id} - ${vehicle.make} ${vehicle.model}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ffc107; color: #333; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .dispute-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border-left: 5px solid #ffc107; }
          .customer-info { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .description-box { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .next-steps { background: #d1ecf1; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚖️ Dispute Notice</h1>
          </div>
          <div class="content">
            <h2>Hello ${owner.first_name}!</h2>
            <p>A customer has submitted a dispute regarding a booking for your vehicle. Our mediation team will review this matter fairly.</p>
            
            <div class="customer-info">
              <h3>👤 Customer Information</h3>
              <p><strong>Name:</strong> ${customer.first_name} ${customer.last_name}</p>
              <p><strong>Email:</strong> ${customer.email}</p>
            </div>
            
            <div class="dispute-box">
              <h3>📋 Dispute Details</h3>
              <div class="detail-row">
                <span><strong>Dispute ID:</strong></span>
                <span><strong>${dispute.dispute_id}</strong></span>
              </div>
              <div class="detail-row">
                <span><strong>Booking:</strong></span>
                <span>${dispute.booking_reference}</span>
              </div>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year} (${vehicle.license_plate})</span>
              </div>
              <div class="detail-row">
                <span><strong>Booking Amount:</strong></span>
                <span>$${booking.total_amount}</span>
              </div>
              <div class="detail-row">
                <span><strong>Reason:</strong></span>
                <span>${dispute.reason}</span>
              </div>
              <div class="detail-row">
                <span><strong>Priority:</strong></span>
                <span>${dispute.priority.charAt(0).toUpperCase() + dispute.priority.slice(1)}</span>
              </div>
              <div class="detail-row">
                <span><strong>Submitted:</strong></span>
                <span>${new Date(dispute.created_at).toLocaleString()}</span>
              </div>
              
              <div class="description-box">
                <strong>Customer's Dispute Description:</strong><br>
                ${dispute.description}
              </div>
            </div>

            <div class="next-steps">
              <h3>📞 Next Steps</h3>
              <ul>
                <li>Our mediation team will review this dispute</li>
                <li>You may be contacted for your perspective</li>
                <li>Please gather any relevant documentation</li>
                <li>Mediate between customer and owner</li>
                <li>Make fair resolution decision</li>
                <li>Update dispute status and notify parties</li>
              </ul>
            </div>

            <h3>📝 Important Information</h3>
            <p>This dispute will be handled impartially by our mediation team. Please:</p>
            <ul>
              <li>Respond promptly to any requests for information</li>
              <li>Provide accurate and complete details</li>
              <li>Remain professional in all communications</li>
              <li>Allow our team to mediate the resolution</li>
            </ul>
            
            <p><strong>Reference Number:</strong> ${dispute.dispute_id}</p>
          </div>
          <div class="footer">
            <p>AutoFleet Hub Dispute Resolution Team</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(owner.email, subject, html);
  }

  // Send dispute alert to admin
  async sendDisputeAlert(adminEmail, dispute, booking, vehicle, customer, owner) {
    const subject = `🚨 New Dispute Alert: ${dispute.dispute_id} - Requires Mediation`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .alert-box { background: #f8d7da; border: 1px solid #f5c6cb; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .parties-info { display: flex; justify-content: space-between; margin: 15px 0; }
          .party-box { background: white; padding: 15px; border-radius: 5px; width: 45%; }
          .dispute-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .description-box { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; }
          .actions { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .button { display: inline-block; background: #dc3545; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 5px; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚨 New Dispute Alert</h1>
          </div>
          <div class="content">
            <div class="alert-box">
              <h3>⚖️ Dispute Mediation Required</h3>
              <p>A new dispute has been submitted and requires immediate attention from the mediation team.</p>
            </div>
            
            <div class="parties-info">
              <div class="party-box">
                <h4>👤 Customer</h4>
                <p><strong>${customer.first_name} ${customer.last_name}</strong></p>
                <p>${customer.email}</p>
              </div>
              <div class="party-box">
                <h4>🚗 Owner</h4>
                <p><strong>${owner.first_name} ${owner.last_name}</strong></p>
                <p>${owner.email}</p>
              </div>
            </div>
            
            <div class="dispute-box">
              <h3>📋 Dispute Information</h3>
              <div class="detail-row">
                <span><strong>Dispute ID:</strong></span>
                <span><strong>${dispute.dispute_id}</strong></span>
              </div>
              <div class="detail-row">
                <span><strong>Booking:</strong></span>
                <span>${dispute.booking_reference}</span>
              </div>
              <div class="detail-row">
                <span><strong>Vehicle:</strong></span>
                <span>${vehicle.make} ${vehicle.model} ${vehicle.year} (${vehicle.license_plate})</span>
              </div>
              <div class="detail-row">
                <span><strong>Booking Amount:</strong></span>
                <span>$${booking.total_amount}</span>
              </div>
              <div class="detail-row">
                <span><strong>Reason:</strong></span>
                <span>${dispute.reason}</span>
              </div>
              <div class="detail-row">
                <span><strong>Priority:</strong></span>
                <span>${dispute.priority.charAt(0).toUpperCase() + dispute.priority.slice(1)}</span>
              </div>
              <div class="detail-row">
                <span><strong>Submitted:</strong></span>
                <span>${new Date(dispute.created_at).toLocaleString()}</span>
              </div>
              
              <div class="description-box">
                <strong>Customer's Dispute Description:</strong><br>
                ${dispute.description}
              </div>
            </div>

            <div class="actions">
              <h4>🎯 Required Actions</h4>
              <ul>
                <li>Review dispute details and booking history</li>
                <li>Contact both parties for their perspectives</li>
                <li>Gather relevant evidence and documentation</li>
                <li>Mediate between customer and owner</li>
                <li>Make fair resolution decision</li>
                <li>Update dispute status and notify parties</li>
              </ul>
              
              <div style="text-align: center;">
                <a href="${this.baseUrl}/admin/support/disputes/${dispute.dispute_id}" class="button">Review Dispute</a>
                <a href="${this.baseUrl}/admin/support" class="button">Support Dashboard</a>
              </div>
            </div>
          </div>
          <div class="footer">
            <p>AutoFleet Hub Dispute Resolution System</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(adminEmail, subject, html);
  }

  // Send dispute status update
  async sendDisputeStatusUpdate(user, dispute, booking, vehicle, resolutionNotes) {
    const subject = `Dispute Update: ${dispute.dispute_id} - ${dispute.new_status.charAt(0).toUpperCase() + dispute.new_status.slice(1)}`;
    
    const getStatusColor = (status) => {
      switch(status) {
        case 'resolved': return '#28a745';
        case 'closed': return '#6c757d';
        case 'in_progress': return '#ffc107';
        case 'open': return '#dc3545';
        default: return '#6c757d';
      }
    };

    const getStatusIcon = (status) => {
      switch(status) {
        case 'resolved': return '✅';
        case 'closed': return '🔒';
        case 'in_progress': return '⏳';
        case 'open': return '📝';
        default: return '📝';
      }
    };
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${getStatusColor(dispute.new_status)}; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .status-change { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; text-align: center; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${getStatusIcon(dispute.new_status)} Dispute Status Update</h1>
          </div>
          <div class="content">
            <h2>Hello ${user.first_name}!</h2>
            <p>The status of your dispute has been updated by our mediation team.</p>
            
            <div class="status-change">
              <h3>${dispute.new_status.charAt(0).toUpperCase() + dispute.new_status.slice(1)}</h3>
              <p><strong>Previous Status:</strong> ${dispute.old_status.charAt(0).toUpperCase() + dispute.old_status.slice(1)}</p>
              <p><strong>New Status:</strong> ${dispute.new_status.charAt(0).toUpperCase() + dispute.new_status.slice(1)}</p>
            </div>

            ${dispute.new_status === 'resolved' ? `
              <h3>🎉 Dispute Resolved</h3>
              <p>Great news! Your dispute has been resolved by our mediation team. We've reviewed all the information provided and reached a fair resolution.</p>
              <p>If you have any questions about this resolution, please contact our support team within 7 days.</p>
            ` : dispute.new_status === 'closed' ? `
              <h3>🔒 Dispute Closed</h3>
              <p>Your dispute has been closed. This means the matter has been fully resolved and no further action is required.</p>
              <p>If you believe this dispute was closed in error or have new questions, please contact our support team.</p>
            ` : dispute.new_status === 'in_progress' ? `
              <h3>⏳ Dispute Under Review</h3>
              <p>Our mediation team is actively reviewing your dispute. We're gathering information from all parties to ensure a fair resolution.</p>
              <p>You'll receive another update once we've completed our review.</p>
            ` : ''}
            
            <p><strong>Questions?</strong> Contact our support team at disputes@autofleet.com</p>
          </div>
          <div class="footer">
            <p>AutoFleet Hub Dispute Resolution Team</p>
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(user.email, subject, html);
  }

  // Admin booking notification email
  async sendNewBookingAdminNotification(adminEmail, booking, customer, vehicle) {
    const subject = `New Booking Created - AutoFleet Hub`;
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2c3e7d; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .booking-details { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>New Booking Created</h1>
          </div>
          <div class="content">
            <h2>Booking #BK-${booking.id}</h2>
            <div class="booking-details">
              <h3>Booking Details</h3>
              <ul>
                <li><strong>Customer:</strong> ${customer.first_name} ${customer.last_name} (${customer.email})</li>
                <li><strong>Vehicle:</strong> ${vehicle.make} ${vehicle.model} (${vehicle.license_plate})</li>
                <li><strong>Start Date:</strong> ${new Date(booking.start_date).toLocaleDateString()}</li>
                <li><strong>End Date:</strong> ${new Date(booking.end_date).toLocaleDateString()}</li>
                <li><strong>Duration:</strong> ${booking.duration_days || 'N/A'} days</li>
                <li><strong>Total Amount:</strong> $${booking.total_amount}</li>
                <li><strong>Payment Status:</strong> ${booking.payment_status}</li>
                <li><strong>Pickup Location:</strong> ${booking.pickup_location}</li>
              </ul>
            </div>
            <p>Please review and manage this booking in the admin dashboard.</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} AutoFleet Hub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
    return await this.sendEmail(adminEmail, subject, html);
  }
}

module.exports = EmailService;