const express = require('express');
const router = express.Router();
const axios = require('axios');

// The insecure Python service URL
const PYTHON_SERVICE_URL = 'http://3.82.109.221:8000';

// Proxy Route: Trigger Summary (POST)
router.post('/generate', async (req, res) => {
  try {
    const { meeting_id } = req.body;
    
    // Server-to-Server call (HTTP is allowed here)
    const response = await axios.post(`${PYTHON_SERVICE_URL}/summarize/meeting?meeting_id=${meeting_id}`, {
        meeting_id
    });
    
    res.json(response.data);
  } catch (error) {
    console.error("Proxy POST Error:", error.message);
    // Pass the status code from the python service, or default to 500
    res.status(error.response?.status || 500).json(error.response?.data || { message: "Proxy Error" });
  }
});

// Proxy Route: Get Summary (GET)
router.get('/:meeting_id', async (req, res) => {
  try {
    const { meeting_id } = req.params;
    
    // Server-to-Server call
    const response = await axios.get(`${PYTHON_SERVICE_URL}/summary/${meeting_id}`);
    
    res.json(response.data);
  } catch (error) {
    // If the python service returns 404, we return 404 to frontend
    res.status(error.response?.status || 500).json(error.response?.data || { message: "Proxy Fetch Error" });
  }
});

module.exports = router;