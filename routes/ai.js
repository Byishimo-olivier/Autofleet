const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { authenticateToken } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

const AUTOFLEET_CONTEXT = `
You are AutoFleet's helpful AI assistant. AutoFleet is a car rental platform.

IMPORTANT NAVIGATION RULES:
- When users ask about browsing/viewing vehicles, respond with: {"action": "navigate", "url": "/vehicle"}
- When users ask about bookings/reservations, respond with: {"action": "navigate", "url": "/customer/my-bookings"}
- When users ask about dashboard/account, respond with: {"action": "navigate", "url": "/dashboard"}
- When users ask about support/help, respond with: {"action": "navigate", "url": "/customer/support"}
- When users want to list their vehicle, respond with: {"action": "navigate", "url": "/Vehicles"}
- When users ask about admin features, respond with: {"action": "navigate", "url": "/admin/reports"}

AUTOFLEET INFORMATION:
- Vehicle types: Economy ($25-35/day), Sedans ($35-50/day), SUVs ($45-65/day), Trucks ($55-75/day), Vans ($60-80/day)
- Locations: Main Office (123 AutoFleet St.), Airport (Terminal 2), Downtown (456 City Center)
- Requirements: Driver's license (1+ year), Credit card, Government ID
- Cancellation: 24+ hours (full refund), 2-24 hours (50% refund), <2 hours (no refund)
- Payment: Credit/debit cards, PayPal, bank transfer
- Home delivery available for $15 extra
`;

// Chat route
router.post('/chat', authenticateToken, async (req, res) => {
    try {
        const { message, history } = req.body;

        if (!message) {
            return errorResponse(res, 'Message is required', 400);
        }

        console.log(`[AI] Chat request received. History length: ${history?.length || 0}`);

        // Gemini Chat requires alternating roles (user, model, user, model...)
        // If the frontend sends history that includes the current message as the last 'user' entry,
        // we must remove it before calling sendMessage, or it will throw a role-alternation error.
        let processedHistory = history || [];
        if (processedHistory.length > 0 && processedHistory[processedHistory.length - 1].role === 'user') {
            console.log('[AI] Popping last user message from history to allow sendMessage');
            processedHistory = processedHistory.slice(0, -1);
        }

        const chat = model.startChat({
            history: processedHistory,
            generationConfig: {
                maxOutputTokens: 500,
                temperature: 0.7,
            },
        });

        const fullPrompt = `${AUTOFLEET_CONTEXT}\n\nUser Message: ${message}`;

        console.log('[AI] Sending message to Gemini...');
        const result = await chat.sendMessage(fullPrompt);
        const response = await result.response;
        const text = response.text();
        console.log('[AI] Response received from Gemini');

        // Extract navigation if present
        const navigationMatch = text.match(/{"action":\s*"navigate",\s*"url":\s*"([^"]+)"}/);
        let navigationUrl = undefined;
        let cleanText = text;

        if (navigationMatch) {
            navigationUrl = navigationMatch[1];
            cleanText = text.replace(navigationMatch[0], '').trim();
        }

        successResponse(res, {
            message: cleanText,
            navigationUrl,
            type: navigationUrl ? 'navigation' : 'text'
        }, 'AI response generated');

    } catch (err) {
        console.error('❌ AI Chat Error:', err.message);
        if (err.stack) console.error(err.stack);

        // Check for specific Gemini errors
        if (err.message?.includes('API key')) {
            return errorResponse(res, 'AI configuration error: Invalid API Key', 500);
        }

        errorResponse(res, 'AI service currently unavailable', 500);
    }
});


// Insights route for Dashboard
router.post('/insights', authenticateToken, async (req, res) => {
    try {
        const { data } = req.body; // Expecting dashboard stats

        const prompt = `
        Analyze the following AutoFleet dashboard data and provide 3-4 concise, actionable insights for the fleet owner.
        Data: ${JSON.stringify(data)}
        
        Focus on:
        - Revenue trends
        - Vehicle utilization
        - Popular car types
        - Areas for improvement
        
        Format as a JSON array of strings.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // Clean and parse JSON from response if necessary
        const jsonMatch = text.match(/\[.*\]/s);
        const insights = jsonMatch ? JSON.parse(jsonMatch[0]) : [text];

        successResponse(res, insights, 'Insights generated');
    } catch (err) {
        console.error('AI Insights Error:', err);
        errorResponse(res, 'Failed to generate insights', 500);
    }
});

// Vehicle description generator
router.post('/generate-description', authenticateToken, async (req, res) => {
    try {
        const { make, model: vModel, year, features } = req.body;

        const prompt = `
        Generate a compelling, professional, and SEO-friendly rental description for a car on AutoFleet.
        Details:
        - Vehicle: ${year} ${make} ${vModel}
        - Features: ${features || 'Standard amenities'}
        
        The description should highlight comfort, reliability, and value. Keep it around 150-200 words.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        successResponse(res, { description: response.text() }, 'Description generated');
    } catch (err) {
        console.error('AI Description Error:', err);
        errorResponse(res, 'Failed to generate description', 500);
    }
});

module.exports = router;
