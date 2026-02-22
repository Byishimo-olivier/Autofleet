const fs = require('fs');
const path = require('path');

// Create a dummy image
const dummyPath = path.join(__dirname, 'dummy.jpg');
fs.writeFileSync(dummyPath, 'dummy content');

const FormData = require('form-data');
const axios = require('axios'); // need something to make multipart requests

async function run() {
    try {
        const form = new FormData();
        form.append('images', fs.createReadStream(dummyPath));

        const response = await axios.post('http://localhost:5000/api/vehicle-images/test', {}, {
            headers: { ...form.getHeaders() }
        });
        console.log('Test route works:', response.data);
    } catch (err) {
        console.error('Test route failed:', err.message);
    }
}

run();
