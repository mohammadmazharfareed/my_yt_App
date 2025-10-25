const axios = require('axios');

async function testDownload() {
    try {
        console.log('Testing download functionality...');

        // Test with a short video (Rick Roll)
        const videoId = 'dQw4w9WgXcQ';
        const format = 'mp4';
        const quality = 'lowest';

        console.log(`Testing download of video ${videoId} in ${format} format...`);

        // Test the download-file endpoint
        const response = await axios.get(`http://localhost:5000/download-file`, {
            params: {
                videoId: videoId,
                format: format,
                quality: quality
            },
            responseType: 'stream',
            timeout: 30000 // 30 second timeout
        });

        console.log('✅ Download started successfully!');
        console.log('Response headers:', response.headers);

        // Count bytes received
        let bytesReceived = 0;
        response.data.on('data', (chunk) => {
            bytesReceived += chunk.length;
            if (bytesReceived % (1024 * 1024) === 0) { // Log every MB
                console.log(`Received: ${(bytesReceived / 1024 / 1024).toFixed(2)} MB`);
            }
        });

        response.data.on('end', () => {
            console.log(`✅ Download completed! Total bytes: ${bytesReceived}`);
        });

        response.data.on('error', (error) => {
            console.error('❌ Download error:', error.message);
        });

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
    }
}

// Run the test
testDownload(); 