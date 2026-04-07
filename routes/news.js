const express = require("express");
const router = express.Router();

router.get("/news", async (req, res) => {
  try {
    const url = `https://gnews.io/api/v4/top-headlines?category=technology&lang=en&country=in&max=10&apikey=${process.env.GNEWS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;