import * as http from 'http';

console.log("Creating dummy PCM audio data...");
// Create 1 second of dummy PCM data (16kHz, 16-bit = 32000 bytes)
const dummyPcmData = Buffer.alloc(32000);
for (let i = 0; i < dummyPcmData.length; i++) {
  dummyPcmData[i] = Math.floor(Math.random() * 256);
}

const reqOptions = {
  hostname: 'localhost',
  port: process.env.PORT ? parseInt(process.env.PORT) : 28089,
  path: '/api/audio?sample_rate=16000&uid=test_user_123',
  method: 'POST',
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': dummyPcmData.length
  }
};

console.log("Sending POST request to http://localhost:8080/api/audio...");

const req = http.request(reqOptions, (res) => {
  console.log(`Response status: ${res.statusCode}`);
  let responseData = '';
  
  res.on('data', (chunk) => {
    responseData += chunk;
  });
  
  res.on('end', () => {
    console.log('Response body:', responseData);
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
  console.error('Make sure your server is running (npm run dev)');
  process.exit(1);
});

// Write data to request body
req.write(dummyPcmData);
req.end();
