module.exports = (req, res) => {
    res.status(200).json({
        status: 'diagnostic-ok',
        timestamp: new Date().toISOString(),
        env_keys: Object.keys(process.env).filter(k => k.includes('MONGODB') || k.includes('SESSION'))
    });
};
