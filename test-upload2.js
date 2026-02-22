require('dotenv').config();
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const auth = require('./middleware/auth');

const dummyPath = path.join(__dirname, 'dummy.jpg');
fs.writeFileSync(dummyPath, 'dummy image content');

async function run() {
    try {
        const token = auth.generateToken({ id: 1, email: 'test@autofleet.com', role: 'admin' });

        const form = new FormData();
        form.append('images', fs.createReadStream(dummyPath));

        const response = await axios.post('http://localhost:5000/api/vehicle-images/upload/1', form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${token}`
            }
        });
        console.log('Upload successful:', response.data);
    } catch (err) {
        if (err.response) {
            console.error('Upload failed with status', err.response.status, ':', JSON.stringify(err.response.data));
        } else {
            console.error('Upload failed:', err.message);
        }
    }
}

run();
